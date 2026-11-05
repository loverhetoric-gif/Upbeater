package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSaveIsPrivate(t *testing.T) {
	path := filepath.Join(t.TempDir(), "conf", "config.json")
	if err := Save(path, &Config{HubURL: "https://hub.example", Token: "upb_r_x", Labels: []string{"linux"}}); err != nil {
		t.Fatal(err)
	}
	st, _ := os.Stat(path)
	if st.Mode().Perm() != 0o600 {
		t.Fatalf("権限が 600 ではない：%v", st.Mode().Perm())
	}
	dst, _ := os.Stat(filepath.Dir(path))
	if dst.Mode().Perm() != 0o700 {
		t.Fatalf("ディレクトリの権限が 700 ではない：%v", dst.Mode().Perm())
	}
	// 緩い権限は読む時に直す
	os.Chmod(path, 0o644)
	c, err := Load(path)
	if err != nil || c.Token != "upb_r_x" {
		t.Fatalf("読めない：%v", err)
	}
	st, _ = os.Stat(path)
	if st.Mode().Perm() != 0o600 {
		t.Fatal("読む時に権限を 600 に直していない")
	}
	if c.StateDir != filepath.Dir(path) {
		t.Fatal("作業用の置き場所の既定は設定と同じ所")
	}
}

func TestValidateHubURL(t *testing.T) {
	for _, ok := range []string{"https://hub.example.com/", "http://127.0.0.1:8787"} {
		if _, err := ValidateHubURL(ok); err != nil {
			t.Errorf("%s は使えるべき：%v", ok, err)
		}
	}
	for _, ng := range []string{"http://hub.example.com", "hub.example.com", "ftp://x"} {
		if _, err := ValidateHubURL(ng); err == nil {
			t.Errorf("%s は使えないべき", ng)
		}
	}
}
