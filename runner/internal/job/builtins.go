package job

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/loverhetoric-gif/Upbeater/runner/internal/archive"
	"github.com/loverhetoric-gif/Upbeater/runner/internal/hub"
)

// builtin は組み込み部品（hub/src/workflow/types.ts の BUILTIN_COMPONENTS）を実行する。
func (r *runner) builtin(ctx context.Context, name string, with, env map[string]string) (int, error) {
	switch name {
	case "checkout":
		depth := 1
		if d := with["fetch-depth"]; d != "" {
			n, err := strconv.Atoi(d)
			if err != nil || n < 0 {
				return -1, fmt.Errorf("fetch-depth は 0 以上の整数です：%s", d)
			}
			depth = n
		}
		return code(r.checkout(ctx, with["path"], depth))
	case "setup-node", "setup-java", "setup-go", "setup-python", "setup-flutter":
		return r.setupTool(ctx, name, with, env)
	case "cache":
		cs := cacheSpec{Key: with["key"], Paths: lines(with["path"])}
		if cs.Key == "" || len(cs.Paths) == 0 {
			return -1, fmt.Errorf("cache には key と path が必要です")
		}
		hit, err := r.restoreCache(ctx, cs)
		if err != nil {
			r.line("注意：キャッシュを戻せません（続けます）：" + err.Error())
		}
		if !hit {
			r.saveCaches = append(r.saveCaches, cs)
			r.line("ジョブが成功したら、終わりに保存します")
		}
		return 0, nil
	case "upload-artifact":
		n := with["name"]
		if n == "" {
			n = "artifact"
		}
		return code(r.uploadArtifact(ctx, n, lines(with["path"])))
	case "install-ios":
		return r.installIOS(ctx, with)
	case "download-artifact":
		n := with["name"]
		if n == "" {
			n = "artifact"
		}
		return code(r.downloadArtifact(ctx, n, with["path"]))
	}
	return -1, fmt.Errorf("組み込み部品「%s」はこの Runner にありません", name)
}

func code(err error) (int, error) {
	if err != nil {
		return -1, err
	}
	return 0, nil
}

func lines(s string) []string {
	var out []string
	for _, l := range strings.Split(s, "\n") {
		if l = strings.TrimSpace(l); l != "" {
			out = append(out, l)
		}
	}
	return out
}

// gitEnv は git にだけ渡す環境変数。認証のヘッダーは設定ファイルに書かず、このプロセスの間だけ有効にする。
func (r *runner) gitEnv() []string {
	env := []string{"GIT_TERMINAL_PROMPT=0", "GIT_ASKPASS=true"}
	for _, kv := range os.Environ() {
		if !strings.HasPrefix(kv, "GIT_CONFIG_") {
			env = append(env, kv)
		}
	}
	if r.gitAuth != "" {
		env = append(env, "GIT_CONFIG_COUNT=1", "GIT_CONFIG_KEY_0=http.extraHeader", "GIT_CONFIG_VALUE_0="+r.gitAuth)
	} else {
		env = append(env, "GIT_CONFIG_COUNT=0")
	}
	return env
}

func (r *runner) git(ctx context.Context, dir string, args ...string) error {
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = r.gitEnv()
	cmd.Stdout = r.out
	cmd.Stderr = r.out
	c, err := r.ws.Group.Run(ctx, cmd)
	if err != nil {
		return err
	}
	if c != 0 {
		return fmt.Errorf("git %s が終了コード %d で失敗しました", args[0], c)
	}
	return nil
}

// checkout はリポジトリを作業場所に取得する（git は Runner の端末で動かし、結果をコンテナと共有する）。
func (r *runner) checkout(ctx context.Context, sub string, depth int) error {
	dest := r.ws.Work
	if sub != "" {
		var err error
		if dest, err = r.inWork(sub); err != nil {
			return err
		}
	}
	if err := os.MkdirAll(dest, 0o755); err != nil {
		return err
	}
	j := r.j
	if j.Repo.CloneURL == "" || j.Repo.SHA == "" {
		return fmt.Errorf("取得先が Hub から渡されていません")
	}
	d := []string{}
	if depth > 0 {
		d = []string{"--depth", strconv.Itoa(depth)}
	}
	steps := [][]string{
		{"init", "-q"},
		{"remote", "add", "origin", j.Repo.CloneURL},
	}
	for _, s := range steps {
		if err := r.git(ctx, dest, s...); err != nil {
			return err
		}
	}
	// まずコミットを直接取りに行く。できない取得先なら、ブランチを取ってから目的のコミットに合わせる
	if err := r.git(ctx, dest, append(append([]string{"fetch", "-q", "--no-tags"}, d...), "origin", j.Repo.SHA)...); err != nil {
		if ctx.Err() != nil {
			return err
		}
		ref := j.Repo.Ref
		if ref == "" && j.Event.Branch != "" {
			ref = "refs/heads/" + j.Event.Branch
		}
		if ref == "" {
			return err
		}
		r.line("コミットを直接取得できないため、" + ref + " から取得します")
		if err := r.git(ctx, dest, "fetch", "-q", "--no-tags", "origin", ref); err != nil {
			return err
		}
		return r.git(ctx, dest, "checkout", "-q", "--detach", j.Repo.SHA)
	}
	return r.git(ctx, dest, "checkout", "-q", "--detach", "FETCH_HEAD")
}

