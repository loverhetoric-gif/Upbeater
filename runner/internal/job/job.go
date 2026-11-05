// Package job は受け取ったジョブを 1 件実行する。
//
//	作業場所を作る → リポジトリを取得（認証のヘッダーは git にだけ渡す）→ 手順を順に実行 → 成果物・キャッシュの保存
//	→ 作業場所を消す（子プロセスまで止める）→ ログを送りきる → 終了の報告
//
// 実行中は心拍を送り、Hub が中断を指示したら（取り消し・時間超過）止める。ジョブの時間超過は Runner でも数える。
package job

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/loverhetoric-gif/Upbeater/runner/internal/expr"
	"github.com/loverhetoric-gif/Upbeater/runner/internal/hub"
	"github.com/loverhetoric-gif/Upbeater/runner/internal/logship"
	"github.com/loverhetoric-gif/Upbeater/runner/internal/mask"
	"github.com/loverhetoric-gif/Upbeater/runner/internal/proc"
	"github.com/loverhetoric-gif/Upbeater/runner/internal/workspace"
)

// Options はジョブの実行に使うもの。
type Options struct {
	Client     *hub.Client
	Workspaces *workspace.Manager
	SpoolDir   string
	Version    string
	ModeNote   string
	// FinishTimeout はログを送りきり、終了を報告するまで待つ最大の時間
	FinishTimeout time.Duration
}

// Result はジョブの結果。
type Result struct {
	Conclusion string // success・failure・cancelled（Stale なら空）
	Reason     string
	Stale      bool // 別の実行に移ったため報告しなかった
	Reported   bool // Hub に終了を報告できた
}

// minute は時間の単位（テストで短くする）
var minute = time.Minute

var (
	errHubStop = errors.New("Hub の指示で中断しました")
	errStale   = errors.New("このジョブは別の実行に移りました")
	errTimeout = errors.New("時間超過")
)

type runner struct {
	opt     Options
	j       *hub.Job
	ws      *workspace.Workspace
	out     *mask.Stream
	ship    *logship.Shipper
	vars    map[string]expr.Value
	env     map[string]string
	gitAuth string
	marker  string
	// 成功した時にジョブの終わりで保存するキャッシュ
	saveCaches []cacheSpec
	hubReason  string
	hubCancel  bool
}

