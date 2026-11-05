// Package logship はログを通番つきの断片にして Hub へ逐次送る。
//
//   - 断片は送る前にディスクへ書き、Hub が受け取りを確かめる（contiguous_through）まで消さない。
//     送れない間は手元に保持し、Runner が落ちても次の起動で再送する（Recover）。
//   - Hub が欠けていると返した通番（missing）は再送する。重複は Hub が捨てる（冪等）。
package logship

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/loverhetoric-gif/Upbeater/runner/internal/hub"
	"github.com/loverhetoric-gif/Upbeater/runner/internal/mask"
)

const (
	cutSize   = 32 << 10  // これだけ溜まったら断片にする
	chunkMax  = 64 << 10  // 1 断片の最大
	batchMax  = 256 << 10 // 1 回に送る最大
	minPeriod = time.Second
	maxPeriod = 30 * time.Second
)

// Meta は保持中のログの付帯情報（ジョブトークンを含むため権限 600）。
type Meta struct {
	JobID      string      `json:"job_id"`
	Attempt    int         `json:"attempt"`
	JobToken   string      `json:"job_token"`
	LastSeq    int         `json:"last_seq"`
	Completion *Completion `json:"completion,omitempty"`
	CreatedAt  int64       `json:"created_at"`
}

// Completion は、まだ Hub に届いていない終了の報告。
type Completion struct {
	Conclusion string `json:"conclusion"`
	Reason     string `json:"reason,omitempty"`
}

// Shipper は 1 つのジョブのログを送る。
type Shipper struct {
	c    *hub.Client
	dir  string
	meta Meta

	mu        sync.Mutex
	buf       []byte
	pending   map[int]string // まだ Hub の連続した受け取りに含まれていない断片
	delivered map[int]bool   // Hub には届いたが、手前に欠けがある断片
	acked     int
	stale     bool
	wake      chan struct{}
}

// New は保持用のディレクトリ（spoolRoot/<ジョブ>-<回>）を作って Shipper を返す。
func New(c *hub.Client, spoolRoot, jobID string, attempt int, jobToken string) (*Shipper, error) {
	dir := filepath.Join(spoolRoot, fmt.Sprintf("%s-%d", jobID, attempt))
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	s := &Shipper{c: c, dir: dir, meta: Meta{JobID: jobID, Attempt: attempt, JobToken: jobToken, CreatedAt: time.Now().Unix()}, pending: map[int]string{}, delivered: map[int]bool{}, wake: make(chan struct{}, 1)}
	return s, s.saveMeta()
}

func (s *Shipper) saveMeta() error {
	b, _ := json.Marshal(s.meta)
	tmp := filepath.Join(s.dir, ".meta.tmp")
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(s.dir, "meta.json"))
}

// Write はログを足す（伏せた後の文字列）。
func (s *Shipper) Write(text string) {
	s.mu.Lock()
	s.buf = append(s.buf, text...)
	big := len(s.buf) >= cutSize
	if big {
		s.cutLocked(false)
	}
	s.mu.Unlock()
	if big {
		s.poke()
	}
}

func (s *Shipper) poke() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

// cutLocked は溜まった分を断片にしてディスクへ書く。all なら書きかけの文字も含めて全部。
func (s *Shipper) cutLocked(all bool) {
	n := len(s.buf)
	if !all {
		n = mask.CompletePrefix(s.buf)
	}
	data := s.buf[:n]
	for len(data) > 0 {
		k := len(data)
		if k > chunkMax {
			k = chunkMax
			for k > 0 && (data[k]&0xC0) == 0x80 { // 文字の途中で切らない
				k--
			}
		}
		s.meta.LastSeq++
		seq := s.meta.LastSeq
		text := string(data[:k])
		s.pending[seq] = text
		if err := os.WriteFile(s.chunkPath(seq), []byte(text), 0o600); err != nil {
			// ディスクに書けなくても、メモリ上では保持して送る
			fmt.Fprintf(os.Stderr, "ログを手元に保存できません：%v\n", err)
		}
		data = data[k:]
	}
	s.buf = append([]byte(nil), s.buf[n:]...)
	_ = s.saveMeta()
}

func (s *Shipper) chunkPath(seq int) string {
	return filepath.Join(s.dir, fmt.Sprintf("%08d.log", seq))
}

// Stale は、このジョブが別の実行に移った（Hub がログを拒否した）か。
func (s *Shipper) Stale() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.stale
}

// Run は ctx が終わるまで定期的に送る。送れない間は間隔を広げる。
func (s *Shipper) Run(ctx context.Context) {
	period := minPeriod
	t := time.NewTimer(period)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		case <-s.wake:
			if !t.Stop() {
				select {
				case <-t.C:
				default:
				}
			}
		}
		s.mu.Lock()
		s.cutLocked(false)
		s.mu.Unlock()
		if err := s.sendOnce(ctx); err != nil && !errors.Is(err, context.Canceled) {
			period = min(period*2, maxPeriod)
		} else {
			period = minPeriod
		}
		if s.Stale() {
			return
		}
		t.Reset(period)
	}
}