var versionRe = regexp.MustCompile(`\d+(\.\d+)*`)

type tool struct {
	cmd  string
	keys []string
}

var tools = map[string]tool{
	"setup-node":    {"node --version", []string{"node-version"}},
	"setup-java":    {"java -version 2>&1", []string{"java-version"}},
	"setup-go":      {"go version", []string{"go-version"}},
	"setup-python":  {"python3 --version 2>&1 || python --version 2>&1", []string{"python-version"}},
	"setup-flutter": {"flutter --version 2>&1 | grep -m 1 '^Flutter '", []string{"flutter-version"}}, // 「新しい版があります」の案内が先に出ることがある
}

// setupTool は道具が入っていて、指定の版に合うかを確かめる（Runner の端末・コンテナに入れておく方式）。
func (r *runner) setupTool(ctx context.Context, name string, with, env map[string]string) (int, error) {
	t := tools[name]
	want := with["version"]
	for _, k := range t.keys {
		if with[k] != "" {
			want = with[k]
		}
	}
	bin := strings.Fields(t.cmd)[0]
	var buf bytes.Buffer
	script := fmt.Sprintf("if ! command -v %s >/dev/null 2>&1 && ! command -v python >/dev/null 2>&1; then echo '%s が見つかりません'; exit 127; fi\n%s", bin, bin, t.cmd)
	if name != "setup-python" {
		script = fmt.Sprintf("if ! command -v %s >/dev/null 2>&1; then echo '%s が見つかりません'; exit 127; fi\n%s", bin, bin, t.cmd)
	}
	path := filepath.Join(r.ws.Tmp, name+".sh")
	if err := os.WriteFile(path, []byte(script+"\n"), 0o700); err != nil {
		return -1, err
	}
	cmd := r.ws.Command(path, r.ws.Work, env)
	cmd.Stdout = io.MultiWriter(&buf, r.out)
	cmd.Stderr = cmd.Stdout
	c, err := r.ws.Run(ctx, cmd)
	if err != nil {
		return c, err
	}
	if c != 0 {
		return -1, fmt.Errorf("%s が見つかりません。Runner の端末（またはコンテナのイメージ）に入れてください", bin)
	}
	got := versionRe.FindString(strings.TrimPrefix(strings.TrimSpace(buf.String()), "v"))
	if !versionMatches(got, want) {
		return -1, fmt.Errorf("%s の版が合いません（入っている版 %s・指定 %s）。Runner の端末（またはコンテナのイメージ）に指定の版を入れてください", bin, got, want)
	}
	if want != "" {
		r.line(fmt.Sprintf("%s %s（指定 %s に合っています）", bin, got, want))
	}
	return 0, nil
}

// versionMatches は入っている版が指定に合うか。指定は 20・20.x・v20.11・>=18・lts/*・latest など。
func versionMatches(got, want string) bool {
	want = strings.TrimSpace(want)
	switch {
	case want == "", want == "latest", want == "stable", want == "*", strings.HasPrefix(want, "lts"), want == "node":
		return true
	case got == "":
		return false
	}
	if rest, ok := strings.CutPrefix(want, ">="); ok {
		return compareVersions(got, strings.TrimPrefix(strings.TrimSpace(rest), "v")) >= 0
	}
	want = strings.TrimLeft(want, "v^~= ")
	want = strings.TrimSuffix(strings.TrimSuffix(want, ".x"), ".*")
	if want == "" {
		return true
	}
	gp, wp := strings.Split(got, "."), strings.Split(want, ".")
	if len(wp) > len(gp) {
		return false
	}
	for i := range wp {
		if wp[i] != "x" && wp[i] != "*" && wp[i] != gp[i] {
			return false
		}
	}
	return true
}

func compareVersions(a, b string) int {
	ap, bp := strings.Split(a, "."), strings.Split(b, ".")
	for i := 0; i < max(len(ap), len(bp)); i++ {
		var x, y int
		if i < len(ap) {
			x, _ = strconv.Atoi(ap[i])
		}
		if i < len(bp) {
			y, _ = strconv.Atoi(bp[i])
		}
		if x != y {
			if x < y {
				return -1
			}
			return 1
		}
	}
	return 0
}

