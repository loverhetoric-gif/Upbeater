//go:build unix

// Package proc は手順のプロセスを起動し、子プロセスまで確実に終了させる。
//
//   - 手順は自分のプロセスグループで起動し、終了時はグループごと止める（TERM → 猶予 → KILL）
//   - setsid などでグループから抜けたプロセスも、環境変数の印（Marker）で探して止める
//     （Linux は /proc/<pid>/environ、macOS は ps -E）
package proc

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// MarkerEnv はジョブのプロセスに付ける印の環境変数名。
const MarkerEnv = "UPBEATER_JOB_MARK"

// Grace は TERM から KILL までの猶予。
var Grace = 5 * time.Second

// Group はジョブの間に起動したプロセスグループの集まり。
type Group struct {
	Marker string
	mu     sync.Mutex
	pgids  map[int]struct{}
}

// NewGroup は印 marker のプロセスを管理する Group を作る。
func NewGroup(marker string) *Group { return &Group{Marker: marker, pgids: map[int]struct{}{}} }

// Run はコマンドを実行し、終了コードを返す。ctx が終わったらグループごと止める。
// 終わった後も背景に残ったプロセスは、ジョブの終わりに KillAll で止める（次の手順で使えるよう残す）。
func (g *Group) Run(ctx context.Context, cmd *exec.Cmd) (int, error) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	// 背景に残ったプロセスが出力をつかんだままでも、手順の終わりを待ち続けない
	if cmd.WaitDelay == 0 {
		cmd.WaitDelay = 2 * time.Second
	}
	if err := cmd.Start(); err != nil {
		return -1, err
	}
	pgid := cmd.Process.Pid
	g.mu.Lock()
	g.pgids[pgid] = struct{}{}
	g.mu.Unlock()
	done := make(chan struct{})
	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		select {
		case <-ctx.Done():
			terminate(pgid)
		case <-done:
		}
	}()
	err := cmd.Wait()
	close(done)
	<-stopped // 打ち切りの時は、グループが止まり終えるまで待つ
	if ctx.Err() != nil {
		return -1, ctx.Err()
	}
	if errors.Is(err, exec.ErrWaitDelay) && cmd.ProcessState != nil {
		err = nil
		if !cmd.ProcessState.Success() {
			return cmd.ProcessState.ExitCode(), nil
		}
	}
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			if ws, ok := ee.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
				return 128 + int(ws.Signal()), nil
			}
			return ee.ExitCode(), nil
		}
		return -1, err
	}
	return 0, nil
}

// terminate はグループに TERM を送り、猶予の後に KILL を送る。
func terminate(pgid int) {
	_ = syscall.Kill(-pgid, syscall.SIGTERM)
	deadline := time.Now().Add(Grace)
	for time.Now().Before(deadline) {
		if syscall.Kill(-pgid, 0) != nil {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	_ = syscall.Kill(-pgid, syscall.SIGKILL)
}

// KillAll はジョブのすべてのプロセス（グループと、印のついたプロセス）を止める。
func (g *Group) KillAll() {
	g.mu.Lock()
	pgids := make([]int, 0, len(g.pgids))
	for p := range g.pgids {
		pgids = append(pgids, p)
	}
	g.mu.Unlock()
	var wg sync.WaitGroup
	for _, p := range pgids {
		if syscall.Kill(-p, 0) == nil {
			wg.Add(1)
			go func(p int) { defer wg.Done(); terminate(p) }(p)
		}
	}
	wg.Wait()
	// グループから抜けたもの：TERM → 猶予 → KILL
	pids := FindMarked(g.Marker)
	for _, p := range pids {
		_ = syscall.Kill(p, syscall.SIGTERM)
	}
	deadline := time.Now().Add(Grace)
	for len(pids) > 0 && time.Now().Before(deadline) {
		time.Sleep(100 * time.Millisecond)
		pids = FindMarked(g.Marker)
	}
	for _, p := range FindMarked(g.Marker) {
		_ = syscall.Kill(p, syscall.SIGKILL)
	}
}

// FindMarked は環境変数に印 MarkerEnv=marker を持つプロセスを探す（自分自身は除く）。
func FindMarked(marker string) []int {
	if marker == "" {
		return nil
	}
	needle := MarkerEnv + "=" + marker
	self := os.Getpid()
	var out []int
	if runtime.GOOS == "linux" {
		dirs, _ := filepath.Glob("/proc/[0-9]*")
		for _, d := range dirs {
			pid, err := strconv.Atoi(filepath.Base(d))
			if err != nil || pid == self {
				continue
			}
			env, err := os.ReadFile(filepath.Join(d, "environ"))
			if err != nil {
				continue
			}
			for _, kv := range bytes.Split(env, []byte{0}) {
				if string(kv) == needle {
					out = append(out, pid)
					break
				}
			}
		}
		return out
	}
	// macOS：自分と同じ利用者のプロセスは ps -E で環境変数が見える
	b, err := exec.Command("ps", "-axwwE", "-o", "pid=,command=").Output()
	if err != nil {
		return nil
	}
	sc := bufio.NewScanner(bytes.NewReader(b))
	sc.Buffer(make([]byte, 1<<20), 1<<24)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		pidStr, rest, _ := strings.Cut(line, " ")
		pid, err := strconv.Atoi(pidStr)
		if err != nil || pid == self {
			continue
		}
		for _, f := range strings.Fields(rest) {
			if f == needle {
				out = append(out, pid)
				break
			}
		}
	}
	return out
}