// Run はジョブを実行する。parent が終わったら（Runner の停止）、終了を報告せずに止める（Hub が心拍の途絶として扱う）。
func Run(parent context.Context, opt Options, j *hub.Job) Result {
	if opt.FinishTimeout == 0 {
		opt.FinishTimeout = 5 * time.Minute
	}
	r := &runner{opt: opt, j: j, gitAuth: j.Repo.AuthHeader, marker: j.Job.ID + "-" + randSuffix()}

	// 伏せる値：秘密情報と、取得用のトークン（ヘッダーそのものと中のトークン）
	values := make([]string, 0, len(j.Secrets)+2)
	for _, v := range j.Secrets {
		values = append(values, v)
	}
	values = append(values, authValues(j.Repo.AuthHeader)...)
	m := mask.New(values)

	ship, err := logship.New(opt.Client, opt.SpoolDir, j.Job.ID, j.Job.Attempt, j.JobToken)
	if err != nil {
		return r.reportNow(parent, "failure", "ログを手元に保存できません："+err.Error())
	}
	r.ship = ship
	r.out = mask.NewStream(m, ship.Write)
	shipCtx, stopShip := context.WithCancel(context.Background())
	shipDone := make(chan struct{})
	go func() { ship.Run(shipCtx); close(shipDone) }()

	timeout := time.Duration(j.Job.TimeoutMinutes) * minute
	if timeout <= 0 {
		timeout = 60 * minute
	}
	ctx, cancel := context.WithCancelCause(parent)
	defer cancel(nil)
	tctx, tcancel := context.WithTimeoutCause(ctx, timeout, errTimeout)
	defer tcancel()

	hbDone := make(chan struct{})
	go func() { r.heartbeat(tctx, cancel); close(hbDone) }()

	conclusion, reason := r.execute(tctx)
	cause := context.Cause(tctx)
	tcancel()
	<-hbDone
	switch {
	case errors.Is(cause, errStale):
		conclusion, reason = "", ""
	case errors.Is(cause, errHubStop):
		conclusion = "failure"
		if r.hubCancel {
			conclusion = "cancelled"
		}
		reason = "Hub の指示で中断しました"
		if r.hubReason != "" {
			reason += "（" + r.hubReason + "）"
		}
	case errors.Is(cause, errTimeout):
		conclusion, reason = "failure", fmt.Sprintf("時間超過（%d 分）のため打ち切りました", int(timeout/minute))
	case parent.Err() != nil:
		conclusion, reason = "", "Runner が停止したため中断しました"
	}
	if conclusion != "" || reason != "" {
		r.line("")
		if conclusion == "success" {
			r.line("■ 結果：成功")
		} else if reason != "" {
			r.line("■ 結果：" + map[string]string{"failure": "失敗", "cancelled": "取り消し", "": "中断"}[conclusion] + "（" + reason + "）")
		}
	}
	// 作業場所を消す（ジョブのプロセスをすべて止めてから）
	if r.ws != nil {
		if err := r.ws.Close(); err != nil {
			r.line("注意：" + err.Error())
		}
	}
	r.out.Flush()

	res := Result{Conclusion: conclusion, Reason: reason}
	fctx, fcancel := context.WithTimeout(context.Background(), opt.FinishTimeout)
	defer fcancel()
	if errors.Is(cause, errStale) {
		stopShip()
		<-shipDone
		ship.Discard()
		res.Stale = true
		return res
	}
	stopShip()
	<-shipDone
	last := ship.Flush(fctx)
	if conclusion == "" {
		// Runner の停止：報告せず、送りきれなかったログは次の起動で送る
		ship.Finish()
		return res
	}
	res.Reported = r.complete(fctx, conclusion, reason, last)
	if !res.Reported && !ship.Stale() {
		ship.SetCompletion(&logship.Completion{Conclusion: conclusion, Reason: reason})
	}
	if ship.Stale() {
		res.Stale = true
	}
	ship.Finish()
	return res
}

// reportNow は実行を始める前の失敗を報告する。
func (r *runner) reportNow(ctx context.Context, conclusion, reason string) Result {
	_, err := r.opt.Client.Complete(ctx, r.j.Job.ID, r.j.JobToken, conclusion, reason, 0)
	return Result{Conclusion: conclusion, Reason: reason, Reported: err == nil}
}

// complete は終了を報告する。欠けたログがあれば送り直してもう一度確かめる。
func (r *runner) complete(ctx context.Context, conclusion, reason string, last int) bool {
	backoff := time.Second
	for attempt := 0; ; attempt++ {
		res, err := r.opt.Client.Complete(ctx, r.j.Job.ID, r.j.JobToken, conclusion, reason, last)
		if err == nil {
			if len(res.Missing) > 0 && attempt < 5 {
				r.ship.Resend(res.Missing)
				r.ship.Flush(ctx)
				continue
			}
			return true
		}
		if hub.IsStale(err) || !hub.Retryable(err) {
			return false
		}
		select {
		case <-ctx.Done():
			return false
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, 30*time.Second)
	}
}

// heartbeat は心拍を送る。Hub が中断を指示したら（continue: false）、ジョブを止める。
func (r *runner) heartbeat(ctx context.Context, cancel context.CancelCauseFunc) {
	interval := time.Duration(r.j.HeartbeatIntervalMS) * time.Millisecond
	if interval <= 0 {
		interval = 30 * time.Second
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		hctx, hcancel := context.WithTimeout(ctx, 20*time.Second)
		res, err := r.opt.Client.Heartbeat(hctx, r.j.Job.ID, r.j.JobToken)
		hcancel()
		switch {
		case err == nil && !res.Continue:
			r.hubCancel = res.Cancel || res.Status == "cancelled"
			r.hubReason = res.Reason
			cancel(errHubStop)
			return
		case hub.IsStale(err):
			cancel(errStale)
			return
		}
		// 通信の失敗は続ける（Hub が戻れば次の心拍で届く）
	}
}

func randSuffix() string { return fmt.Sprintf("%x", time.Now().UnixNano()) }

