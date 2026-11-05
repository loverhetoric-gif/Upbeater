package expr

import "testing"

func TestEvaluateIf(t *testing.T) {
	vars := map[string]Value{"event": "push", "branch": "main", "matrix.os": "linux", "inputs.n": float64(3)}
	ok := Status{}
	failed := Status{AnyFailed: true}
	cases := []struct {
		src  string
		st   Status
		want bool
	}{
		{"", ok, true},
		{"", failed, false},
		{"event == 'push'", ok, true},
		{"event == 'PUSH'", ok, true}, // 文字列の比較は大文字小文字を区別しない
		{"${{ branch != 'main' }}", ok, false},
		{"event == 'push'", failed, false}, // 状態の関数が無ければ success() && 式
		{"failure()", failed, true},
		{"always()", failed, true},
		{"failure() && event == 'push'", failed, true},
		{"contains(matrix.os, 'LIN')", ok, true},
		{"startsWith(branch, 'ma') && endsWith(branch, 'in')", ok, true},
		{"inputs.n == 3", ok, true},
		{"!(event == 'push') || matrix.os == 'linux'", ok, true},
		{"unknown.var", ok, false},
		{"'it''s' == 'it''s'", ok, true},
	}
	for _, c := range cases {
		got, err := EvaluateIf(c.src, &Context{Vars: vars, Status: c.st})
		if err != nil {
			t.Fatalf("%q：%v", c.src, err)
		}
		if got != c.want {
			t.Errorf("%q：%v（期待 %v）", c.src, got, c.want)
		}
	}
}

func TestErrors(t *testing.T) {
	for _, src := range []string{"event ==", "foo()", "contains(a)", "'open", "a # b", "(a"} {
		if _, err := Compile(src); err == nil {
			t.Errorf("%q は誤りとして扱うべき", src)
		}
	}
}
