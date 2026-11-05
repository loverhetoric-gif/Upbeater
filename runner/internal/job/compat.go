package job

// Actions の台本との互換：環境変数（GITHUB_SHA など）と、手順ごとのファイル
// （GITHUB_OUTPUT・GITHUB_ENV・GITHUB_PATH・GITHUB_STEP_SUMMARY）。
// 移行ツールで変換した定義が、台本を書き換えずに動くようにする（docs/DESIGN.md「移行ツール」）。

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"

	"github.com/loverhetoric-gif/Upbeater/runner/internal/expr"
)

// actionsEventName は Upbeater の合図の名前を Actions の名前にする（台本の $GITHUB_EVENT_NAME 用）。
func actionsEventName(kind string) string {
	if kind == "manual" {
		return "workflow_dispatch"
	}
	return kind
}

// compatEnv は Actions の台本が使う環境変数。
func (r *runner) compatEnv(env map[string]string) {
	j := r.j
	env["CI"] = "true"
	env["GITHUB_SHA"] = j.Repo.SHA
	env["GITHUB_REF"] = j.Repo.Ref
	name := j.Event.Branch
	if n, ok := strings.CutPrefix(j.Repo.Ref, "refs/heads/"); ok {
		name = n
	} else if n, ok := strings.CutPrefix(j.Repo.Ref, "refs/tags/"); ok {
		name = n
	}
	env["GITHUB_REF_NAME"] = name
	env["GITHUB_EVENT_NAME"] = actionsEventName(j.Event.Kind)
	env["GITHUB_REPOSITORY"] = j.Repo.FullName
	if owner, _, ok := strings.Cut(j.Repo.FullName, "/"); ok {
		env["GITHUB_REPOSITORY_OWNER"] = owner
	}
	env["GITHUB_ACTOR"] = j.Event.Actor
	env["GITHUB_RUN_NUMBER"] = strconv.Itoa(j.Job.RunNumber)
	env["GITHUB_RUN_ATTEMPT"] = strconv.Itoa(j.Job.Attempt)
	env["GITHUB_JOB"] = j.Job.JobKey
	env["RUNNER_OS"] = runnerOS()
}

func runnerOS() string {
	switch runtime.GOOS {
	case "darwin":
		return "macOS"
	case "linux":
		return "Linux"
	default:
		return runtime.GOOS
	}
}

// stepFiles は手順が書き込むファイル。
type stepFiles struct {
	output, env, path, summary string
}

func (r *runner) newStepFiles(i int) (stepFiles, error) {
	f := stepFiles{
		output:  filepath.Join(r.ws.Tmp, fmt.Sprintf("step-%d.output", i+1)),
		env:     filepath.Join(r.ws.Tmp, fmt.Sprintf("step-%d.env", i+1)),
		path:    filepath.Join(r.ws.Tmp, fmt.Sprintf("step-%d.path", i+1)),
		summary: filepath.Join(r.ws.Tmp, fmt.Sprintf("step-%d.summary", i+1)),
	}
	for _, p := range []string{f.output, f.env, f.path, f.summary} {
		if err := os.WriteFile(p, nil, 0o600); err != nil {
			return f, err
		}
	}
	return f, nil
}

func (f stepFiles) apply(env map[string]string) {
	env["GITHUB_OUTPUT"] = f.output
	env["GITHUB_ENV"] = f.env
	env["GITHUB_PATH"] = f.path
	env["GITHUB_STEP_SUMMARY"] = f.summary
}

// collect は手順が書いたファイルを読み、後の手順に引き継ぐ。
func (r *runner) collect(id string, f stepFiles) error {
	if b, err := os.ReadFile(f.output); err == nil && id != "" {
		kv, err := parseKV(string(b))
		if err != nil {
			return fmt.Errorf("GITHUB_OUTPUT：%w", err)
		}
		for k, v := range kv {
			r.vars["steps."+id+".outputs."+k] = expr.Value(v)
		}
	}
	if b, err := os.ReadFile(f.env); err == nil {
		kv, err := parseKV(string(b))
		if err != nil {
			return fmt.Errorf("GITHUB_ENV：%w", err)
		}
		for k, v := range kv {
			if k == "PATH" || strings.HasPrefix(k, "UPBEATER_") || k == "GITHUB_OUTPUT" || k == "GITHUB_ENV" || k == "GITHUB_PATH" || k == "GITHUB_STEP_SUMMARY" {
				continue
			}
			r.env[k] = v
		}
	}
	if b, err := os.ReadFile(f.path); err == nil {
		for _, p := range lines(string(b)) {
			if r.ws.Mode == "container" {
				r.line("注意：コンテナの中では GITHUB_PATH を使えません（無視しました）：" + p)
				continue
			}
			cur := r.env["PATH"]
			if cur == "" {
				cur = os.Getenv("PATH")
			}
			r.env["PATH"] = p + string(os.PathListSeparator) + cur
		}
	}
	if b, err := os.ReadFile(f.summary); err == nil && strings.TrimSpace(string(b)) != "" {
		r.line("── まとめ ──")
		for _, l := range strings.Split(strings.TrimRight(string(b), "\n"), "\n") {
			r.line(l)
		}
	}
	return nil
}

// setOutcome は steps.<id>.outcome・conclusion を記録する。
func (r *runner) setOutcome(id, outcome string, continueOnError bool) {
	if id == "" {
		return
	}
	r.vars["steps."+id+".outcome"] = expr.Value(outcome)
	conclusion := outcome
	if outcome == "failure" && continueOnError {
		conclusion = "success"
	}
	r.vars["steps."+id+".conclusion"] = expr.Value(conclusion)
}

// parseKV は「名前=値」と「名前<<区切り … 区切り」の並びを読む（Actions の GITHUB_OUTPUT・GITHUB_ENV の書式）。
func parseKV(s string) (map[string]string, error) {
	out := map[string]string{}
	ls := strings.Split(strings.ReplaceAll(s, "\r\n", "\n"), "\n")
	for i := 0; i < len(ls); i++ {
		l := ls[i]
		if strings.TrimSpace(l) == "" {
			continue
		}
		if k, delim, ok := strings.Cut(l, "<<"); ok && !strings.Contains(k, "=") {
			k = strings.TrimSpace(k)
			var buf []string
			closed := false
			for i++; i < len(ls); i++ {
				if ls[i] == delim {
					closed = true
					break
				}
				buf = append(buf, ls[i])
			}
			if !closed {
				return nil, fmt.Errorf("「%s<<%s」の終わり（%s）がありません", k, delim, delim)
			}
			out[k] = strings.Join(buf, "\n")
			continue
		}
		k, v, ok := strings.Cut(l, "=")
		if !ok || strings.TrimSpace(k) == "" {
			return nil, fmt.Errorf("読めない行です：%s", l)
		}
		out[strings.TrimSpace(k)] = v
	}
	return out, nil
}
