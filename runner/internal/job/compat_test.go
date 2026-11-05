package job

import (
	"strings"
	"testing"

	"github.com/loverhetoric-gif/Upbeater/runner/internal/hub"
)

// Actions の台本（GITHUB_OUTPUT・GITHUB_ENV・GITHUB_STEP_SUMMARY・GITHUB_SHA など）が、書き換えずに動く
func TestActionsCompat(t *testing.T) {
	e := setup(t)
	j := e.job("job-compat",
		hub.Step{Kind: "run", ID: "check", Run: `echo "ok=true" >> "$GITHUB_OUTPUT"
{ echo "note<<EOF"; echo "1行目"; echo "2行目"; echo "EOF"; } >> "$GITHUB_OUTPUT"
echo "GREETING=こんにちは" >> "$GITHUB_ENV"
echo "### まとめの見出し" >> "$GITHUB_STEP_SUMMARY"`},
		hub.Step{Kind: "run", If: "steps.check.outputs.ok == 'true'", Run: `echo "出力=${{ steps.check.outputs.ok }} 環境=$GREETING 合図=$GITHUB_EVENT_NAME sha=$GITHUB_SHA ref=$GITHUB_REF_NAME repo=$GITHUB_REPOSITORY CI=$CI 番号=$GITHUB_RUN_NUMBER 鍵=$FROM_SECRET"`},
		hub.Step{Kind: "run", If: "steps.check.outputs.ok == 'false'", Run: "echo 動いてはいけない; exit 1"},
		hub.Step{Kind: "run", ID: "soft", Run: "exit 3", ContinueOnError: true},
		hub.Step{Kind: "run", If: "steps.soft.outcome == 'failure' && steps.soft.conclusion == 'success'", Run: "echo 失敗しても続けた"},
		hub.Step{Kind: "run", If: "steps.check.outcome == 'success'", Run: `printf '%s' "${{ steps.check.outputs.note }}" | wc -l | tr -d ' ' | sed 's/^/改行の数=/'`},
	)
	j.Env["FROM_SECRET"] = "${{ secrets.TOKEN }}"
	r := e.exec(j)
	log := e.hub.Log("job-compat")
	if r.Conclusion != "success" {
		t.Fatalf("失敗：%+v\n%s", r, log)
	}
	for _, want := range []string{"出力=true", "環境=こんにちは", "合図=push", "sha=" + e.sha, "ref=main", "repo=acme/widget", "CI=true", "番号=1", "鍵=***", "まとめの見出し", "失敗しても続けた", "改行の数=1"} {
		if !strings.Contains(log, want) {
			t.Errorf("ログに %q がない\n%s", want, log)
		}
	}
	if strings.Contains(log, "動いてはいけない") || strings.Contains(log, secretValue) {
		t.Errorf("動いてはいけない手順が動いたか、秘密情報が出ている\n%s", log)
	}
}

func TestParseKV(t *testing.T) {
	kv, err := parseKV("a=1\nb=x=y\n\nc<<END\nl1\nl2\nEND\n")
	if err != nil || kv["a"] != "1" || kv["b"] != "x=y" || kv["c"] != "l1\nl2" {
		t.Fatalf("%v %v", kv, err)
	}
	if _, err := parseKV("c<<END\nl1\n"); err == nil {
		t.Fatal("終わりの無い複数行は誤りにするべき")
	}
	if _, err := parseKV("読めない行\n"); err == nil {
		t.Fatal("= の無い行は誤りにするべき")
	}
}

func TestCommonDir(t *testing.T) {
	d := t.TempDir()
	for _, c := range []struct {
		in   []string
		want string
	}{
		{[]string{d + "/a/b/x.apk"}, d + "/a/b"},
		{[]string{d + "/a/b/x", d + "/a/c/y"}, d + "/a"},
		{[]string{d + "/a/b/x", d + "/z"}, d},
	} {
		if got := commonDir(c.in); got != c.want {
			t.Errorf("commonDir(%v) = %s、期待は %s", c.in, got, c.want)
		}
	}
}
