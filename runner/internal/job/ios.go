package job

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"
)

// iOS の実機へのワイヤレス導入（組み込み部品 install-ios）。
// Mac とペアリング済みで、同じ Wi-Fi にいる iPhone・iPad に、Wi-Fi 越しに .app を入れる（xcrun devicectl）。
// 署名は Xcode の Apple ID（無料でもよい）で行う。無料の Apple ID の署名は 7 日で切れるため、定期実行で入れ直す。

// IOSDevice は devicectl が知っている実機。
type IOSDevice struct {
	ID        string // devicectl の識別子
	UDID      string
	Name      string
	Transport string // wired・localNetwork など
	Paired    bool
}

// devicectl は xcrun devicectl を実行する（テストで差し替える）。
var devicectl = func(ctx context.Context, args ...string) ([]byte, error) {
	return exec.CommandContext(ctx, "xcrun", append([]string{"devicectl"}, args...)...).CombinedOutput()
}

// parseDevices は devicectl list devices --json-output の中身から、ペアリング済みの iOS の実機を取り出す。
func parseDevices(b []byte) ([]IOSDevice, error) {
	var v struct {
		Result struct {
			Devices []struct {
				Identifier      string                                       `json:"identifier"`
				ConnectionProps struct{ PairingState, TransportType string } `json:"connectionProperties"`
				DeviceProps     struct{ Name string }                        `json:"deviceProperties"`
				HardwareProps   struct{ UDID, Platform, Reality string }     `json:"hardwareProperties"`
			} `json:"devices"`
		} `json:"result"`
	}
	if i := strings.IndexByte(string(b), '{'); i > 0 {
		b = b[i:]
	}
	if err := json.Unmarshal(b, &v); err != nil {
		return nil, fmt.Errorf("devicectl の出力を読めません：%w", err)
	}
	var out []IOSDevice
	for _, d := range v.Result.Devices {
		h := d.HardwareProps
		if h.Reality != "physical" || (h.Platform != "iOS" && h.Platform != "iPadOS") {
			continue
		}
		out = append(out, IOSDevice{ID: d.Identifier, UDID: h.UDID, Name: d.DeviceProps.Name, Transport: d.ConnectionProps.TransportType, Paired: d.ConnectionProps.PairingState == "paired"})
	}
	return out, nil
}

// pickDevices は導入先を選ぶ。want が空なら、ペアリング済みで届く（Wi-Fi か線でつながっている）すべての実機。
func pickDevices(all []IOSDevice, want []string) ([]IOSDevice, []string) {
	var out []IOSDevice
	var missing []string
	if len(want) == 0 {
		for _, d := range all {
			if d.Paired && d.Transport != "" {
				out = append(out, d)
			}
		}
		return out, nil
	}
	for _, w := range want {
		found := false
		for _, d := range all {
			if d.Paired && (strings.EqualFold(d.Name, w) || strings.EqualFold(d.UDID, w) || strings.EqualFold(d.ID, w)) {
				out = append(out, d)
				found = true
				break
			}
		}
		if !found {
			missing = append(missing, w)
		}
	}
	return out, missing
}

