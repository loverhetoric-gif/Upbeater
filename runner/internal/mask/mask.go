// Package mask はログから秘密情報を伏せる。Hub（hub/src/secrets.ts）と同じ変形を伏せる。
// 値そのもの・base64（標準・URL 用・末尾の = なし・改行つき）・長い base64 の途中に埋まった部分・
// URL 符号化・JSON の文字列・16 進。
package mask

import (
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"sort"
	"strings"
	"sync"
	"unicode/utf8"
)

// Placeholder は伏せた所に入れる文字列（Hub と同じ）
const Placeholder = "***"

// Variants は伏せる文字列の一覧（長い順）。
func Variants(value string) []string {
	if utf8.RuneCountInString(value) < 3 {
		return nil
	}
	b := []byte(value)
	set := map[string]struct{}{}
	add := func(s string) { set[s] = struct{}{} }
	add(value)
	add(strings.TrimSpace(value))
	std := base64.StdEncoding.EncodeToString(b)
	add(std)
	add(strings.TrimRight(std, "="))
	add(base64.RawURLEncoding.EncodeToString(b))
	add(encodeURIComponent(value))
	add(jsonInner(value))
	add(hex.EncodeToString(b))
	add(strings.TrimRight(base64.StdEncoding.EncodeToString(append(append([]byte{}, b...), '\n')), "="))
	// 長い base64 の途中に埋まった場合：前置きの長さ（3 で割った余り）ごとに、値だけで決まる中ほどの部分
	for shift := 1; shift <= 2; shift++ {
		padded := make([]byte, shift+len(b))
		copy(padded[shift:], b)
		e := base64.StdEncoding.EncodeToString(padded)
		start := (shift*4 + 2) / 3 // ceil(shift*4/3)
		total := shift + len(b)
		end := total * 4 / 3
		if total%3 != 0 {
			end--
		}
		if end < start {
			end = start
		}
		core := e[start:end]
		if len(core) >= 6 {
			add(core)
			add(strings.NewReplacer("+", "-", "/", "_").Replace(core))
		}
	}
	{
		end := len(b) * 4 / 3
		if len(b)%3 != 0 {
			end--
		}
		if end >= 6 {
			add(std[:end])
		}
	}
	out := make([]string, 0, len(set))
	for s := range set {
		if utf8.RuneCountInString(s) >= 3 {
			out = append(out, s)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if len(out[i]) != len(out[j]) {
			return len(out[i]) > len(out[j])
		}
		return out[i] < out[j]
	})
	return out
}

// encodeURIComponent は JavaScript の encodeURIComponent と同じ符号化。
func encodeURIComponent(s string) string {
	var sb strings.Builder
	for _, c := range []byte(s) {
		if c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || strings.IndexByte("-_.!~*'()", c) >= 0 {
			sb.WriteByte(c)
		} else {
			fmt.Fprintf(&sb, "%%%02X", c)
		}
	}
	return sb.String()
}

// jsonInner は JSON.stringify(value) の前後の引用符を除いたもの。
func jsonInner(s string) string {
	var sb strings.Builder
	for _, r := range s {
		switch r {
		case '"':
			sb.WriteString(`\"`)
		case '\\':
			sb.WriteString(`\\`)
		case '\b':
			sb.WriteString(`\b`)
		case '\f':
			sb.WriteString(`\f`)
		case '\n':
			sb.WriteString(`\n`)
		case '\r':
			sb.WriteString(`\r`)
		case '\t':
			sb.WriteString(`\t`)
		default:
			if r < 0x20 {
				fmt.Fprintf(&sb, `\u%04x`, r)
			} else {
				sb.WriteRune(r)
			}
		}
	}
	return sb.String()
}

// Masker は文字列から秘密情報を伏せる。
type Masker struct {
	needles []string
	maxLen  int
}

// New は値の一覧から Masker を作る。
func New(values []string) *Masker {
	set := map[string]struct{}{}
	for _, v := range values {
		for _, n := range Variants(v) {
			set[n] = struct{}{}
		}
	}
	m := &Masker{}
	for n := range set {
		m.needles = append(m.needles, n)
		if len(n) > m.maxLen {
			m.maxLen = len(n)
		}
	}
	sort.Slice(m.needles, func(i, j int) bool { return len(m.needles[i]) > len(m.needles[j]) })
	return m
}

// Mask は伏せた文字列を返す。
func (m *Masker) Mask(s string) string {
	for _, n := range m.needles {
		if strings.Contains(s, n) {
			s = strings.ReplaceAll(s, n, Placeholder)
		}
	}
	return s
}

// MaxLen は伏せる文字列の最大の長さ（バイト）。
func (m *Masker) MaxLen() int { return m.maxLen }

// Stream は書き込まれた出力を伏せてから次へ渡す。
// 書き込みの境目で秘密情報が分かれても伏せられるよう、末尾の (最大の長さ - 1) バイトを次の書き込みまで持ち越す。
type Stream struct {
	mu    sync.Mutex
	m     *Masker
	carry []byte
	out   func(string)
}

// NewStream は out へ伏せた文字列を渡す Stream を作る。
func NewStream(m *Masker, out func(string)) *Stream { return &Stream{m: m, out: out} }

func (s *Stream) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.carry = append(s.carry, p...)
	hold := s.m.MaxLen() - 1
	if hold < 0 {
		hold = 0
	}
	// 文字の途中で切らない。不完全な末尾の文字も持ち越す
	valid := CompletePrefix(s.carry)
	masked := s.m.Mask(string(s.carry[:valid]))
	rest := s.carry[valid:]
	cut := len(masked) - hold
	for cut > 0 && cut < len(masked) && !utf8.RuneStart(masked[cut]) {
		cut--
	}
	if cut <= 0 {
		s.carry = append([]byte(masked), rest...)
		return len(p), nil
	}
	s.out(masked[:cut])
	s.carry = append([]byte(masked[cut:]), rest...)
	return len(p), nil
}

// CompletePrefix は、末尾の書きかけの文字（UTF-8 の途中）を除いた長さを返す。
func CompletePrefix(b []byte) int {
	for i := len(b) - 1; i >= 0 && i >= len(b)-utf8.UTFMax; i-- {
		if utf8.RuneStart(b[i]) {
			if !utf8.FullRune(b[i:]) {
				return i
			}
			break
		}
	}
	return len(b)
}

// Flush は持ち越した分も伏せて渡す（手順の終わりなどで呼ぶ）。
func (s *Stream) Flush() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.carry) == 0 {
		return
	}
	s.out(s.m.Mask(string(s.carry)))
	s.carry = nil
}

// Line は 1 行を書いて、すぐに渡す（Runner 自身の見出しなど）。
func (s *Stream) Line(text string) {
	s.Flush()
	s.mu.Lock()
	defer s.mu.Unlock()
	s.out(s.m.Mask(text) + "\n")
}
