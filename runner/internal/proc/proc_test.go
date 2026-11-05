//go:build unix

package proc

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func alive(pid int) bool {
	if syscall.Kill(pid, 0) != nil {
		return false
	}
	// ゾンビ（終了済みで回収待ち）は生きていないとみなす
	if b, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat"); err == nil {
		f := strings.Fields(string(b))
		return len(f) > 2 && f[2] != "Z"
	}
	return true
}

func readPids(t *testing.T, path string) []int {
	var out []int
	for i := 0; i < 100; i++ {
		b, _ := os.ReadFile(path)
		out = nil
		for _, f := range strings.Fields(string(b)) {
			n, _ := strconv.Atoi(f)
			out = append(out, n)
		}
		if len(out) >= 2 {
			return out
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("子プロセスの番号が書かれない：%v", out)
	return nil
}

// 時間超過：子・孫・setsid で抜けたプロセスまで確実に止める
func TestTimeoutKillsDescendants(t *testing.T) {
	Grace = 500 * time.Millisecond
	dir := t.TempDir()
	pidfile := filepath.Join(dir, "pids")
	marker := "test-" + strconv.Itoa(os.Getpid())
	script := `sleep 300 & echo $! >> ` + pidfile + `
setsid sh -c 'echo $$ >> ` + pidfile + `; trap "" TERM; sleep 300' &
wait`
	cmd := exec.Command("bash", "-c", script)
	cmd.Env = append(os.Environ(), MarkerEnv+"="+marker)
	g := NewGroup(marker)
	ctx, cancel := context.WithTimeout(context.Background(), 1*time.Second)
	defer cancel()
	start := time.Now()
	code, err := g.Run(ctx, cmd)
	if err == nil {
		t.Fatalf("時間超過になるべき（終了コード %d）", code)
	}
	if time.Since(start) > 5*time.Second {
		t.Fatal("打ち切りに時間がかかりすぎる")
	}
	pids := readPids(t, pidfile)
	g.KillAll()
	time.Sleep(200 * time.Millisecond)
	for _, p := range pids {
		if alive(p) {
			syscall.Kill(p, syscall.SIGKILL)
			t.Fatalf("子プロセス %d が残っている", p)
		}
	}
}

func TestExitCode(t *testing.T) {
	g := NewGroup("x")
	code, err := g.Run(context.Background(), exec.Command("sh", "-c", "exit 7"))
	if err != nil || code != 7 {
		t.Fatalf("終了コード：%d %v", code, err)
	}
}
