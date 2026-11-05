// Package agent は Runner の常駐の本体。Hub からジョブを取りに行き、1 件ずつ実行する。
package agent

import (
	"context"
	"fmt"
	"log"
	"math/rand/v2"
	"os"
	"path/filepath"
	"syscall"
	"time"

	"github.com/loverhetoric-gif/Upbeater/runner/internal/config"
	"github.com/loverhetoric-gif/Upbeater/runner/internal/hub"
	"github.com/loverhetoric-gif/Upbeater/runner/internal/job"
	"github.com/loverhetoric-gif/Upbeater/runner/internal/logship"
	"github.com/loverhetoric-gif/Upbeater/runner/internal/workspace"
)

// Agent は常駐の本体。
type Agent struct {
	Config  *config.Config
	Client  *hub.Client
	Version string
	Log     *log.Logger
	// PollInterval はジョブが無い時に取りに行く間隔
	PollInterval time.Duration
	// Once なら、ジョブを 1 件実行したら終わる（試験用）
	Once bool

	ws       *workspace.Manager
	modeNote string
}

// Paths は状態の置き場所。
func Paths(stateDir string) (work, spool, lock string) {
	return filepath.Join(stateDir, "work"), filepath.Join(stateDir, "spool"), filepath.Join(stateDir, "runner.lock")
}

// New は Agent を作る。
func New(cfg *config.Config, version string, logger *log.Logger) *Agent {
	return &Agent{Config: cfg, Client: hub.New(cfg.HubURL, cfg.Token), Version: version, Log: logger, PollInterval: 5 * time.Second}
}

// lock は同じ置き場所で Runner が二重に動かないようにする。
func lock(path string) (*os.File, error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		f.Close()
		return nil, fmt.Errorf("同じ置き場所（%s）で別の Runner が動いています", filepath.Dir(path))
	}
	return f, nil
}

// Run は ctx が終わるまでジョブを取りに行って実行する。
func (a *Agent) Run(ctx context.Context) error {
	cfg := a.Config
	if err := os.MkdirAll(cfg.StateDir, 0o700); err != nil {
		return err
	}
	workDir, spoolDir, lockPath := Paths(cfg.StateDir)
	lf, err := lock(lockPath)
	if err != nil {
		return err
	}
	defer lf.Close()

	mode, engine, note := workspace.Resolve(cfg.Isolation, cfg.ContainerEngine)
	image := cfg.ContainerImage
	if image == "" {
		image = config.DefaultImage
	}
	a.ws = &workspace.Manager{Base: workDir, Mode: mode, Engine: engine, Image: image, RunnerID: cfg.RunnerID}
	a.modeNote = note
	if mode == "container" {
		a.modeNote += "・イメージ " + image
	}
	a.Log.Printf("Upbeater Runner %s を起動しました（%s・ラベル %v）", a.Version, a.modeNote, cfg.Labels)

	// 前の実行の残骸を片付け、送りきれなかったログと終了の報告を送る
	if err := a.ws.Sweep(ctx); err != nil {
		a.Log.Printf("前の作業場所を片付けられません：%v", err)
	}
	if left := logship.Recover(ctx, a.Client, spoolDir); left > 0 {
		a.Log.Printf("送りきれていないログが %d 件あります（後で送ります）", left)
	}

	backoff := time.Second
	lastRecover := time.Now()
	for ctx.Err() == nil {
		if time.Since(lastRecover) > time.Minute {
			logship.Recover(ctx, a.Client, spoolDir)
			lastRecover = time.Now()
		}
		cctx, cancel := context.WithTimeout(ctx, 60*time.Second)
		j, err := a.Client.Claim(cctx, cfg.Labels)
		cancel()
		if err != nil {
			if ctx.Err() != nil {
				break
			}
			wait := backoff
			if he, ok := err.(*hub.Error); ok && he.RetryAfter > 0 {
				wait = he.RetryAfter
			}
			if hub.IsUnauthorized(err) {
				a.Log.Printf("Runner のトークンが無効です。登録し直してください（register）。1 分後にもう一度試します")
				wait = time.Minute
			} else {
				a.Log.Printf("ジョブを受け取れません（%v）。%s 後にもう一度試します", err, wait.Round(time.Second))
				backoff = min(backoff*2, time.Minute)
			}
			sleep(ctx, wait)
			continue
		}
		backoff = time.Second
		if j == nil {
			sleep(ctx, jitter(a.PollInterval))
			continue
		}
		a.Log.Printf("ジョブ %s（%s・試行 %d）を始めます", j.Job.ID, j.Job.JobKey, j.Job.Attempt)
		res := job.Run(ctx, job.Options{Client: a.Client, Workspaces: a.ws, SpoolDir: spoolDir, Version: a.Version, ModeNote: a.modeNote}, j)
		switch {
		case res.Stale:
			a.Log.Printf("ジョブ %s は別の実行に移ったため、報告しませんでした", j.Job.ID)
		case res.Conclusion == "":
			a.Log.Printf("ジョブ %s：Runner の停止で中断しました", j.Job.ID)
		case !res.Reported:
			a.Log.Printf("ジョブ %s：%s（Hub に届かないため、後で報告します）", j.Job.ID, res.Conclusion)
		default:
			a.Log.Printf("ジョブ %s：%s %s", j.Job.ID, res.Conclusion, res.Reason)
		}
		if a.Once {
			return nil
		}
	}
	return nil
}

func jitter(d time.Duration) time.Duration {
	return d + time.Duration(rand.Int64N(int64(d/2)+1))
}

func sleep(ctx context.Context, d time.Duration) {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
	case <-t.C:
	}
}