// authValues は取得用のヘッダーから伏せる値を取り出す。
func authValues(h string) []string {
	if h == "" {
		return nil
	}
	out := []string{h}
	if _, v, ok := strings.Cut(h, ":"); ok {
		v = strings.TrimSpace(v)
		out = append(out, v)
		if b64, ok := strings.CutPrefix(v, "Basic "); ok {
			out = append(out, b64)
			if raw, err := base64.StdEncoding.DecodeString(b64); err == nil {
				out = append(out, string(raw))
				if _, tok, ok := strings.Cut(string(raw), ":"); ok {
					out = append(out, tok)
				}
			}
		}
		if tok, ok := strings.CutPrefix(v, "Bearer "); ok {
			out = append(out, tok)
		}
	}
	return out
}

func (r *runner) line(s string) { r.out.Line(s) }

// execute は作業場所を作り、手順を実行して結論を返す。
func (r *runner) execute(ctx context.Context) (string, string) {
	j := r.j
	r.line(fmt.Sprintf("Upbeater Runner %s ／ ジョブ「%s」／ 実行 #%d・試行 %d", r.opt.Version, displayName(j), j.Job.RunNumber, j.Job.Attempt))
	r.line(fmt.Sprintf("リポジトリ %s ／ %s", j.Repo.FullName, short(j.Repo.SHA)))
	if r.opt.ModeNote != "" {
		r.line(r.opt.ModeNote)
	}
	if j.SecretsWithheld {
		r.line("フォークからの PR のため、秘密情報は渡していません")
	}
	ws, err := r.opt.Workspaces.Create(ctx, j.Job.ID, j.Job.Attempt, r.marker)
	if err != nil {
		return "failure", "作業場所を作れません：" + err.Error()
	}
	r.ws = ws
	r.vars = r.exprVars()
	r.env = r.baseEnv()

	if j.Cache != nil {
		cs := cacheSpec{Key: j.Cache.Key, Paths: j.Cache.Paths}
		hit, err := r.restoreCache(ctx, cs)
		if err != nil {
			r.line("注意：キャッシュを戻せません（続けます）：" + err.Error())
		}
		if !hit {
			r.saveCaches = append(r.saveCaches, cs)
		}
	}
	if !hasCheckout(j.Steps) {
		r.line("")
		r.line("▶ リポジトリの取得")
		if err := r.checkout(ctx, "", 1); err != nil {
			if ctx.Err() != nil {
				return "failure", ""
			}
			return "failure", "リポジトリを取得できません：" + err.Error()
		}
	}

	failed := false
	failReason := ""
	for i, st := range j.Steps {
		if ctx.Err() != nil {
			break
		}
		name := stepName(st)
		ok, err := expr.EvaluateIf(st.If, &expr.Context{Vars: r.vars, Status: expr.Status{AnyFailed: failed}})
		if err != nil {
			r.line(fmt.Sprintf("▶ 手順 %d：%s", i+1, name))
			r.line("if の式が正しくありません：" + err.Error())
			r.step(ctx, i, name, "failure", nil)
			failed, failReason = true, fmt.Sprintf("手順 %d「%s」の if の式が正しくありません", i+1, name)
			continue
		}
		if !ok {
			r.step(ctx, i, name, "skipped", nil)
			continue
		}
		r.line("")
		r.line(fmt.Sprintf("▶ 手順 %d：%s", i+1, name))
		r.step(ctx, i, name, "running", nil)
		start := time.Now()
		code, err := r.runStep(ctx, i, st)
		r.out.Flush()
		if ctx.Err() != nil {
			r.step(context.Background(), i, name, "cancelled", nil)
			break
		}
		if err != nil || code != 0 {
			msg := ""
			if err != nil {
				msg = err.Error()
			} else {
				msg = fmt.Sprintf("終了コード %d", code)
			}
			var ec *int
			if err == nil {
				ec = &code
			}
			r.step(ctx, i, name, "failure", ec)
			if st.ContinueOnError {
				r.line(fmt.Sprintf("✖ 失敗（%s）— continue-on-error のため続けます", msg))
				continue
			}
			r.line(fmt.Sprintf("✖ 失敗（%s）", msg))
			failed = true
			if failReason == "" {
				failReason = fmt.Sprintf("手順 %d「%s」が失敗しました（%s）", i+1, name, msg)
			}
			continue
		}
		zero := 0
		r.step(ctx, i, name, "success", &zero)
		r.line(fmt.Sprintf("✔ 成功（%s）", time.Since(start).Round(100*time.Millisecond)))
	}
	if ctx.Err() != nil {
		return "failure", ""
	}
	if failed {
		return "failure", failReason
	}
	// 成功した時だけ：ジョブの成果物とキャッシュを保存する
	for _, a := range j.Artifacts {
		r.line("")
		r.line("▶ 成果物の保存：" + a.Name)
		if err := r.uploadArtifact(ctx, a.Name, []string{a.Path}); err != nil {
			return "failure", "成果物「" + a.Name + "」を保存できません：" + err.Error()
		}
	}
	for _, cs := range r.saveCaches {
		if err := r.saveCache(ctx, cs); err != nil {
			r.line("注意：キャッシュを保存できません（結果には影響しません）：" + err.Error())
		}
	}
	return "success", ""
}

