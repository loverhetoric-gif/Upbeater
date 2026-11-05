// Package config は Runner の設定（Hub の URL・Runner トークン・ラベル・隔離の方式）を保存する。
// トークンを含むため、ファイルは権限 600、置き場所のディレクトリは 700 にする。
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// Config は Runner の設定。
type Config struct {
	HubURL   string   `json:"hub_url"`
	RunnerID string   `json:"runner_id"`
	Token    string   `json:"token"`
	Name     string   `json:"name"`
	Labels   []string `json:"labels"`
	// Isolation は作業場所の隔離の方式："auto"（Linux はコンテナ、macOS は一時ディレクトリ）・"container"・"dir"
	Isolation string `json:"isolation,omitempty"`
	// ContainerEngine は docker・podman（空なら自動で探す）
	ContainerEngine string `json:"container_engine,omitempty"`
	// ContainerImage はコンテナで実行する時のイメージ
	ContainerImage string `json:"container_image,omitempty"`
	// StateDir は作業場所・保持中のログなどを置く所（空なら設定ファイルと同じ所）
	StateDir string `json:"state_dir,omitempty"`
}

// DefaultImage はコンテナの既定のイメージ。
const DefaultImage = "ubuntu:24.04"

// DefaultPath は設定ファイルの既定の置き場所。
func DefaultPath() (string, error) {
	if p := os.Getenv("UPBEATER_RUNNER_CONFIG"); p != "" {
		return p, nil
	}
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "upbeater-runner", "config.json"), nil
}

// DefaultLabels はこの OS の既定のラベル。
func DefaultLabels() []string {
	if runtime.GOOS == "darwin" {
		return []string{"macos"}
	}
	return []string{runtime.GOOS}
}

// ValidateHubURL は Hub の URL を確かめる。トークンを送るため https に限る（手元の試験用の localhost は除く）。
func ValidateHubURL(raw string) (string, error) {
	u, err := url.Parse(strings.TrimRight(raw, "/"))
	if err != nil || u.Host == "" {
		return "", fmt.Errorf("Hub の URL が正しくありません：%q", raw)
	}
	host := u.Hostname()
	local := host == "localhost" || host == "127.0.0.1" || host == "::1"
	if u.Scheme != "https" && !(u.Scheme == "http" && local) {
		return "", errors.New("Hub の URL は https:// で始めてください")
	}
	return u.String(), nil
}

// Load は設定を読む。権限が 600 より緩ければ 600 に直す。
func Load(path string) (*Config, error) {
	st, err := os.Stat(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, fmt.Errorf("設定がありません（%s）。先に register で登録してください", path)
		}
		return nil, err
	}
	if st.Mode().Perm()&0o077 != 0 {
		if err := os.Chmod(path, 0o600); err != nil {
			return nil, fmt.Errorf("設定ファイルの権限を 600 に直せません：%w", err)
		}
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var c Config
	if err := json.Unmarshal(b, &c); err != nil {
		return nil, fmt.Errorf("設定ファイルが壊れています（%s）：%w", path, err)
	}
	if c.Token == "" || c.HubURL == "" {
		return nil, fmt.Errorf("設定にトークンか Hub の URL がありません（%s）", path)
	}
	if c.StateDir == "" {
		c.StateDir = filepath.Dir(path)
	}
	return &c, nil
}

// Save は設定を権限 600 で保存する。途中で止まっても前の設定が壊れないよう、一時ファイルに書いてから置き換える。
func Save(path string, c *Config) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	_ = os.Chmod(dir, 0o700)
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, ".config-*.json")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if err := f.Chmod(0o600); err != nil {
		f.Close()
		return err
	}
	if _, err := f.Write(append(b, '\n')); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
