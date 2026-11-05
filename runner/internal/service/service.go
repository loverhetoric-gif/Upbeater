// Package service は Runner を常駐させる設定（macOS は launchd、Linux は systemd のユーザー単位）を作る。
package service

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

// Label は launchd の名前・systemd の単位名。
const (
	Label    = "com.upbeater.runner"
	UnitName = "upbeater-runner.service"
)

// Spec は常駐の設定に書く内容。
type Spec struct {
	Exe    string // 実行ファイルの絶対パス
	Config string // 設定ファイルの絶対パス
	Path   string // 手順から使う PATH（launchd・systemd の既定は短いため、登録時の PATH を引き継ぐ）
	LogDir string
}

func xmlEscape(s string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;").Replace(s)
}

// Launchd は macOS の LaunchAgent の plist。
func Launchd(s Spec) string {
	return fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>%s</string>
  <key>ProgramArguments</key>
  <array><string>%s</string><string>run</string><string>--config</string><string>%s</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>%s</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Standard</string>
  <key>StandardOutPath</key><string>%s</string>
  <key>StandardErrorPath</key><string>%s</string>
</dict>
</plist>
`, Label, xmlEscape(s.Exe), xmlEscape(s.Config), xmlEscape(s.Path), xmlEscape(filepath.Join(s.LogDir, "runner.log")), xmlEscape(filepath.Join(s.LogDir, "runner.log")))
}

func sdQuote(s string) string {
	if strings.ContainsAny(s, " \t\"'\\") {
		return strconv.Quote(s)
	}
	return s
}

// Systemd は Linux の systemd ユーザー単位。止める時はジョブの子プロセスごと止める（KillMode=control-group）。
func Systemd(s Spec) string {
	return fmt.Sprintf(`[Unit]
Description=Upbeater Runner（GitHub Actions の代替の実行環境）
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=%s run --config %s
Environment=%s
Restart=always
RestartSec=10
KillMode=control-group
TimeoutStopSec=60

[Install]
WantedBy=default.target
`, sdQuote(s.Exe), sdQuote(s.Config), sdQuote("PATH="+s.Path))
}

// Install は常駐の設定を書き、有効にする。dryRun なら書く内容と置き場所だけを返す。
func Install(s Spec, dryRun bool) (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	var path, body string
	var cmds [][]string
	switch runtime.GOOS {
	case "darwin":
		path = filepath.Join(home, "Library", "LaunchAgents", Label+".plist")
		body = Launchd(s)
		domain := "gui/" + strconv.Itoa(os.Getuid())
		cmds = [][]string{{"launchctl", "bootout", domain + "/" + Label}, {"launchctl", "bootstrap", domain, path}}
	case "linux":
		path = filepath.Join(home, ".config", "systemd", "user", UnitName)
		body = Systemd(s)
		cmds = [][]string{{"systemctl", "--user", "daemon-reload"}, {"systemctl", "--user", "enable", "--now", UnitName}}
	default:
		return "", fmt.Errorf("この OS（%s）の常駐には対応していません", runtime.GOOS)
	}
	if dryRun {
		return fmt.Sprintf("# %s\n%s", path, body), nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return "", err
	}
	if err := os.MkdirAll(s.LogDir, 0o700); err != nil {
		return "", err
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		return "", err
	}
	for i, c := range cmds {
		out, err := exec.Command(c[0], c[1:]...).CombinedOutput()
		// launchd の bootout は未登録なら失敗するが問題ない
		if err != nil && !(runtime.GOOS == "darwin" && i == 0) {
			return "", fmt.Errorf("%s が失敗しました：%s", strings.Join(c, " "), strings.TrimSpace(string(out)))
		}
	}
	msg := "常駐を設定しました：" + path
	if runtime.GOOS == "linux" {
		msg += "\nログアウト中も動かすには、一度だけ `loginctl enable-linger " + os.Getenv("USER") + "` を実行してください"
	}
	return msg, nil
}

// Uninstall は常駐をやめる。
func Uninstall() error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	switch runtime.GOOS {
	case "darwin":
		path := filepath.Join(home, "Library", "LaunchAgents", Label+".plist")
		_ = exec.Command("launchctl", "bootout", "gui/"+strconv.Itoa(os.Getuid())+"/"+Label).Run()
		return removeIfExists(path)
	case "linux":
		_ = exec.Command("systemctl", "--user", "disable", "--now", UnitName).Run()
		err := removeIfExists(filepath.Join(home, ".config", "systemd", "user", UnitName))
		_ = exec.Command("systemctl", "--user", "daemon-reload").Run()
		return err
	}
	return fmt.Errorf("この OS（%s）の常駐には対応していません", runtime.GOOS)
}

func removeIfExists(p string) error {
	if err := os.Remove(p); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}
