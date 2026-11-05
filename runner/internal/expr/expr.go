// Package expr は if の式（Hub の hub/src/workflow/expr.ts と同じ文法・意味）を評価する。
//
//	文字列 '…'、数値、true・false・null、識別子（event・branch・ref・sha・repo・actor・matrix.x・inputs.x など）
//	== != && || ! ( )、関数 success() failure() always() cancelled() contains(a, b) startsWith(a, b) endsWith(a, b)
//
// ${{ … }} で囲ってもよい。
package expr

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// Value は nil・string・float64・bool のいずれか。
type Value = any

// Status は、それまでの結果の集計。
type Status struct {
	AnyFailed    bool
	AnyCancelled bool
}

// Context は評価に使う値。
type Context struct {
	Vars   map[string]Value
	Status Status
}

// Error は式の誤り（Pos は元の文字列での位置）。
type Error struct {
	Msg string
	Pos int
}

func (e *Error) Error() string { return fmt.Sprintf("%s（%d 文字目）", e.Msg, e.Pos+1) }

type tok struct {
	t   string // str num id op lp rp comma
	v   string
	pos int
}

var (
	wrapRe   = regexp.MustCompile(`^\s*\$\{\{([\s\S]*)\}\}\s*$`)
	numRe    = regexp.MustCompile(`^-?\d+(\.\d+)?`)
	idRe     = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+)*`)
	statusRe = regexp.MustCompile(`\b(success|failure|always|cancelled)\s*\(`)
	funcs    = map[string]int{"success": 0, "failure": 0, "always": 0, "cancelled": 0, "contains": 2, "startsWith": 2, "endsWith": 2}
)

func unwrap(src string) (string, int) {
	if m := wrapRe.FindStringSubmatchIndex(src); m != nil {
		return src[m[2]:m[3]], m[2]
	}
	return src, 0
}

func tokenize(src string) ([]tok, error) {
	var out []tok
	i := 0
	for i < len(src) {
		c := src[i]
		switch {
		case c == ' ' || c == '\t' || c == '\n' || c == '\r':
			i++
		case c == '\'':
			j := i + 1
			var sb strings.Builder
			for {
				if j >= len(src) {
					return nil, &Error{"文字列が閉じていません", i}
				}
				if src[j] == '\'' {
					if j+1 < len(src) && src[j+1] == '\'' {
						sb.WriteByte('\'')
						j += 2
						continue
					}
					break
				}
				sb.WriteByte(src[j])
				j++
			}
			out = append(out, tok{"str", sb.String(), i})
			i = j + 1
		case i+1 < len(src) && (src[i:i+2] == "==" || src[i:i+2] == "!=" || src[i:i+2] == "&&" || src[i:i+2] == "||"):
			out = append(out, tok{"op", src[i : i+2], i})
			i += 2
		case c == '!':
			out = append(out, tok{"op", "!", i})
			i++
		case c == '(':
			out = append(out, tok{"lp", "(", i})
			i++
		case c == ')':
			out = append(out, tok{"rp", ")", i})
			i++
		case c == ',':
			out = append(out, tok{"comma", ",", i})
			i++
		default:
			if m := numRe.FindString(src[i:]); m != "" {
				out = append(out, tok{"num", m, i})
				i += len(m)
			} else if m := idRe.FindString(src[i:]); m != "" {
				out = append(out, tok{"id", m, i})
				i += len(m)
			} else {
				return nil, &Error{"使えない文字です：" + string(c), i}
			}
		}
	}
	return out, nil
}

type node struct {
	k    string // lit var not bin call
	v    Value
	name string
	op   string
	a, b *node
	args []*node
}

type parser struct {
	toks []tok
	p    int
}

func (ps *parser) peek() *tok {
	if ps.p < len(ps.toks) {
		return &ps.toks[ps.p]
	}
	return nil
}

func (ps *parser) primary() (*node, error) {
	k := ps.peek()
	if k == nil {
		return nil, &Error{"式が途中で終わっています", -1}
	}
	switch k.t {
	case "op":
		if k.v == "!" {
			ps.p++
			e, err := ps.primary()
			if err != nil {
				return nil, err
			}
			return &node{k: "not", a: e}, nil
		}
	case "lp":
		ps.p++
		e, err := ps.or()
		if err != nil {
			return nil, err
		}
		if n := ps.peek(); n == nil || n.t != "rp" {
			return nil, &Error{") が必要です", posOf(n)}
		}
		ps.p++
		return e, nil
	case "str":
		ps.p++
		return &node{k: "lit", v: k.v}, nil
	case "num":
		ps.p++
		f, _ := strconv.ParseFloat(k.v, 64)
		return &node{k: "lit", v: f}, nil
	case "id":
		ps.p++
		switch k.v {
		case "true", "false":
			return &node{k: "lit", v: k.v == "true"}, nil
		case "null":
			return &node{k: "lit", v: nil}, nil
		}
		if n := ps.peek(); n != nil && n.t == "lp" {
			want, ok := funcs[k.v]
			if !ok {
				return nil, &Error{"使えない関数です：" + k.v, k.pos}
			}
			ps.p++
			var args []*node
			if n := ps.peek(); n == nil || n.t != "rp" {
				a, err := ps.or()
				if err != nil {
					return nil, err
				}
				args = append(args, a)
				for n := ps.peek(); n != nil && n.t == "comma"; n = ps.peek() {
					ps.p++
					a, err := ps.or()
					if err != nil {
						return nil, err
					}
					args = append(args, a)
				}
			}
			if n := ps.peek(); n == nil || n.t != "rp" {
				return nil, &Error{") が必要です", posOf(n)}
			}
			ps.p++
			if len(args) != want {
				return nil, &Error{fmt.Sprintf("%s の引数は %d 個です", k.v, want), k.pos}
			}
			return &node{k: "call", name: k.v, args: args}, nil
		}
		return &node{k: "var", name: k.v}, nil
	}
	return nil, &Error{"思わぬ記号です：" + k.v, k.pos}
}

func posOf(t *tok) int {
	if t == nil {
		return -1
	}
	return t.pos
}

func (ps *parser) cmp() (*node, error) {
	a, err := ps.primary()
	if err != nil {
		return nil, err
	}
	for n := ps.peek(); n != nil && n.t == "op" && (n.v == "==" || n.v == "!="); n = ps.peek() {
		ps.p++
		b, err := ps.primary()
		if err != nil {
			return nil, err
		}
		a = &node{k: "bin", op: n.v, a: a, b: b}
	}
	return a, nil
}

func (ps *parser) and() (*node, error) {
	a, err := ps.cmp()
	if err != nil {
		return nil, err
	}
	for n := ps.peek(); n != nil && n.t == "op" && n.v == "&&"; n = ps.peek() {
		ps.p++
		b, err := ps.cmp()
		if err != nil {
			return nil, err
		}
		a = &node{k: "bin", op: "&&", a: a, b: b}
	}
	return a, nil
}

func (ps *parser) or() (*node, error) {
	a, err := ps.and()
	if err != nil {
		return nil, err
	}
	for n := ps.peek(); n != nil && n.t == "op" && n.v == "||"; n = ps.peek() {
		ps.p++
		b, err := ps.and()
		if err != nil {
			return nil, err
		}
		a = &node{k: "bin", op: "||", a: a, b: b}
	}
	return a, nil
}

// Compiled は構文を確かめた式。
type Compiled struct {
	n          *node
	usesStatus bool
}

// Compile は構文を確かめる。
func Compile(src string) (*Compiled, error) {
	text, offset := unwrap(src)
	fix := func(err error) error {
		if e, ok := err.(*Error); ok {
			if e.Pos < 0 {
				return &Error{e.Msg, offset + len(text)}
			}
			return &Error{e.Msg, offset + e.Pos}
		}
		return err
	}
	toks, err := tokenize(text)
	if err != nil {
		return nil, fix(err)
	}
	ps := &parser{toks: toks}
	n, err := ps.or()
	if err != nil {
		return nil, fix(err)
	}
	if ps.p < len(toks) {
		return nil, fix(&Error{"思わぬ記号です：" + toks[ps.p].v, toks[ps.p].pos})
	}
	return &Compiled{n: n, usesStatus: statusRe.MatchString(text)}, nil
}

// Truthy は真とみなすか（null・false・空文字・0 以外は真）。
func Truthy(v Value) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case string:
		return x != ""
	case float64:
		return x != 0
	}
	return true
}

// String は JavaScript の String() と同じ書き方で文字列にする（null は空文字）。
func String(v Value) string {
	switch x := v.(type) {
	case nil:
		return ""
	case bool:
		return strconv.FormatBool(x)
	case string:
		return x
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	}
	return fmt.Sprint(v)
}

func ev(n *node, c *Context) Value {
	switch n.k {
	case "lit":
		return n.v
	case "var":
		if v, ok := c.Vars[n.name]; ok {
			return v
		}
		return nil
	case "not":
		return !Truthy(ev(n.a, c))
	case "bin":
		switch n.op {
		case "&&":
			return Truthy(ev(n.a, c)) && Truthy(ev(n.b, c))
		case "||":
			return Truthy(ev(n.a, c)) || Truthy(ev(n.b, c))
		}
		a, b := ev(n.a, c), ev(n.b, c)
		var eq bool
		as, aok := a.(string)
		bs, bok := b.(string)
		if aok && bok {
			eq = strings.EqualFold(as, bs)
		} else {
			eq = a == b
		}
		if n.op == "==" {
			return eq
		}
		return !eq
	case "call":
		s := c.Status
		switch n.name {
		case "success":
			return !s.AnyFailed && !s.AnyCancelled
		case "failure":
			return s.AnyFailed
		case "always":
			return true
		case "cancelled":
			return s.AnyCancelled
		}
		a := strings.ToLower(String(ev(n.args[0], c)))
		b := strings.ToLower(String(ev(n.args[1], c)))
		switch n.name {
		case "contains":
			return strings.Contains(a, b)
		case "startsWith":
			return strings.HasPrefix(a, b)
		}
		return strings.HasSuffix(a, b)
	}
	return nil
}

// Eval は式の値を返す。
func (cp *Compiled) Eval(c *Context) Value { return ev(cp.n, c) }

// EvaluateIf は実行してよいかを返す。式が無ければ success() と同じ。
// 状態の関数を使わない式は、Actions と同じく success() && 式 とみなす。
func EvaluateIf(src string, c *Context) (bool, error) {
	if strings.TrimSpace(src) == "" {
		return !c.Status.AnyFailed && !c.Status.AnyCancelled, nil
	}
	cp, err := Compile(src)
	if err != nil {
		return false, err
	}
	if !cp.usesStatus && (c.Status.AnyFailed || c.Status.AnyCancelled) {
		return false, nil
	}
	return Truthy(cp.Eval(c)), nil
}