// installIOS は install-ios を実行する。with: app（.app のパス・必須）、device（名前か UDID。改行で複数。省くとペアリング済みのすべて）
func (r *runner) installIOS(ctx context.Context, with map[string]string) (int, error) {
	if runtime.GOOS != "darwin" {
		return -1, fmt.Errorf("install-ios は macOS の Runner でだけ使えます（runs-on: macos）")
	}
	if with["app"] == "" {
		return -1, fmt.Errorf("install-ios には app（.app のパス）が必要です")
	}
	app, err := r.inWork(with["app"])
	if err != nil {
		return -1, err
	}
	if st, err := os.Stat(app); err != nil || !st.IsDir() || !strings.HasSuffix(app, ".app") {
		return -1, fmt.Errorf("導入する .app がありません：%s", with["app"])
	}
	listFile := filepath.Join(r.ws.Tmp, "devices.json")
	lctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	out, err := devicectl(lctx, "list", "devices", "--json-output", listFile, "--timeout", "60")
	cancel()
	if err != nil {
		return -1, fmt.Errorf("実機の一覧を得られません（Xcode が要ります）：%s", strings.TrimSpace(lastLines(string(out), 3)))
	}
	b, err := os.ReadFile(listFile)
	if err != nil {
		return -1, err
	}
	all, err := parseDevices(b)
	if err != nil {
		return -1, err
	}
	targets, missing := pickDevices(all, lines(with["device"]))
	if len(missing) > 0 {
		return -1, fmt.Errorf("ペアリング済みの実機に %s がありません", strings.Join(missing, "・"))
	}
	if len(targets) == 0 {
		return -1, fmt.Errorf("ペアリング済みの iPhone・iPad が見つかりません。iPhone を Mac と同じ Wi-Fi につなぎ、一度 Xcode でペアリングしてください（Window → Devices and Simulators → Connect via network）")
	}
	failed := 0
	for _, d := range targets {
		r.line(fmt.Sprintf("%s（%s）に %s を入れます", d.Name, transportName(d.Transport), filepath.Base(app)))
		ictx, cancel := context.WithTimeout(ctx, 10*time.Minute)
		out, err := devicectl(ictx, "device", "install", "app", "--device", d.ID, app)
		cancel()
		if err != nil {
			failed++
			r.line(fmt.Sprintf("✕ %s に入れられません：%s", d.Name, installFailReason(string(out))))
			continue
		}
		r.line(fmt.Sprintf("✓ %s に入れました", d.Name))
	}
	if failed > 0 {
		return -1, fmt.Errorf("%d 台中 %d 台に入れられませんでした（理由は上の ✕ の行）", len(targets), failed)
	}
	return 0, nil
}

// installFailReason は devicectl の導入の失敗を、分かる理由に直す。分からなければ出力の終わりを返す。
func installFailReason(out string) string {
	switch {
	case strings.Contains(out, "MIFreeProfileValidatedAppTracker"):
		return "無料の Apple ID の署名で入れられるアプリは、1 台に 3 つまでです。すでに上限に達しています。使わないアプリを iPhone から消すと入れられます（" + strings.TrimSpace(lastLines(out, 2)) + "）"
	case strings.Contains(out, "0xe8008012") || strings.Contains(out, "cannot be installed on this device"):
		return "この端末は、アプリの署名の対象に入っていません。xcodebuild に -allowProvisioningDeviceRegistration と、この端末を -destination id=<UDID> で渡して一度組み立てると対象に加わります。入れる端末を絞るなら with の device で指定してください（" + strings.TrimSpace(lastLines(out, 2)) + "）"
	case strings.Contains(out, "ApplicationVerificationFailed"):
		return "iPhone が署名を受け入れませんでした。署名の期限切れか、この iPhone がプロファイルに入っていない可能性があります（" + strings.TrimSpace(lastLines(out, 2)) + "）"
	}
	return strings.TrimSpace(lastLines(out, 5))
}

func transportName(t string) string {
	switch t {
	case "localNetwork":
		return "Wi-Fi"
	case "wired":
		return "ケーブル"
	}
	return t
}

func lastLines(s string, n int) string {
	ls := strings.Split(strings.TrimSpace(s), "\n")
	if len(ls) > n {
		ls = ls[len(ls)-n:]
	}
	return strings.Join(ls, " / ")
}

var (
	teamOnce sync.Once
	teamID   string
	ouRe     = regexp.MustCompile(`OU\s*=\s*([A-Z0-9]{10})`)
)

// appleTeam は、この Mac の Apple Development の証明書のチーム ID（無料の Apple ID でもある）。
// 手順から $UPBEATER_APPLE_TEAM で使える（例 xcodebuild DEVELOPMENT_TEAM=$UPBEATER_APPLE_TEAM -allowProvisioningUpdates）
func appleTeam() string {
	if runtime.GOOS != "darwin" {
		return ""
	}
	teamOnce.Do(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		pem, err := exec.CommandContext(ctx, "security", "find-certificate", "-c", "Apple Development", "-p").Output()
		if err != nil || len(pem) == 0 {
			return
		}
		cmd := exec.CommandContext(ctx, "openssl", "x509", "-noout", "-subject")
		cmd.Stdin = strings.NewReader(string(pem))
		subj, err := cmd.Output()
		if err != nil {
			return
		}
		if m := ouRe.FindStringSubmatch(string(subj)); m != nil {
			teamID = m[1]
		}
	})
	return teamID
}
