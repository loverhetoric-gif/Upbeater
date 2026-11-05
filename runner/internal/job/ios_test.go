package job

import "testing"

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
