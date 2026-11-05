// Package fakehub はテスト用の模擬 Hub。Hub の Runner 用 API と同じ応答を返し、故障を起こせる。
package fakehub

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sort"
	"strings"
	"sync"

	"github.com/loverhetoric-gif/Upbeater/runner/internal/hub"
)

// StepRec は報告された手順の状態。
type StepRec struct {
	Index    int
	Name     string
	Status   string
	ExitCode *int
}

// JobState は模擬 Hub が持つジョブの状態。
type JobState struct {
	Job        *hub.Job
	Status     string // queued claimed succeeded failed cancelled
	Logs       map[int]string
	Steps      []StepRec
	Conclusion string
	Reason     string
	Cancel     bool
	Heartbeats int
}

type blob struct {
	data     []byte
	sha      string
	format   string
	filename string
}

// Hub は模擬 Hub。
type Hub struct {
	*httptest.Server
	Token string

	mu    sync.Mutex
	queue []*hub.Job
	jobs  map[string]*JobState
	blobs map[string]blob
	// FailLogs は、これから何回のログ送信を 503 で失敗させるか（通信の途切れ）
	FailLogs int
	// DropSeqs は、受け付けたことにして捨てる通番（保存の失敗）。一度捨てたら外す
	DropSeqs map[int]bool
	// Down なら、すべての要求に 503 を返す（Hub の停止）
	Down bool
}

// New は模擬 Hub を起動する。
func New() *Hub {
	h := &Hub{Token: "upb_r_test", jobs: map[string]*JobState{}, blobs: map[string]blob{}, DropSeqs: map[int]bool{}}
	h.Server = httptest.NewServer(http.HandlerFunc(h.serve))
	return h
}

// Enqueue はジョブを待ち行列に入れる。
func (h *Hub) Enqueue(j *hub.Job) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if j.JobToken == "" {
		j.JobToken = "upb_j_" + j.Job.ID
	}
	if j.Job.Attempt == 0 {
		j.Job.Attempt = 1
	}
	h.queue = append(h.queue, j)
	h.jobs[j.Job.ID] = &JobState{Job: j, Status: "queued", Logs: map[int]string{}}
}

// State はジョブの状態の写し。
func (h *Hub) State(id string) JobState {
	h.mu.Lock()
	defer h.mu.Unlock()
	s := *h.jobs[id]
	s.Logs = map[int]string{}
	for k, v := range h.jobs[id].Logs {
		s.Logs[k] = v
	}
	s.Steps = append([]StepRec(nil), h.jobs[id].Steps...)
	return s
}

// Log は受け取ったログを通番の順につなぐ。
func (h *Hub) Log(id string) string {
	s := h.State(id)
	var seqs []int
	for k := range s.Logs {
		seqs = append(seqs, k)
	}
	sort.Ints(seqs)
	var sb strings.Builder
	for _, k := range seqs {
		sb.WriteString(s.Logs[k])
	}
	return sb.String()
}

// SetCancel は取り消しを指示する（次の心拍で continue: false を返す）。
func (h *Hub) SetCancel(id string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.jobs[id].Cancel = true
}

// Reassign はジョブを別の実行に移す（心拍の途絶で再実行に回ったのと同じ。古いトークンを拒否する）。
func (h *Hub) Reassign(id string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.jobs[id].Job.JobToken = "upb_j_new_" + id
}

// SetDown は Hub の停止・復帰を切り替える。
func (h *Hub) SetDown(down bool) {
	h.mu.Lock()
	h.Down = down
	h.mu.Unlock()
}

// SetFailLogs はログ送信を n 回失敗させる。
func (h *Hub) SetFailLogs(n int) {
	h.mu.Lock()
	h.FailLogs = n
	h.mu.Unlock()
}

// PutBlob はテスト用に成果物・キャッシュを置く。
func (h *Hub) PutBlob(kind, name string, data []byte, format string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	sum := sha256.Sum256(data)
	h.blobs[kind+"/"+name] = blob{data: data, sha: hex.EncodeToString(sum[:]), format: format}
}

// Corrupt は保存された中身を書き換える（SHA-256 はそのまま。途中での破損・改ざん）。
func (h *Hub) Corrupt(kind, name string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	b := h.blobs[kind+"/"+name]
	b.data = append(append([]byte{}, b.data...), 'x')
	h.blobs[kind+"/"+name] = b
}

