package job

import (
	"strings"
	"testing"
)

const devicesJSON = `ignored {"result":{"devices":[
 {"identifier":"A","connectionProperties":{"pairingState":"paired","transportType":"localNetwork"},"deviceProperties":{"name":"iPhone"},"hardwareProperties":{"udid":"U1","platform":"iOS","reality":"physical"}},
 {"identifier":"B","connectionProperties":{"pairingState":"paired","transportType":""},"deviceProperties":{"name":"古い iPad"},"hardwareProperties":{"udid":"U2","platform":"iOS","reality":"physical"}},
 {"identifier":"C","connectionProperties":{"pairingState":"unpaired","transportType":"wired"},"deviceProperties":{"name":"他人"},"hardwareProperties":{"udid":"U3","platform":"iOS","reality":"physical"}},
 {"identifier":"S","connectionProperties":{"pairingState":"paired","transportType":"sameMachine"},"deviceProperties":{"name":"シミュレータ"},"hardwareProperties":{"udid":"S","platform":"iOS","reality":"simulated"}}
]}}`

func TestPickIOSDevices(t *testing.T) {
	all, err := parseDevices([]byte(devicesJSON))
	if err != nil || len(all) != 3 {
		t.Fatalf("実機だけを読む：%v %v", all, err)
	}
	got, _ := pickDevices(all, nil)
	if len(got) != 1 || got[0].ID != "A" {
		t.Fatalf("届くペアリング済みの実機だけを選ぶ：%v", got)
	}
	got, missing := pickDevices(all, []string{"u2", "他人", "無い"})
	if len(got) != 1 || got[0].ID != "B" || len(missing) != 2 {
		t.Fatalf("名前・UDID で選び、ペアリングしていないものは選ばない：%v %v", got, missing)
	}
}

func TestInstallFailReason(t *testing.T) {
	free := "ERROR: (MIInstallerErrorDomain error 13) LegacyErrorString = ApplicationVerificationFailed\nFunctionName = -[MIFreeProfileValidatedAppTracker _onQueue_addReferenceForApplicationIdentifier:bundle:error:]"
	if r := installFailReason(free); !strings.Contains(r, "3 つまで") {
		t.Fatalf("無料の上限を説明していません：%s", r)
	}
	if r := installFailReason("LegacyErrorString = ApplicationVerificationFailed"); !strings.Contains(r, "署名を受け入れません") {
		t.Fatalf("署名の失敗を説明していません：%s", r)
	}
	if r := installFailReason("Failed to install embedded profile : 0xe8008012 (This provisioning profile cannot be installed on this device.)"); !strings.Contains(r, "署名の対象に入っていません") {
		t.Fatalf("端末が署名の対象外であることを説明していません：%s", r)
	}
	if r := installFailReason("a\nb"); r != "a / b" {
		t.Fatalf("知らない失敗はそのまま返す：%s", r)
	}
}