type cacheSpec struct {
	Key   string
	Paths []string
}

// cacheEntries はキャッシュの対象を書庫の名前に対応づける（~ は手順から見た HOME、それ以外は作業場所からの相対）。
func (r *runner) cacheEntries(paths []string) ([]archive.Entry, error) {
	var out []archive.Entry
	for _, p := range paths {
		switch {
		case p == "~" || strings.HasPrefix(p, "~/"):
			rel := filepath.Clean(strings.TrimPrefix(strings.TrimPrefix(p, "~"), "/"))
			if rel == ".." || strings.HasPrefix(rel, "../") {
				return nil, fmt.Errorf("キャッシュの対象が HOME の外です：%s", p)
			}
			out = append(out, archive.Entry{Name: filepath.ToSlash(filepath.Join("home", rel)), Path: filepath.Join(r.ws.HomeDir(), rel)})
		case filepath.IsAbs(p):
			return nil, fmt.Errorf("キャッシュの対象は作業場所からの相対か ~/ で始めてください：%s", p)
		default:
			abs, err := r.inWork(p)
			if err != nil {
				return nil, err
			}
			rel, _ := filepath.Rel(r.ws.Work, abs)
			out = append(out, archive.Entry{Name: filepath.ToSlash(filepath.Join("work", rel)), Path: abs})
		}
	}
	return out, nil
}

func (r *runner) restoreCache(ctx context.Context, cs cacheSpec) (bool, error) {
	if _, err := r.cacheEntries(cs.Paths); err != nil {
		return false, err
	}
	n, _, err := r.download(ctx, "cache", cs.Key, map[string]string{"work": r.ws.Work, "home": r.ws.HomeDir()}, "")
	if err != nil {
		return false, err
	}
	if n < 0 {
		r.line("キャッシュ「" + cs.Key + "」はまだありません")
		return false, nil
	}
	r.line(fmt.Sprintf("キャッシュ「%s」を戻しました（%d 個のファイル）", cs.Key, n))
	return true, nil
}

func (r *runner) saveCache(ctx context.Context, cs cacheSpec) error {
	entries, err := r.cacheEntries(cs.Paths)
	if err != nil {
		return err
	}
	n, err := r.upload(ctx, "cache", cs.Key, entries)
	if err != nil {
		var he *hub.Error
		if asHub(err, &he) && he.Status == 409 {
			r.line("キャッシュ「" + cs.Key + "」は別のジョブが保存済みです")
			return nil
		}
		return err
	}
	r.line(fmt.Sprintf("キャッシュ「%s」を保存しました（%d 個のファイル）", cs.Key, n))
	return nil
}

func (r *runner) uploadArtifact(ctx context.Context, name string, paths []string) error {
	if len(paths) == 0 {
		return fmt.Errorf("成果物の path がありません")
	}
	// Actions と同じく、指定したものに共通する一番近いフォルダを起点にする
	// （例：path が app/build/app.apk なら、取り出すと <取り出し先>/app.apk）
	abs := make([]string, 0, len(paths))
	for _, p := range paths {
		a, err := r.inWork(p)
		if err != nil {
			return err
		}
		abs = append(abs, a)
	}
	base := commonDir(abs)
	var entries []archive.Entry
	for _, a := range abs {
		rel, _ := filepath.Rel(base, a)
		entries = append(entries, archive.Entry{Name: filepath.ToSlash(filepath.Join("work", rel)), Path: a})
	}
	n, err := r.upload(ctx, "artifacts", name, entries)
	if err != nil {
		return err
	}
	r.line(fmt.Sprintf("成果物「%s」を保存しました（%d 個のファイル）", name, n))
	return nil
}

// commonDir は、パスの並びに共通する一番近いフォルダ（ファイルはそのフォルダ、フォルダはそれ自身で数える）。
func commonDir(paths []string) string {
	dirs := make([]string, len(paths))
	for i, p := range paths {
		if st, err := os.Stat(p); err == nil && st.IsDir() {
			dirs[i] = p
		} else {
			dirs[i] = filepath.Dir(p)
		}
	}
	base := dirs[0]
	for _, d := range dirs[1:] {
		for base != d && !strings.HasPrefix(d, base+string(filepath.Separator)) {
			parent := filepath.Dir(base)
			if parent == base {
				break
			}
			base = parent
		}
	}
	return base
}

func (r *runner) downloadArtifact(ctx context.Context, name, dest string) error {
	dir := r.ws.Work
	if dest != "" {
		var err error
		if dir, err = r.inWork(dest); err != nil {
			return err
		}
	}
	n, _, err := r.download(ctx, "artifacts", name, map[string]string{"work": dir}, dir)
	if err != nil {
		return err
	}
	if n < 0 {
		return fmt.Errorf("成果物「%s」がありません（同じ実行の、先に終わったジョブで保存してください）", name)
	}
	r.line(fmt.Sprintf("成果物「%s」を取り出しました（%d 個のファイル）", name, n))
	return nil
}