// step は手順の状態を Hub へ送る（届かなくても実行は止めない）。
func (r *runner) step(ctx context.Context, i int, name, status string, code *int) {
	for attempt := 0; attempt < 3; attempt++ {
		sctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
		err := r.opt.Client.StepStatus(sctx, r.j.Job.ID, r.j.JobToken, i, name, status, code)
		cancel()
		if err == nil || !hub.Retryable(err) {
			return
		}
		time.Sleep(time.Duration(attempt+1) * 500 * time.Millisecond)
	}
}

func displayName(j *hub.Job) string {
	if j.Job.Name != "" {
		return j.Job.Name
	}
	return j.Job.JobKey
}

func short(sha string) string {
	if len(sha) > 7 {
		return sha[:7]
	}
	return sha
}

func hasCheckout(steps []hub.Step) bool {
	for _, s := range steps {
		if s.Kind == "uses" && builtinName(s.Uses) == "checkout" {
			return true
		}
	}
	return false
}

func builtinName(uses string) string {
	base, _, _ := strings.Cut(uses, "@")
	// Actions の書き方（actions/checkout）も受け付ける
	if i := strings.LastIndex(base, "/"); i >= 0 {
		base = base[i+1:]
	}
	return base
}

func stepName(s hub.Step) string {
	if s.Name != "" {
		return s.Name
	}
	switch s.Kind {
	case "run":
		first, _, _ := strings.Cut(strings.TrimSpace(s.Run), "\n")
		if len([]rune(first)) > 80 {
			first = string([]rune(first)[:80]) + "…"
		}
		return first
	case "uses":
		return s.Uses
	case "distribute":
		return "配布（" + s.Platform + "）"
	}
	return s.Kind
}

// exprVars は式で使える値。
func (r *runner) exprVars() map[string]expr.Value {
	j := r.j
	v := map[string]expr.Value{
		"event": j.Event.Kind, "branch": j.Event.Branch, "ref": j.Repo.Ref, "sha": j.Repo.SHA,
		"repo": j.Repo.FullName, "actor": j.Event.Actor,
	}
	for k, x := range j.Job.Matrix {
		v["matrix."+k] = normalize(x)
	}
	for k, x := range j.Event.Inputs {
		v["inputs."+k] = normalize(x)
	}
	return v
}

func normalize(x any) expr.Value {
	switch t := x.(type) {
	case nil, string, bool, float64:
		return t
	case int:
		return float64(t)
	}
	return fmt.Sprint(x)
}

// baseEnv はすべての手順に渡す環境変数（ジョブの env・秘密情報・Upbeater の値）。
func (r *runner) baseEnv() map[string]string {
	env := map[string]string{}
	for k, v := range r.j.Env {
		env[k] = v
	}
	for k, v := range r.j.Secrets {
		env[k] = v
	}
	env["UPBEATER_WORKSPACE"] = r.ws.Work
	env["UPBEATER_JOB_ID"] = r.j.Job.ID
	env["UPBEATER_REPOSITORY"] = r.j.Repo.FullName
	env["TMPDIR"] = r.ws.Tmp
	env["RUNNER_TEMP"] = r.ws.Tmp
	env["GITHUB_WORKSPACE"] = r.ws.Work // Actions の台本との互換
	env[proc.MarkerEnv] = r.marker
	if r.ws.Mode == "container" {
		env["HOME"] = r.ws.Home
	}
	return env
}

