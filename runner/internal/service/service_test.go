package service

import (
	"encoding/xml"
	"strings"
	"testing"
)

func TestLaunchdIsValidXML(t *testing.T) {
	s := Spec{Exe: "/Users/a b/bin/upbeater-runner", Config: "/Users/a b/c&d.json", Path: "/opt/homebrew/bin:/usr/bin", LogDir: "/tmp/logs"}
	body := Launchd(s)
	d := xml.NewDecoder(strings.NewReader(body))
	d.Strict = false
	for {
		if _, err := d.Token(); err != nil {
			if err.Error() == "EOF" {
				break
			}
			t.Fatalf("plist が XML として読めない：%v", err)
		}
	}
	for _, want := range []string{"<string>run</string>", "c&amp;d.json", "/opt/homebrew/bin", "<key>KeepAlive</key><true/>"} {
		if !strings.Contains(body, want) {
			t.Errorf("plist に %q がない", want)
		}
	}
}

func TestSystemdUnit(t *testing.T) {
	body := Systemd(Spec{Exe: "/home/u/bin/upbeater-runner", Config: "/home/u/.config/upbeater-runner/config.json", Path: "/usr/local/bin:/usr/bin"})
	for _, want := range []string{"ExecStart=/home/u/bin/upbeater-runner run --config /home/u/.config/upbeater-runner/config.json", "Restart=always", "KillMode=control-group", "Environment=PATH=/usr/local/bin:/usr/bin", "WantedBy=default.target"} {
		if !strings.Contains(body, want) {
			t.Errorf("単位に %q がない", want)
		}
	}
}