// Blob は保存された成果物・キャッシュ。
func (h *Hub) Blob(kind, name string) ([]byte, string, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	b, ok := h.blobs[kind+"/"+name]
	return b.data, b.filename, ok
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func errJSON(w http.ResponseWriter, status int, code string) {
	writeJSON(w, status, map[string]string{"error": code, "message": code})
}

func (h *Hub) serve(w http.ResponseWriter, r *http.Request) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.Down {
		errJSON(w, 503, "down")
		return
	}
	p := r.URL.Path
	if p == "/v1/runners/register" {
		var b struct {
			Code   string   `json:"code"`
			Labels []string `json:"labels"`
		}
		_ = json.NewDecoder(r.Body).Decode(&b)
		if b.Code != "GOODCODE" {
			errJSON(w, 400, "invalid_code")
			return
		}
		writeJSON(w, 201, map[string]any{"runner_id": "runner-1", "token": h.Token, "labels": b.Labels})
		return
	}
	if r.Header.Get("authorization") != "Bearer "+h.Token {
		errJSON(w, 401, "unauthorized")
		return
	}
	if p == "/v1/runners/claim" {
		if len(h.queue) == 0 {
			w.WriteHeader(204)
			return
		}
		j := h.queue[0]
		h.queue = h.queue[1:]
		h.jobs[j.Job.ID].Status = "claimed"
		writeJSON(w, 200, j)
		return
	}
	rest, ok := strings.CutPrefix(p, "/v1/runners/jobs/")
	if !ok {
		errJSON(w, 404, "not_found")
		return
	}
	id, what, _ := strings.Cut(rest, "/")
	st := h.jobs[id]
	if st == nil {
		errJSON(w, 404, "job_not_found")
		return
	}
	if r.Header.Get(hub.JobTokenHeader) != st.Job.JobToken {
		errJSON(w, 409, "stale_job")
		return
	}
	switch {
	case what == "heartbeat":
		st.Heartbeats++
		if st.Status != "claimed" || st.Cancel {
			if st.Cancel && st.Status == "claimed" {
				st.Status = "cancelled"
			}
			writeJSON(w, 200, map[string]any{"continue": false, "cancel": st.Cancel, "status": st.Status})
			return
		}
		writeJSON(w, 200, map[string]any{"continue": true, "cancel": false})
	case what == "logs":
		if h.FailLogs > 0 {
			h.FailLogs--
			errJSON(w, 503, "temporarily_unavailable")
			return
		}
		var b struct {
			Chunks  []hub.Chunk `json:"chunks"`
			LastSeq int         `json:"last_seq"`
		}
		_ = json.NewDecoder(r.Body).Decode(&b)
		for _, c := range b.Chunks {
			if h.DropSeqs[c.Seq] {
				delete(h.DropSeqs, c.Seq)
				continue
			}
			if _, dup := st.Logs[c.Seq]; !dup {
				st.Logs[c.Seq] = c.Text
			}
		}
		contig, missing := h.missing(st, b.LastSeq)
		writeJSON(w, 200, map[string]any{"ok": true, "contiguous_through": contig, "missing": missing})
	case what == "steps":
		if st.Status != "claimed" {
			errJSON(w, 409, "job_not_active")
			return
		}
		var b struct {
			Index    int    `json:"index"`
			Name     string `json:"name"`
			Status   string `json:"status"`
			ExitCode *int   `json:"exit_code"`
		}
		_ = json.NewDecoder(r.Body).Decode(&b)
		st.Steps = append(st.Steps, StepRec{b.Index, b.Name, b.Status, b.ExitCode})
		writeJSON(w, 200, map[string]any{"ok": true})
	case what == "complete":
		var b struct {
			Conclusion string `json:"conclusion"`
			Reason     string `json:"reason"`
			LastSeq    int    `json:"last_seq"`
		}
		_ = json.NewDecoder(r.Body).Decode(&b)
		status := st.Status
		if st.Status == "claimed" {
			st.Conclusion, st.Reason = b.Conclusion, b.Reason
			st.Status = map[string]string{"success": "succeeded", "failure": "failed", "cancelled": "cancelled"}[b.Conclusion]
			status = "recorded"
		}
		_, missing := h.missing(st, b.LastSeq)
		writeJSON(w, 200, map[string]any{"ok": true, "status": status, "missing": missing})
	case strings.HasPrefix(what, "artifacts/") || strings.HasPrefix(what, "cache/"):
		kind, name, _ := strings.Cut(what, "/")
		name, _ = url.PathUnescape(name)
		key := kind + "/" + name
		if r.Method == "PUT" {
			data, _ := io.ReadAll(r.Body)
			sum := sha256.Sum256(data)
			if hex.EncodeToString(sum[:]) != r.Header.Get("x-upbeater-sha256") {
				errJSON(w, 400, "sha256_mismatch")
				return
			}
			fn, _ := url.PathUnescape(r.Header.Get("x-upbeater-filename"))
			h.blobs[key] = blob{data: data, sha: hex.EncodeToString(sum[:]), format: r.Header.Get("x-upbeater-format"), filename: fn}
			writeJSON(w, 201, map[string]any{"ok": true})
			return
		}
		b, ok := h.blobs[key]
		if !ok {
			errJSON(w, 404, "not_found")
			return
		}
		w.Header().Set("x-upbeater-sha256", b.sha)
		w.Header().Set("x-upbeater-format", b.format)
		w.Header().Set("x-upbeater-filename", url.PathEscape(b.filename))
		w.Header().Set("content-length", fmt.Sprint(len(b.data)))
		_, _ = w.Write(b.data)
	default:
		errJSON(w, 404, "not_found")
	}
}

func (h *Hub) missing(st *JobState, upTo int) (int, []int) {
	max := upTo
	for k := range st.Logs {
		if k > max {
			max = k
		}
	}
	contig := 0
	missing := []int{}
	for s := 1; s <= max; s++ {
		if _, ok := st.Logs[s]; ok {
			if len(missing) == 0 {
				contig = s
			}
		} else {
			missing = append(missing, s)
		}
	}
	return contig, missing
}
