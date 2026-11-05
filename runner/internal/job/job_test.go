package job

import (
	"context"
	"encoding/base64"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/loverhetoric-gif/Upbeater/runner/internal/fakehub"
	"github.com/loverhetoric-gif/Upbeater/runner/internal/hub"
	"github.com/loverhetoric-gif/Upbeater/runner/internal/proc"
	"github.com/loverhetoric-gif/Upbeater/runner/internal/workspace"
)

const (
	secretValue = "sup3r-s3cret-VALUE"
	ghToken     = "ghs_fakeInstallationToken123"
)

type env struct {
	t      *testing.T
	hub    *fakehub.Hub
	client *hub.Client
	ws     *workspace.Manager
	spool  string
	remote string
	sha    string
}

func run(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command(args[0], args[1:]...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@example.com", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@example.com")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("%v：%v\n%s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

func setup(t *testing.T) *env {
	proc.Grace = 300 * time.Millisecond
	h := fakehub.New()
	t.Cleanup(h.Close)
	// 取得元のリポジトリ（file://）
	src := t.TempDir()
	run(t, src, "git", "init", "-q", "-b", "main")
	os.WriteFile(filepath.Join(src, "README.md"), []byte("hello upbeater\n"), 0o644)
	run(t, src, "git", "add", ".")
	run(t, src, "git", "commit", "-q", "-m", "init")
	sha := run(t, src, "git", "rev-parse", "HEAD")
	base := t.TempDir()
	return &env{t: t, hub: h, client: hub.New(h.URL, h.Token), ws: &workspace.Manager{Base: filepath.Join(base, "work"), Mode: "dir", RunnerID: "r1"}, spool: filepath.Join(base, "spool"), remote: "file://" + src, sha: sha}
}

func (e *env) job(id string, steps ...hub.Step) *hub.Job {
	j := &hub.Job{}
	j.Job.ID = id
	j.Job.JobKey = "build"
	j.Job.RunNumber = 1
	j.Job.TimeoutMinutes = 60
	j.Job.Matrix = map[string]any{"os": "linux"}
	j.Repo.FullName = "acme/widget"
	j.Repo.CloneURL = e.remote
	j.Repo.SHA = e.sha
	j.Repo.Ref = "refs/heads/main"
	j.Repo.AuthHeader = "Authorization: Basic " + base64.StdEncoding.EncodeToString([]byte("x-access-token:"+ghToken))
	j.Event.Kind = "push"
	j.Event.Branch = "main"
	j.Steps = steps
	j.Env = map[string]string{"CI": "true"}
	j.Secrets = map[string]string{"TOKEN": secretValue}
	j.HeartbeatIntervalMS = 100
	return j
}

func (e *env) exec(j *hub.Job) Result {
	e.hub.Enqueue(j)
	got, err := e.client.Claim(context.Background(), nil)
	if err != nil || got == nil {
		e.t.Fatalf("受け取れない：%v", err)
	}
	return Run(context.Background(), Options{Client: e.client, Workspaces: e.ws, SpoolDir: e.spool, Version: "test", FinishTimeout: 10 * time.Second}, got)
}

func sh(script string) hub.Step { return hub.Step{Kind: "run", Run: script} }

func (e *env) noLeftovers() {
	e.t.Helper()
	entries, _ := os.ReadDir(e.ws.Base)
	if len(entries) != 0 {
		e.t.Fatalf("作業場所が残っている：%v", entries)
	}
	spool, _ := os.ReadDir(e.spool)
	if len(spool) != 0 {
		e.t.Fatalf("送り終えたログの保持が残っている：%v", spool)
	}
}

func TestJobRunsStepsAndHidesSecrets(t *testing.T) {
	e := setup(t)
	j := e.job("job-ok",
		hub.Step{Kind: "run", Name: "取得の確認", Run: "cat README.md\ntest \"$(git rev-parse HEAD)\" = \"$UPBEATER_SHA_EXPECT\""},
		sh("echo \"直接：$TOKEN\"\necho \"置換：${{ secrets.TOKEN }}\"\nprintf %s \"$TOKEN\" | base64\necho matrix=${{ matrix.os }} event=${{ event }}"),
		sh("# 認証のヘッダーは手順に渡さない・残さない\nenv | grep -c GIT_CONFIG_VALUE || true\ngrep -c extraHeader .git/config || true\ngit config --get http.extraHeader || echo ヘッダーなし"),
		hub.Step{Kind: "run", Run: "exit 3", ContinueOnError: true},
		hub.Step{Kind: "run", Run: "echo 失敗時だけ", If: "failure()"},
		hub.Step{Kind: "run", Run: "echo 条件どおり", If: "branch == 'main' && contains(matrix.os, 'lin')"},
	)
	j.Steps[0].Env = map[string]string{"UPBEATER_SHA_EXPECT": "${{ sha }}"}
	res := e.exec(j)
	log := e.hub.Log("job-ok")
	if res.Conclusion != "success" || !res.Reported {
		t.Fatalf("成功するべき：%+v\n%s", res, log)
	}
	for _, want := range []string{"hello upbeater", "直接：***", "置換：***", "matrix=linux event=push", "ヘッダーなし", "continue-on-error", "条件どおり", "■ 結果：成功"} {
		if !strings.Contains(log, want) {
			t.Errorf("ログに %q がない\n%s", want, log)
		}
	}
	for _, leak := range []string{secretValue, base64.StdEncoding.EncodeToString([]byte(secretValue)), ghToken, "失敗時だけ"} {
		if strings.Contains(log, leak) {
			t.Errorf("ログに %q が出ている", leak)
		}
	}
	if strings.Contains(log, "\n1\n") {
		t.Errorf("認証の設定が手順から見えている\n%s", log)
	}
	st := e.hub.State("job-ok")
	statuses := map[int]string{}
	for _, s := range st.Steps {
		statuses[s.Index] = s.Status
	}
	if statuses[3] != "failure" || statuses[4] != "skipped" || statuses[5] != "success" {
		t.Errorf("手順の状態が違う：%v", statuses)
	}
	e.noLeftovers()
}

func TestFailureSkipsLaterStepsButRunsFailureHandlers(t *testing.T) {
	e := setup(t)
	res := e.exec(e.job("job-fail", sh("echo a; exit 5"), sh("echo 走らない"), hub.Step{Kind: "run", Run: "echo 後始末", If: "always()"}))
	log := e.hub.Log("job-fail")
	if res.Conclusion != "failure" || !strings.Contains(res.Reason, "終了コード 5") {
		t.Fatalf("失敗の理由：%+v", res)
	}
	if strings.Contains(log, "走らない") || !strings.Contains(log, "後始末") {
		t.Fatalf("失敗の後の手順の扱いが違う\n%s", log)
	}
	if e.hub.State("job-fail").Conclusion != "failure" {
		t.Fatal("Hub に失敗を報告していない")
	}
	e.noLeftovers()
}

func alive(pid int) bool {
	if syscall.Kill(pid, 0) != nil {
		return false
	}
	b, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	return err != nil || !strings.Contains(string(b), ") Z ")
}

// 時間超過：打ち切り、子プロセス（setsid で抜けたものも）まで終了させ、作業場所を消す
func TestJobTimeoutKillsChildProcesses(t *testing.T) {
	e := setup(t)
	minute = 2 * time.Second
	defer func() { minute = time.Minute }()
	pidfile := filepath.Join(t.TempDir(), "pids")
	j := e.job("job-timeout", sh("sleep 300 & echo $! >> "+pidfile+"\nsetsid sh -c 'trap \"\" TERM; sleep 300' & echo $! >> "+pidfile+"\nsleep 300"))
	j.Job.TimeoutMinutes = 1
	start := time.Now()
	res := e.exec(j)
	if res.Conclusion != "failure" || !strings.Contains(res.Reason, "時間超過") {
		t.Fatalf("時間超過になるべき：%+v", res)
	}
	if time.Since(start) > 15*time.Second {
		t.Fatal("打ち切りに時間がかかりすぎる")
	}
	b, _ := os.ReadFile(pidfile)
	for _, f := range strings.Fields(string(b)) {
		pid, _ := strconv.Atoi(f)
		if alive(pid) {
			syscall.Kill(pid, syscall.SIGKILL)
			t.Fatalf("子プロセス %d が残っている", pid)
		}
	}
	if !strings.Contains(e.hub.Log("job-timeout"), "時間超過") {
		t.Fatal("ログに時間超過の理由がない")
	}
	e.noLeftovers()
}

func TestStepTimeout(t *testing.T) {
	e := setup(t)
	minute = time.Second
	defer func() { minute = time.Minute }()
	res := e.exec(e.job("job-step-timeout", hub.Step{Kind: "run", Run: "sleep 60", Timeout: 1}, sh("echo 走らない")))
	if res.Conclusion != "failure" || !strings.Contains(res.Reason, "手順の時間超過") {
		t.Fatalf("手順の時間超過になるべき：%+v", res)
	}
}

// Hub の取り消し（新しい更新で concurrency の古いジョブを取り消す）
func TestHubCancelStopsJob(t *testing.T) {
	e := setup(t)
	go func() {
		time.Sleep(500 * time.Millisecond)
		e.hub.SetCancel("job-cancel")
	}()
	start := time.Now()
	res := e.exec(e.job("job-cancel", sh("sleep 60")))
	if res.Conclusion != "cancelled" || time.Since(start) > 10*time.Second {
		t.Fatalf("取り消しで止まるべき：%+v（%v）", res, time.Since(start))
	}
	e.noLeftovers()
}

// 二重実行の防止：別の実行に移ったジョブは止め、報告しない
func TestStaleJobAborts(t *testing.T) {
	e := setup(t)
	go func() {
		time.Sleep(500 * time.Millisecond)
		e.hub.Reassign("job-stale")
	}()
	res := e.exec(e.job("job-stale", sh("sleep 60")))
	if !res.Stale || res.Reported {
		t.Fatalf("古い実行は報告しないべき：%+v", res)
	}
	if e.hub.State("job-stale").Conclusion != "" {
		t.Fatal("古い実行が結果を書いた")
	}
	e.noLeftovers()
}

// 作業場所の汚染：前のジョブが残したファイルは次のジョブから見えない
func TestWorkspaceIsDisposable(t *testing.T) {
	e := setup(t)
	r1 := e.exec(e.job("job-a", sh("echo dirty > leftover.txt; echo dirty > \"$TMPDIR/tmpfile\"; echo $UPBEATER_WORKSPACE")))
	r2 := e.exec(e.job("job-b", sh("test ! -e leftover.txt && test -z \"$(ls -A \"$TMPDIR\" | grep -v '^step-')\" && git status --porcelain | wc -l")))
	if r1.Conclusion != "success" || r2.Conclusion != "success" {
		t.Fatalf("前のジョブの残骸が見えている：%+v %+v\n%s", r1, r2, e.hub.Log("job-b"))
	}
	// Runner が落ちて残った作業場所は、次の起動で片付ける
	os.MkdirAll(filepath.Join(e.ws.Base, "crashed-1", "work"), 0o700)
	os.WriteFile(filepath.Join(e.ws.Base, "crashed-1", "work", "x"), []byte("x"), 0o400)
	os.Chmod(filepath.Join(e.ws.Base, "crashed-1", "work"), 0o500)
	if err := e.ws.Sweep(context.Background()); err != nil {
		t.Fatal(err)
	}
	e.noLeftovers()
}

func TestArtifactsAndCache(t *testing.T) {
	e := setup(t)
	home := t.TempDir()
	t.Setenv("HOME", home)
	j1 := e.job("job-up",
		hub.Step{Kind: "uses", Uses: "cache", With: map[string]string{"key": "deps-v1", "path": "deps\n~/.toolcache"}},
		sh("mkdir -p dist deps ~/.toolcache && echo 成果 > dist/app.txt && echo dep > deps/d.txt && echo tc > ~/.toolcache/t"),
		hub.Step{Kind: "uses", Uses: "upload-artifact@v4", With: map[string]string{"name": "app", "path": "dist"}},
		hub.Step{Kind: "distribute", Platform: "android", File: "dist/app.txt"},
	)
	j1.Artifacts = []hub.Artifact{{Name: "readme", Path: "README.md"}}
	if r := e.exec(j1); r.Conclusion != "success" {
		t.Fatalf("保存のジョブが失敗：%+v\n%s", r, e.hub.Log("job-up"))
	}
	if _, _, ok := e.hub.Blob("cache", "deps-v1"); !ok {
		t.Fatal("キャッシュが保存されていない")
	}
	if data, fn, ok := e.hub.Blob("artifacts", "distribute-android"); !ok || string(data) != "成果\n" || fn != "app.txt" {
		t.Fatal("配布するファイルがそのまま送られていない")
	}
	os.RemoveAll(filepath.Join(home, ".toolcache"))
	j2 := e.job("job-down",
		hub.Step{Kind: "uses", Uses: "actions/cache@v4", With: map[string]string{"key": "deps-v1", "path": "deps\n~/.toolcache"}},
		hub.Step{Kind: "uses", Uses: "download-artifact", With: map[string]string{"name": "app", "path": "got"}},
		sh("cat got/dist/app.txt deps/d.txt ~/.toolcache/t"),
	)
	if r := e.exec(j2); r.Conclusion != "success" {
		t.Fatalf("取り出しのジョブが失敗：%+v\n%s", r, e.hub.Log("job-down"))
	}
	log := e.hub.Log("job-down")
	for _, want := range []string{"成果", "dep", "tc", "キャッシュ「deps-v1」を戻しました"} {
		if !strings.Contains(log, want) {
			t.Errorf("ログに %q がない\n%s", want, log)
		}
	}
	// 壊れた成果物（SHA-256 が合わない）は使わない
	e.hub.Corrupt("artifacts", "app")
	rb := e.exec(e.job("job-corrupt", hub.Step{Kind: "uses", Uses: "download-artifact", With: map[string]string{"name": "app"}}))
	if rb.Conclusion != "failure" || !strings.Contains(rb.Reason, "SHA-256") {
		t.Fatalf("SHA-256 が合わない成果物は使わないべき：%+v", rb)
	}
	r := e.exec(e.job("job-broken", hub.Step{Kind: "uses", Uses: "download-artifact", With: map[string]string{"name": "missing"}}))
	if r.Conclusion != "failure" || !strings.Contains(r.Reason, "がありません") {
		t.Fatalf("無い成果物は失敗にするべき：%+v", r)
	}
}

func TestSetupToolChecksVersion(t *testing.T) {
	e := setup(t)
	gov := strings.TrimPrefix(strings.Fields(run(t, "", "go", "version"))[2], "go")
	major := strings.Join(strings.Split(gov, ".")[:2], ".")
	ok := e.exec(e.job("job-go", hub.Step{Kind: "uses", Uses: "setup-go", With: map[string]string{"go-version": major + ".x"}}))
	ng := e.exec(e.job("job-go-ng", hub.Step{Kind: "uses", Uses: "setup-go", With: map[string]string{"go-version": "1.2"}}))
	if ok.Conclusion != "success" || ng.Conclusion != "failure" || !strings.Contains(ng.Reason, "版が合いません") {
		t.Fatalf("版の確認：%+v %+v", ok, ng)
	}
	for _, c := range []struct {
		got, want string
		ok        bool
	}{
		{"20.11.1", "20", true}, {"20.11.1", "v20.x", true}, {"20.11.1", "18", false}, {"20.11.1", ">=18", true},
		{"17.0.2", "17", true}, {"3.12.1", "3.12", true}, {"3.11.0", "3.12", false}, {"1.2.3", "lts/*", true},
	} {
		if versionMatches(c.got, c.want) != c.ok {
			t.Errorf("versionMatches(%s, %s) は %v", c.got, c.want, c.ok)
		}
	}
}

// ログ送信の途切れ：Hub に届かない間は保持し、戻ったら送る
func TestLogsSurviveHubOutage(t *testing.T) {
	e := setup(t)
	e.hub.SetFailLogs(4)
	res := e.exec(e.job("job-flaky", sh("for i in $(seq 1 200); do echo 行$i; done")))
	if res.Conclusion != "success" || !res.Reported {
		t.Fatalf("結果：%+v", res)
	}
	log := e.hub.Log("job-flaky")
	if !strings.Contains(log, "行1\n") || !strings.Contains(log, "行200\n") {
		t.Fatalf("途切れた間のログが欠けている\n%s", log)
	}
	e.noLeftovers()
}

// Hub が止まったまま終わったら、終了の報告とログを保持し、次の起動で送る
func TestCompletionKeptWhenHubDown(t *testing.T) {
	e := setup(t)
	e.hub.Enqueue(e.job("job-down-hub", sh("echo 終わり")))
	j, _ := e.client.Claim(context.Background(), nil)
	e.hub.SetDown(true)
	res := Run(context.Background(), Options{Client: e.client, Workspaces: e.ws, SpoolDir: e.spool, Version: "test", FinishTimeout: 2 * time.Second}, j)
	if res.Reported || res.Conclusion != "success" {
		t.Fatalf("Hub が止まっているので報告できないはず：%+v", res)
	}
	spool, _ := os.ReadDir(e.spool)
	if len(spool) != 1 {
		t.Fatal("報告とログを保持していない")
	}
	e.hub.SetDown(false)
	recoverAll(t, e)
	if e.hub.State("job-down-hub").Conclusion != "success" || !strings.Contains(e.hub.Log("job-down-hub"), "終わり") {
		t.Fatal("復旧後に報告されていない")
	}
}
