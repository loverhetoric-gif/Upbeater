package mask

import (
	"encoding/base64"
	"encoding/hex"
	"net/url"
	"strings"
	"testing"
)

const secret = "s3cr3t-Value/with+chars=ok"

func TestMaskVariants(t *testing.T) {
	m := New([]string{secret})
	b := []byte(secret)
	cases := map[string]string{
		"そのもの":        "token=" + secret,
		"base64":      base64.StdEncoding.EncodeToString(b),
		"base64url":   base64.RawURLEncoding.EncodeToString(b),
		"URL 符号化":     url.QueryEscape(secret),
		"16 進":        hex.EncodeToString(b),
		"JSON":        `{"k":"` + strings.ReplaceAll(secret, "/", "/") + `"}`,
		"改行つき base64": base64.StdEncoding.EncodeToString(append(b, '\n')),
	}
	for name, text := range cases {
		got := m.Mask(text)
		if strings.Contains(got, secret) || got == text {
			t.Errorf("%s：伏せられていない：%q", name, got)
		}
	}
}

func TestMaskEmbeddedBase64(t *testing.T) {
	// 長い base64（例：設定ファイル全体を base64 にしたもの）の途中に埋まった値も伏せる
	m := New([]string{secret})
	for prefix := 0; prefix < 6; prefix++ {
		raw := strings.Repeat("x", prefix) + "user:" + secret + ":tail"
		enc := base64.StdEncoding.EncodeToString([]byte(raw))
		got := m.Mask(enc)
		if got == enc {
			t.Errorf("前置き %d：埋め込まれた base64 が伏せられていない", prefix)
		}
	}
}

func TestShortValuesIgnored(t *testing.T) {
	if len(Variants("ab")) != 0 {
		t.Fatal("2 文字以下は伏せない（誤って普通の文字を伏せないため）")
	}
}

func TestStreamAcrossWrites(t *testing.T) {
	m := New([]string{secret})
	var out strings.Builder
	s := NewStream(m, func(x string) { out.WriteString(x) })
	text := "前の行\nvalue=" + secret + " 後ろ。日本語も途中で切らない\n"
	// 1 バイトずつ書いても、境目で分かれた値を伏せる
	for i := 0; i < len(text); i++ {
		s.Write([]byte{text[i]})
	}
	s.Flush()
	got := out.String()
	if strings.Contains(got, secret) || !strings.Contains(got, "value=***") {
		t.Fatalf("書き込みの境目で分かれた値が伏せられていない：%q", got)
	}
	if !strings.Contains(got, "日本語も途中で切らない") {
		t.Fatalf("文字が壊れた：%q", got)
	}
}

func TestStreamNoSecretsPassesThrough(t *testing.T) {
	var out strings.Builder
	s := NewStream(New(nil), func(x string) { out.WriteString(x) })
	s.Write([]byte("abc"))
	if out.String() != "abc" {
		t.Fatalf("秘密情報が無ければ、そのまま渡す：%q", out.String())
	}
}
