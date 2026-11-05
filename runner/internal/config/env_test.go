package config

import "testing"

func TestFromEnv(t *testing.T) {
	t.Setenv("UPBEATER_RUNNER_TOKEN", "")
	if c, err := FromEnv(); c != nil || err != nil {
		t.Fatalf("トークンが無ければ nil：%v %v", c, err)
	}
	t.Setenv("UPBEATER_RUNNER_TOKEN", "upb_r_x")
	t.Setenv("UPBEATER_HUB_URL", "http://example.com")
	if _, err := FromEnv(); err == nil {
		t.Fatal("http の Hub は拒否する")
	}
	t.Setenv("UPBEATER_HUB_URL", "https://hub.example.com/")
	t.Setenv("UPBEATER_RUNNER_LABELS", "linux, large")
	c, err := FromEnv()
	if err != nil || c.HubURL != "https://hub.example.com" || c.Isolation != "dir" || len(c.Labels) != 2 || c.Labels[1] != "large" {
		t.Fatalf("設定が違う：%+v %v", c, err)
	}
}
