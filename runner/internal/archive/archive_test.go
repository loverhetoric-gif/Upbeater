package archive

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"os"
	"path/filepath"
	"testing"
)

func TestRoundTrip(t *testing.T) {
	src := t.TempDir()
	os.MkdirAll(filepath.Join(src, "dist", "sub"), 0o755)
	os.WriteFile(filepath.Join(src, "dist", "a.txt"), []byte("A"), 0o644)
	os.WriteFile(filepath.Join(src, "dist", "sub", "b.sh"), []byte("B"), 0o755)
	os.Symlink("a.txt", filepath.Join(src, "dist", "link"))
	var buf bytes.Buffer
	n, err := Create(&buf, []Entry{{Name: "work/dist", Path: filepath.Join(src, "dist")}, {Name: "work/none", Path: filepath.Join(src, "none")}})
	if err != nil || n != 2 {
		t.Fatalf("まとめられない：%d %v", n, err)
	}
	dst := t.TempDir()
	if _, err := Extract(&buf, map[string]string{"work": dst}); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(filepath.Join(dst, "dist", "link"))
	st, _ := os.Stat(filepath.Join(dst, "dist", "sub", "b.sh"))
	if string(b) != "A" || st.Mode().Perm()&0o100 == 0 {
		t.Fatal("内容・リンク・実行権限が戻らない")
	}
}

func evil(t *testing.T, hdrs ...*tar.Header) *bytes.Buffer {
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for _, h := range hdrs {
		if h.Typeflag == tar.TypeReg {
			h.Size = 1
		}
		tw.WriteHeader(h)
		if h.Typeflag == tar.TypeReg {
			tw.Write([]byte("x"))
		}
	}
	tw.Close()
	gz.Close()
	return &buf
}

// 汚染の防止：置き場所の外へ書き出す書庫は拒否する
func TestRejectsEscapes(t *testing.T) {
	cases := map[string][]*tar.Header{
		"..":         {{Name: "work/../../evil", Typeflag: tar.TypeReg, Mode: 0o644}},
		"絶対パス":       {{Name: "/tmp/evil", Typeflag: tar.TypeReg, Mode: 0o644}},
		"外を指すリンク":    {{Name: "work/l", Typeflag: tar.TypeSymlink, Linkname: "/etc"}},
		"リンクを通した書込み": {{Name: "work/l", Typeflag: tar.TypeSymlink, Linkname: "."}, {Name: "work/l/../../x", Typeflag: tar.TypeReg, Mode: 0o644}},
		"知らない置き場所":   {{Name: "other/x", Typeflag: tar.TypeReg, Mode: 0o644}},
	}
	for name, hdrs := range cases {
		dst := t.TempDir()
		if _, err := Extract(evil(t, hdrs...), map[string]string{"work": dst}); err == nil {
			t.Errorf("%s：拒否されない", name)
		}
	}
}
