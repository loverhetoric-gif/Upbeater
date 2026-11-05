package job

import (
	"context"
	"testing"

	"github.com/loverhetoric-gif/Upbeater/runner/internal/logship"
)

func recoverAll(t *testing.T, e *env) {
	t.Helper()
	if left := logship.Recover(context.Background(), e.client, e.spool); left != 0 {
		t.Fatalf("送りきれていない：%d", left)
	}
}
