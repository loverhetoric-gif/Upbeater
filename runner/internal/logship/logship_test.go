package logship

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/loverhetoric-gif/Upbeater/runner/internal/fakehub"
	"github.com/loverhetoric-gif/Upbeater/runner/internal/hub"
)

func setup(t *testing.T) (*fakehub.Hub, *hub.Client, string) {
	h := fakehub.New()
	t.Cleanup(h.Close)
	j := &hub.Job{}
	j.Job.ID = "job-1"
	h.Enqueue(j)
	c := hub.New(h.URL, h.Token)
	if _, err := c.Claim(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	return h, c, t.TempDir()
}

func TestRetainsWhileHubUnreachableAndResends(t *testing.T) {
	h, c, spool := setup(t)
	h.SetFailLogs(3) // 送信が 3 回続けて途切れる
	s, err := New(c, spool, "job-1", 1, "upb_j_job-1")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	go s.Run(ctx)
	for i := 0; i < 50; i++ {
		s.Write(fmt.Sprintf("行 %d\n", i))
	}
	fctx, fcancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer fcancel()
	s.Flush(fctx)
	cancel()
	want := ""
	for i := 0; i < 50; i++ {
		want += fmt.Sprintf("行 %d\n", i)
	}
	if got := h.Log("job-1"); got != want {
		t.Fatalf("途切れた後に再送されていない：\n%q", got)
	}
	if !s.Finish() {
		t.Fatal("すべて届いたのに保持を消していない")
	}
	if _, err := os.Stat(s.dir); !os.IsNotExist(err) {
		t.Fatal("保持のディレクトリが残っている")
	}
}

func TestMissingSeqIsResent(t *testing.T) {
	h, c, spool := setup(t)
	h.DropSeqs[1] = true // Hub 側で 1 番が失われる
	s, _ := New(c, spool, "job-1", 1, "upb_j_job-1")
	s.Write(strings.Repeat("a", cutSize)) // 1 番
	s.Write("b\n")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	s.Flush(ctx)
	if got := h.Log("job-1"); got != strings.Repeat("a", cutSize)+"b\n" {
		t.Fatalf("欠けた通番を再送していない（長さ %d）", len(got))
	}
}

func TestRecoverAfterRunnerCrash(t *testing.T) {
	h, c, spool := setup(t)
	h.SetDown(true) // Hub に届かないまま Runner が落ちる
	s, _ := New(c, spool, "job-1", 1, "upb_j_job-1")
	s.Write("落ちる前のログ\n")
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	s.Flush(ctx)
	cancel()
	s.SetCompletion(&Completion{Conclusion: "failure", Reason: "テスト"})
	if s.Finish() {
		t.Fatal("届いていないのに保持を消した")
	}
	// 次の起動：Hub が戻っていれば、保持していたログと終了の報告を送る
	h.SetDown(false)
	if left := Recover(context.Background(), c, spool); left != 0 {
		t.Fatalf("送りきれていない：%d", left)
	}
	if h.Log("job-1") != "落ちる前のログ\n" || h.State("job-1").Conclusion != "failure" {
		t.Fatalf("復旧で送られていない：%q %q", h.Log("job-1"), h.State("job-1").Conclusion)
	}
	entries, _ := os.ReadDir(spool)
	if len(entries) != 0 {
		t.Fatal("送り終えた保持が残っている")
	}
}

func TestStaleJobDiscardsSpool(t *testing.T) {
	h, c, spool := setup(t)
	s, _ := New(c, spool, "job-1", 1, "upb_j_job-1")
	h.Reassign("job-1") // 再実行に移った
	s.Write("古い実行のログ\n")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	s.Flush(ctx)
	if !s.Stale() || !s.Finish() {
		t.Fatal("古い実行のログは捨てるべき")
	}
}

func TestChunksDoNotSplitCharacters(t *testing.T) {
	h, c, spool := setup(t)
	s, _ := New(c, spool, "job-1", 1, "upb_j_job-1")
	text := strings.Repeat("日本語", chunkMax/3)
	s.Write(text)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	s.Flush(ctx)
	st := h.State("job-1")
	if len(st.Logs) < 2 {
		t.Fatal("大きなログが分けられていない")
	}
	if h.Log("job-1") != text {
		t.Fatal("断片の境目で文字が壊れた")
	}
}