// distribute は配布するファイルを Hub に送る（署名したマニフェストの発行と端末への通知は Hub が行う）。
func (r *runner) distribute(ctx context.Context, platform, file string) (int, error) {
	abs, err := r.inWork(file)
	if err != nil {
		return -1, err
	}
	f, err := os.Open(abs)
	if err != nil {
		return -1, fmt.Errorf("配布するファイルがありません：%s", file)
	}
	defer f.Close()
	h := sha256.New()
	size, err := io.Copy(h, f)
	if err != nil {
		return -1, err
	}
	sum := hex.EncodeToString(h.Sum(nil))
	name := "distribute-" + platform
	if err := r.putWithRetry(ctx, "artifacts", name, abs, hub.BlobInfo{SHA256: sum, Format: "file", Filename: filepath.Base(abs), Size: size}); err != nil {
		return -1, err
	}
	r.line(fmt.Sprintf("配布するファイル %s（%d バイト・SHA-256 %s）を Hub に送りました", filepath.Base(abs), size, sum[:16]))
	return 0, nil
}

// upload は対象を tar.gz にまとめて送る。まとめたファイルの数を返す。
func (r *runner) upload(ctx context.Context, kind, name string, entries []archive.Entry) (int, error) {
	tmp, err := os.CreateTemp(r.ws.Tmp, "upload-*.tar.gz")
	if err != nil {
		return 0, err
	}
	defer os.Remove(tmp.Name())
	h := sha256.New()
	n, err := archive.Create(io.MultiWriter(tmp, h), entries)
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return 0, err
	}
	if n == 0 {
		return 0, fmt.Errorf("対象のファイルがありません")
	}
	st, err := os.Stat(tmp.Name())
	if err != nil {
		return 0, err
	}
	return n, r.putWithRetry(ctx, kind, name, tmp.Name(), hub.BlobInfo{SHA256: hex.EncodeToString(h.Sum(nil)), Format: "tar.gz", Size: st.Size()})
}

func (r *runner) putWithRetry(ctx context.Context, kind, name, path string, info hub.BlobInfo) error {
	var err error
	for attempt := 0; attempt < 4; attempt++ {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(time.Duration(1<<attempt) * time.Second):
			}
		}
		var f *os.File
		if f, err = os.Open(path); err != nil {
			return err
		}
		err = r.opt.Client.PutBlob(ctx, r.j.Job.ID, r.j.JobToken, kind, name, f, info)
		f.Close()
		if err == nil || !hub.Retryable(err) {
			return err
		}
	}
	return err
}

// download は取り出して SHA-256 を確かめてから展開する。無ければ -1 を返す。
func (r *runner) download(ctx context.Context, kind, name string, roots map[string]string, fileDir string) (int, *hub.BlobInfo, error) {
	body, info, err := r.opt.Client.GetBlob(ctx, r.j.Job.ID, r.j.JobToken, kind, name)
	if err != nil {
		return 0, nil, err
	}
	if body == nil {
		return -1, nil, nil
	}
	defer body.Close()
	tmp, err := os.CreateTemp(r.ws.Tmp, "download-*")
	if err != nil {
		return 0, nil, err
	}
	defer os.Remove(tmp.Name())
	h := sha256.New()
	_, err = io.Copy(io.MultiWriter(tmp, h), body)
	if err != nil {
		tmp.Close()
		return 0, nil, err
	}
	if got := hex.EncodeToString(h.Sum(nil)); info.SHA256 == "" || got != info.SHA256 {
		tmp.Close()
		return 0, nil, fmt.Errorf("SHA-256 が一致しません（壊れているか、書き換えられています）")
	}
	if _, err := tmp.Seek(0, 0); err != nil {
		tmp.Close()
		return 0, nil, err
	}
	defer tmp.Close()
	if info.Format == "file" {
		if fileDir == "" || info.Filename == "" || strings.ContainsAny(info.Filename, "/\\") || info.Filename == ".." {
			return 0, nil, fmt.Errorf("ファイル名が正しくありません")
		}
		if err := os.MkdirAll(fileDir, 0o755); err != nil {
			return 0, nil, err
		}
		out, err := os.Create(filepath.Join(fileDir, info.Filename))
		if err != nil {
			return 0, nil, err
		}
		_, err = io.Copy(out, tmp)
		out.Close()
		return 1, info, err
	}
	n, err := archive.Extract(tmp, roots)
	return n, info, err
}

func asHub(err error, target **hub.Error) bool {
	he, ok := err.(*hub.Error)
	if ok {
		*target = he
	}
	return ok
}
