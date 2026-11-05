package agent

import (
	"bytes"
	"context"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/loverhetoric-gif/Upbeater/runner/internal/config"
	"github.com/loverhetoric-gif/Upbeater/runner/internal/fakehub"
	"github.com/loverhetoric-gif/Upbeater/runner/internal/hub"
)

func gitRepo(t *testing.T) (string, string) {
	dir := t.TempDir()
	envs := append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@e", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@e")
	for _, args := range [][]string{{"init", "-q"}, {"commit", "-q", "--allow-empty", "-m", "x"}} {
		cmd := exec.Command("git", args...)
		cmd.Dir, cmd.Env = dir, envs
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("%s", out)
		}
	}
	out, _ := exec.Command("git", "-C", dir, "rev-parse", "HEAD").Output()
	return "file://" + dir, strings.TrimSpace(string(out))
}

// 登録 → 常駐 → 受け取り → 実行 → 報告の一続き。Hub が一時的に止まっていても待って続ける
func TestRegisterAndRunOnce(t *testing.T) {
	h := fakehub.New()
	defer h.Close()
	res, err := hub.New(h.URL, "").Register(context.Background(), "GOODCODE", "test", []string{"linux"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := hub.New(h.URL, "").Register(context.Background(), "BAD", "test", []string{"linux"}); err == nil {
		t.Fatal("誤った登録コードは拒否されるべき")
	}
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "config.json")
	if err := config.Save(cfgPath, &config.Config{HubURL: h.URL, RunnerID: res.RunnerID, Token: res.Token, Labels: res.Labels, Isolation: "dir"}); err != nil {
		t.Fatal(err)
	}
	cfg, err := config.Load(cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	remote, sha := gitRepo(t)
	j := &hub.Job{}
	j.Job.ID = "job-agent"
	j.Job.TimeoutMinutes = 5
	j.Repo.CloneURL, j.Repo.SHA = remote, sha
	j.Steps = []hub.Step{{Kind: "run", Run: "echo agent-ok"}}
	j.HeartbeatIntervalMS = 200

	// 残骸：前の実行の作業場所
	work, _, _ := Paths(cfg.StateDir)
	os.MkdirAll(filepath.Join(work, "old"), 0o700)

	var logs bytes.Buffer
	a := New(cfg, "test", log.New(&logs, "", 0))
	a.PollInterval = 50 * time.Millisecond
	a.Once = true
	h.SetDown(true)
	go func() {
		time.Sleep(1500 * time.Millisecond)
		h.Enqueue(j)
		h.SetDown(false)
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := a.Run(ctx); err != nil {
		t.Fatal(err)
	}
	st := h.State("job-agent")
	if st.Conclusion != "success" || !strings.Contains(h.Log("job-agent"), "agent-ok") {
		t.Fatalf("実行されていない：%+v\n%s", st, logs.String())
	}
	if _, err := os.Stat(filepath.Join(work, "old")); !os.IsNotExist(err) {
		t.Fatal("前の作業場所を片付けていない")
	}
	if !strings.Contains(logs.String(), "もう一度試します") {
		t.Fatalf("Hub の停止を待った記録がない：%s", logs.String())
	}
}

// 同じ置き場所で Runner が二重に動かない
func TestSingleInstance(t *testing.T) {
	dir := t.TempDir()
	f, err := lock(filepath.Join(dir, "runner.lock"))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := lock(filepath.Join(dir, "runner.lock")); err == nil {
		t.Fatal("二つ目の Runner は起動できないべき")
	}
}

// 空白を含む置き場所（macOS の Application Support）でも、作業場所のパスには空白を入れない
func TestWorkBaseAvoidsSpaces(t *testing.T) {
	plain := t.TempDir()
	if got := workBase(plain); got != filepath.Join(plain, "work") {
		t.Fatalf("空白の無い置き場所はそのまま使うべき：%s", got)
	}
	spaced := filepath.Join(t.TempDir(), "Application Support", "upbeater-runner")
	a, b := workBase(spaced), workBase(spaced+"2")
	if strings.ContainsAny(a, " \t") || a == b {
		t.Fatalf("空白を避け、置き場所ごとに分けるべき：%s / %s", a, b)
	}
}