// sendOnce は届いていない断片を 1 回分送る。
func (s *Shipper) sendOnce(ctx context.Context) error {
	s.mu.Lock()
	var seqs []int
	for seq := range s.pending {
		if !s.delivered[seq] {
			seqs = append(seqs, seq)
		}
	}
	sort.Ints(seqs)
	var chunks []hub.Chunk
	size := 0
	for _, seq := range seqs {
		t := s.pending[seq]
		if size > 0 && size+len(t) > batchMax {
			break
		}
		chunks = append(chunks, hub.Chunk{Seq: seq, Text: t})
		size += len(t)
	}
	last := s.meta.LastSeq
	token := s.meta.JobToken
	done := len(chunks) == 0 && s.acked >= last
	s.mu.Unlock()
	if done {
		return nil
	}
	r, err := s.c.Logs(ctx, s.meta.JobID, token, chunks, last)
	if err != nil {
		if hub.IsStale(err) || isNotFound(err) {
			s.mu.Lock()
			s.stale = true
			s.mu.Unlock()
		}
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	missing := map[int]bool{}
	for _, m := range r.Missing {
		missing[m] = true
	}
	for _, ch := range chunks {
		if !missing[ch.Seq] {
			s.delivered[ch.Seq] = true
		}
	}
	for m := range missing {
		delete(s.delivered, m)
	}
	s.ackLocked(r.ContiguousThrough)
	return nil
}

func isNotFound(err error) bool {
	var he *hub.Error
	return errors.As(err, &he) && he.Status == 404
}

// ackLocked は Hub が連続して受け取った通番までを手元から消す。
func (s *Shipper) ackLocked(through int) {
	if through <= s.acked {
		return
	}
	for seq := range s.pending {
		if seq <= through {
			delete(s.pending, seq)
			delete(s.delivered, seq)
			_ = os.Remove(s.chunkPath(seq))
		}
	}
	s.acked = through
}

// Resend は Hub が欠けていると返した通番を、次の送信で送り直す。
func (s *Shipper) Resend(missing []int) {
	s.mu.Lock()
	for _, m := range missing {
		delete(s.delivered, m)
	}
	s.mu.Unlock()
}

// Flush は溜まった分をすべて断片にし、届くまで（または ctx の終わりまで）送る。最後の通番を返す。
func (s *Shipper) Flush(ctx context.Context) int {
	s.mu.Lock()
	s.cutLocked(true)
	last := s.meta.LastSeq
	s.mu.Unlock()
	backoff := 100 * time.Millisecond
	for !s.Stale() && !s.Drained() {
		if err := s.sendOnce(ctx); err == nil && s.Drained() {
			break
		}
		// 送れなかった、または手前の欠けを Hub が確かめるのを待つ
		select {
		case <-ctx.Done():
			return last
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, 5*time.Second)
	}
	return last
}

// Drained は、すべての断片が Hub に届いたか。
func (s *Shipper) Drained() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.pending) == 0 && len(s.buf) == 0
}

// SetCompletion は、終了の報告が届かなかった時に後で送るため記録する。
func (s *Shipper) SetCompletion(c *Completion) {
	s.mu.Lock()
	s.meta.Completion = c
	_ = s.saveMeta()
	s.mu.Unlock()
}

// LastSeq は最後の通番。
func (s *Shipper) LastSeq() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.meta.LastSeq
}

// Finish は、すべて届いた（または不要になった）なら手元の保持を消す。保持を続けるなら false。
func (s *Shipper) Finish() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stale || (len(s.pending) == 0 && len(s.buf) == 0 && s.meta.Completion == nil) {
		_ = os.RemoveAll(s.dir)
		return true
	}
	return false
}

// Discard は保持を捨てる（ジョブが別の実行に移り、Hub が受け付けなくなった時）。
func (s *Shipper) Discard() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.stale = true
	_ = os.RemoveAll(s.dir)
}

// Recover は、前の実行で送りきれなかったログと終了の報告を送る。届いたもの・不要になったものは消す。
// 戻り値は、まだ保持しているジョブの数。
func Recover(ctx context.Context, c *hub.Client, spoolRoot string) int {
	entries, err := os.ReadDir(spoolRoot)
	if err != nil {
		return 0
	}
	left := 0
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		dir := filepath.Join(spoolRoot, e.Name())
		s, err := load(c, dir)
		if err != nil {
			// 付帯情報が壊れていて送り先が分からない
			_ = os.RemoveAll(dir)
			continue
		}
		// 7 日を超えたものは Hub も受け付けないため捨てる
		if time.Since(time.Unix(s.meta.CreatedAt, 0)) > 7*24*time.Hour {
			_ = os.RemoveAll(dir)
			continue
		}
		fctx, cancel := context.WithTimeout(ctx, 30*time.Second)
		s.Flush(fctx)
		if !s.Stale() && s.Drained() && s.meta.Completion != nil {
			r, err := c.Complete(fctx, s.meta.JobID, s.meta.JobToken, s.meta.Completion.Conclusion, s.meta.Completion.Reason, s.meta.LastSeq)
			switch {
			case err == nil:
				s.SetCompletion(nil)
				if len(r.Missing) > 0 {
					s.Resend(r.Missing)
				}
			case hub.IsStale(err) || isNotFound(err):
				s.mu.Lock()
				s.stale = true
				s.mu.Unlock()
			}
		}
		cancel()
		if !s.Finish() {
			left++
		}
	}
	return left
}

func load(c *hub.Client, dir string) (*Shipper, error) {
	b, err := os.ReadFile(filepath.Join(dir, "meta.json"))
	if err != nil {
		return nil, err
	}
	s := &Shipper{c: c, dir: dir, pending: map[int]string{}, delivered: map[int]bool{}, wake: make(chan struct{}, 1)}
	if err := json.Unmarshal(b, &s.meta); err != nil || s.meta.JobID == "" {
		return nil, errors.New("付帯情報が壊れています")
	}
	files, _ := os.ReadDir(dir)
	for _, f := range files {
		name := f.Name()
		if !strings.HasSuffix(name, ".log") {
			continue
		}
		seq, err := strconv.Atoi(strings.TrimSuffix(name, ".log"))
		if err != nil {
			continue
		}
		text, err := os.ReadFile(filepath.Join(dir, name))
		if err == nil {
			s.pending[seq] = string(text)
		}
	}
	return s, nil
}