var substRe = regexp.MustCompile(`\$\{\{\s*([\s\S]*?)\s*\}\}`)
var refRe = regexp.MustCompile(`^(secrets|env)\.([A-Za-z_][A-Za-z0-9_]*)$`)

// subst は ${{ … }} を置き換える。shell なら秘密情報と env は環境変数の参照にする（台本のファイルに値を書かない）。
func (r *runner) subst(s string, shell bool, env map[string]string) (string, error) {
	var firstErr error
	out := substRe.ReplaceAllStringFunc(s, func(m string) string {
		inner := strings.TrimSpace(substRe.FindStringSubmatch(m)[1])
		if ref := refRe.FindStringSubmatch(inner); ref != nil {
			if shell {
				return "${" + ref[2] + "}"
			}
			if ref[1] == "secrets" {
				return r.j.Secrets[ref[2]]
			}
			return env[ref[2]]
		}
		cp, err := expr.Compile(inner)
		if err != nil {
			if firstErr == nil {
				firstErr = fmt.Errorf("式 %s：%w", m, err)
			}
			return ""
		}
		return expr.String(cp.Eval(&expr.Context{Vars: r.vars}))
	})
	return out, firstErr
}

// stepEnv は手順の環境変数（基本の値に手順の env を重ねる）。
func (r *runner) stepEnv(st hub.Step) (map[string]string, error) {
	env := map[string]string{}
	for k, v := range r.env {
		env[k] = v
	}
	keys := make([]string, 0, len(st.Env))
	for k := range st.Env {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		v, err := r.subst(st.Env[k], false, env)
		if err != nil {
			return nil, err
		}
		env[k] = v
	}
	return env, nil
}

// inWork は作業場所の中の相対パスを実際のパスにする（外を指すものは拒否する）。
func (r *runner) inWork(rel string) (string, error) {
	p := filepath.Join(r.ws.Work, filepath.FromSlash(rel))
	if p != r.ws.Work && !strings.HasPrefix(p, r.ws.Work+string(filepath.Separator)) {
		return "", fmt.Errorf("作業場所の外は指定できません：%s", rel)
	}
	return p, nil
}

func (r *runner) runStep(ctx context.Context, i int, st hub.Step) (int, error) {
	if st.Timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, time.Duration(st.Timeout)*minute)
		defer cancel()
	}
	env, err := r.stepEnv(st)
	if err != nil {
		return -1, err
	}
	switch st.Kind {
	case "run":
		script, err := r.subst(st.Run, true, env)
		if err != nil {
			return -1, err
		}
		dir := r.ws.Work
		if st.WorkingDirectory != "" {
			wd, err := r.subst(st.WorkingDirectory, false, env)
			if err != nil {
				return -1, err
			}
			if dir, err = r.inWork(wd); err != nil {
				return -1, err
			}
		}
		code, err := r.shell(ctx, fmt.Sprintf("step-%d.sh", i+1), script, dir, env)
		if err != nil && ctx.Err() != nil && errors.Is(context.Cause(ctx), context.DeadlineExceeded) && st.Timeout > 0 {
			return -1, fmt.Errorf("手順の時間超過（%d 分）", st.Timeout)
		}
		return code, err
	case "uses":
		with := map[string]string{}
		for k, v := range st.With {
			s, err := r.subst(v, false, env)
			if err != nil {
				return -1, err
			}
			with[k] = s
		}
		return r.builtin(ctx, builtinName(st.Uses), with, env)
	case "distribute":
		return r.distribute(ctx, st.Platform, st.File)
	}
	return -1, fmt.Errorf("知らない種類の手順です：%s", st.Kind)
}

// shell は台本を作業場所で実行する。出力は伏せてからログへ送る。
func (r *runner) shell(ctx context.Context, name, script, dir string, env map[string]string) (int, error) {
	path := filepath.Join(r.ws.Tmp, name)
	if err := os.WriteFile(path, []byte(script+"\n"), 0o700); err != nil {
		return -1, err
	}
	cmd := r.ws.Command(path, dir, env)
	cmd.Stdout = r.out
	cmd.Stderr = r.out
	return r.ws.Run(ctx, cmd)
}
