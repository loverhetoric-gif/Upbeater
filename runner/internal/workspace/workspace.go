// Package workspace はジョブごとの使い捨ての作業場所を作る。
//
//   - dir：専用の一時ディレクトリ（macOS の既定）。終わったらプロセスを止めて丸ごと消す
//   - container：コンテナ（Linux の既定）。作業場所のディレクトリを同じパスでコンテナに入れ、手順はコンテナの中で実行する。
//     終わったらコンテナごと消す
//
// 作業場所の構成：<root>/work（リポジトリ）・<root>/tmp（一時ファイル・手順の台本）・<root>/home（コンテナの HOME）
package workspace

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/loverhetoric-gif/Upbeater/runner/internal/proc"
)

// Manager は作業場所を作り、残骸を片付ける。
type Manager struct {
	Base     string // 作業場所を置くディレクトリ（Runner 専用）
	Mode     string // dir・container
	Engine   string // docker・podman（container の時）
	Image    string
	RunnerID string
}

// Resolve は設定の隔離の方式（auto・dir・container）を実際の方式に決める。
// auto は Linux でコンテナの道具が使えればコンテナ、それ以外は一時ディレクトリ。理由も返す。
func Resolve(isolation, engine string) (mode, eng, note string) {
	if isolation == "dir" {
		return "dir", "", "作業場所：専用の一時ディレクトリ"
	}
	if engine == "" {
		for _, e := range []string{"docker", "podman"} {
			if _, err := exec.LookPath(e); err == nil {
				engine = e
				break
			}
		}
	}
	usable := false
	if engine != "" {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		usable = exec.CommandContext(ctx, engine, "info").Run() == nil
		cancel()
	}
	if isolation == "container" {
		return "container", engine, "作業場所：コンテナ（" + engine + "）"
	}
	if runtime.GOOS == "linux" && usable {
		return "container", engine, "作業場所：コンテナ（" + engine + "）"
	}
	if runtime.GOOS == "linux" {
		return "dir", "", "作業場所：専用の一時ディレクトリ（docker・podman が使えないため、コンテナは使っていません）"
	}
	return "dir", "", "作業場所：専用の一時ディレクトリ"
}

// Workspace は 1 つのジョブの作業場所。
type Workspace struct {
	Root, Work, Tmp, Home string
	Mode                  string
	Group                 *proc.Group
	engine, container     string
	image                 string
}

func randHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// Sweep は前の実行の残骸（作業場所・コンテナ）を片付ける。Runner の起動時に呼ぶ。
func (m *Manager) Sweep(ctx context.Context) error {
	if m.Mode == "container" && m.Engine != "" {
		out, err := exec.CommandContext(ctx, m.Engine, "ps", "-aq", "--filter", "label=upbeater.runner="+m.RunnerID).Output()
		if err == nil {
			for _, id := range strings.Fields(string(out)) {
				_ = exec.CommandContext(ctx, m.Engine, "rm", "-f", id).Run()
			}
		}
	}
	entries, err := os.ReadDir(m.Base)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	for _, e := range entries {
		m.remove(ctx, filepath.Join(m.Base, e.Name()))
	}
	return nil
}

// Create は新しい作業場所を作る。marker はジョブのプロセスの印。
func (m *Manager) Create(ctx context.Context, jobID string, attempt int, marker string) (*Workspace, error) {
	if err := os.MkdirAll(m.Base, 0o700); err != nil {
		return nil, err
	}
	root, err := os.MkdirTemp(m.Base, fmt.Sprintf("%s-%d-", shortID(jobID), attempt))
	if err != nil {
		return nil, err
	}
	// 一時ディレクトリの実体のパス（macOS の /var → /private/var など）に揃える
	if real, err := filepath.EvalSymlinks(root); err == nil {
		root = real
	}
	w := &Workspace{Root: root, Work: filepath.Join(root, "work"), Tmp: filepath.Join(root, "tmp"), Home: filepath.Join(root, "home"), Mode: m.Mode, Group: proc.NewGroup(marker), engine: m.Engine, image: m.Image}
	for _, d := range []string{w.Work, w.Tmp, w.Home} {
		if err := os.Mkdir(d, 0o700); err != nil {
			_ = os.RemoveAll(root)
			return nil, err
		}
	}
	if m.Mode == "container" {
		if m.Engine == "" {
			_ = os.RemoveAll(root)
			return nil, fmt.Errorf("コンテナの道具（docker・podman）が見つかりません")
		}
		name := "upbeater-" + shortID(jobID) + "-" + randHex(4)
		args := []string{"run", "-d", "--name", name,
			"--label", "upbeater.runner=" + m.RunnerID, "--label", "upbeater.job=" + jobID,
			"--user", strconv.Itoa(os.Getuid()) + ":" + strconv.Itoa(os.Getgid()),
			"-v", root + ":" + root, "-w", w.Work, "-e", "HOME=" + w.Home,
			"--entrypoint", "sh", m.Image, "-c", "trap 'exit 0' TERM; while :; do sleep 3600 & wait $!; done"}
		var stderr bytes.Buffer
		cmd := exec.CommandContext(ctx, m.Engine, args...)
		cmd.Stderr = &stderr
		out, err := cmd.Output()
		if err != nil {
			_ = os.RemoveAll(root)
			return nil, fmt.Errorf("コンテナを起動できません（%s）：%s", m.Image, strings.TrimSpace(stderr.String()))
		}
		w.container = name
		_ = out
	}
	return w, nil
}

