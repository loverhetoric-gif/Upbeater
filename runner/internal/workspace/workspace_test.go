package workspace

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 模擬のコンテナの道具：引数を記録し、exec はこの端末で実行する
const fakeEngine = `#!/bin/sh
echo "$*" >> "$FAKE_ENGINE_LOG"
cmd=$1; shift
case $cmd in
  run) echo fakecontainer ;;
  exec)
    dir=
    while [ $# -gt 0 ]; do
      case $1 in
        -w) dir=$2; shift 2 ;;
        -e) shift 2 ;;
        *) break ;;
      esac
    done
    shift
    cd "$dir" && exec "$@" ;;
  ps) echo old1; echo old2 ;;
  *) exit 0 ;;
esac
`

func TestContainerMode(t *testing.T) {
	dir := t.TempDir()
	engine := filepath.Join(dir, "fake-docker")
	os.WriteFile(engine, []byte(fakeEngine), 0o755)
	logPath := filepath.Join(dir, "engine.log")
	t.Setenv("FAKE_ENGINE_LOG", logPath)

	m := &Manager{Base: filepath.Join(dir, "work"), Mode: "container", Engine: engine, Image: "ubuntu:24.04", RunnerID: "r1"}
	ws, err := m.Create(context.Background(), "job-1234", 1, "mark")
	if err != nil {
		t.Fatal(err)
	}
	script := filepath.Join(ws.Tmp, "s.sh")
	os.WriteFile(script, []byte("pwd; echo \"v=$SECRET_X\"; echo \"home=$HOME\""), 0o700)
	cmd := ws.Command(script, ws.Work, map[string]string{"SECRET_X": "topsecret-value", "HOME": ws.Home})
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &out
	code, err := ws.Run(context.Background(), cmd)
	if err != nil || code != 0 {
		t.Fatalf("実行できない：%d %v %s", code, err, out.String())
	}
	if !strings.Contains(out.String(), "v=topsecret-value") || !strings.Contains(out.String(), ws.Work) {
		t.Fatalf("環境変数・作業ディレクトリが渡っていない：%s", out.String())
	}
	if err := ws.Close(); err != nil {
		t.Fatal(err)
	}
	if err := m.Sweep(context.Background()); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(logPath)
	calls := string(b)
	// 秘密情報の値はコマンドの引数に載せない（名前だけ）
	if strings.Contains(calls, "topsecret-value") {
		t.Fatal("秘密情報の値がコマンドの引数に出ている")
	}
	for _, want := range []string{
		"run -d --name upbeater-job1234",
		"--label upbeater.runner=r1",
		"-v " + ws.Root + ":" + ws.Root,
		"--user ",
		"exec -w " + ws.Work + " -e HOME -e SECRET_X upbeater-job1234",
		"rm -f upbeater-job1234",
		"ps -aq --filter label=upbeater.runner=r1",
		"rm -f old1",
	} {
		if !strings.Contains(calls, want) {
			t.Errorf("コンテナの操作に %q がない\n%s", want, calls)
		}
	}
	if _, err := os.Stat(ws.Root); !os.IsNotExist(err) {
		t.Fatal("作業場所が残っている")
	}
}

func TestResolve(t *testing.T) {
	if mode, _, _ := Resolve("dir", ""); mode != "dir" {
		t.Fatal("dir の指定はそのまま")
	}
	if mode, eng, _ := Resolve("container", "/bin/true"); mode != "container" || eng != "/bin/true" {
		t.Fatal("container の指定はそのまま")
	}
}