func shortID(id string) string {
	id = strings.ReplaceAll(id, "-", "")
	if len(id) > 12 {
		return id[:12]
	}
	return id
}

const launcher = `if command -v bash >/dev/null 2>&1; then exec bash --noprofile --norc -eo pipefail "$0"; else exec sh -e "$0"; fi`

// Command は台本 script を作業場所で実行するコマンドを作る。env は手順の環境変数（秘密情報を含む）。
// 秘密情報をコマンドの引数に載せないよう、値は常に環境変数で渡す。
func (w *Workspace) Command(script, dir string, env map[string]string) *exec.Cmd {
	keys := make([]string, 0, len(env))
	for k := range env {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	merged := map[string]string{}
	if w.Mode != "container" {
		for _, kv := range os.Environ() {
			if k, v, ok := strings.Cut(kv, "="); ok {
				merged[k] = v
			}
		}
	}
	for _, k := range keys {
		merged[k] = env[k]
	}
	envList := make([]string, 0, len(merged))
	for k, v := range merged {
		envList = append(envList, k+"="+v)
	}
	sort.Strings(envList)
	var cmd *exec.Cmd
	if w.Mode == "container" {
		args := []string{"exec", "-w", dir}
		for _, k := range keys {
			args = append(args, "-e", k) // 値はこのコマンドの環境変数から渡る
		}
		args = append(args, w.container, "sh", "-c", launcher, script)
		cmd = exec.Command(w.engine, args...)
		cmd.Env = append(os.Environ(), envList...)
	} else {
		cmd = exec.Command("sh", "-c", launcher, script)
		cmd.Dir = dir
		cmd.Env = envList
	}
	return cmd
}

// HomeDir は手順から見た HOME（キャッシュの ~ の行き先）。コンテナでは作業場所の home、一時ディレクトリでは利用者の HOME。
func (w *Workspace) HomeDir() string {
	if w.Mode == "container" {
		return w.Home
	}
	if h, err := os.UserHomeDir(); err == nil {
		return h
	}
	return w.Home
}

// Run はコマンドを実行し、終了コードを返す。ctx が終わったら子プロセスまで止める。
func (w *Workspace) Run(ctx context.Context, cmd *exec.Cmd) (int, error) {
	code, err := w.Group.Run(ctx, cmd)
	if err != nil && ctx.Err() != nil && w.Mode == "container" {
		// コンテナの中のプロセスは docker exec を止めても残るため、コンテナごと止める
		w.stopContainer()
	}
	return code, err
}

func (w *Workspace) stopContainer() {
	if w.container == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	_ = exec.CommandContext(ctx, w.engine, "rm", "-f", w.container).Run()
	w.container = ""
}

// Close はジョブのすべてのプロセスを止め、作業場所を消す。
func (w *Workspace) Close() error {
	w.stopContainer()
	w.Group.KillAll()
	m := &Manager{Mode: w.Mode, Engine: w.engine, Image: w.image}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	m.remove(ctx, w.Root)
	if _, err := os.Stat(w.Root); err == nil {
		return fmt.Errorf("作業場所を消せません：%s", w.Root)
	}
	return nil
}

// remove は作業場所を消す。書き込み禁止のファイルや、コンテナが別の利用者で作ったファイルがあっても消す。
func (m *Manager) remove(ctx context.Context, root string) {
	if err := os.RemoveAll(root); err == nil {
		return
	}
	// 書き込み禁止のディレクトリ（Go のモジュールキャッシュなど）
	_ = filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err == nil && d.IsDir() {
			_ = os.Chmod(p, 0o700)
		}
		return nil
	})
	if err := os.RemoveAll(root); err == nil {
		return
	}
	if m.Mode == "container" && m.Engine != "" && m.Image != "" {
		_ = exec.CommandContext(ctx, m.Engine, "run", "--rm", "--user", "0", "-v", root+":/x", "--entrypoint", "sh", m.Image, "-c", "rm -rf /x/* /x/.[!.]* 2>/dev/null; true").Run()
		_ = os.RemoveAll(root)
	}
}
