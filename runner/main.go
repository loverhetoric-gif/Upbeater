// Upbeater Runner：GitHub Actions の代替の実行環境（macOS・Linux）。
//
//	upbeater-runner register --hub https://hub.example.com --code ABCD-EFGH [--name 名前] [--labels linux,large]
//	upbeater-runner run                       常駐して Hub からジョブを取りに行く
//	upbeater-runner service install|uninstall|print
//	upbeater-runner version
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/loverhetoric-gif/Upbeater/runner/internal/agent"
	"github.com/loverhetoric-gif/Upbeater/runner/internal/config"
	"github.com/loverhetoric-gif/Upbeater/runner/internal/hub"
	"github.com/loverhetoric-gif/Upbeater/runner/internal/service"
)

// version はビルド時に -ldflags "-X main.version=…" で入れる。
var version = "dev"

const usage = `Upbeater Runner %s

使い方：
  upbeater-runner register --hub <Hub の URL> --code <登録コード> [--name 名前] [--labels linux,large]
      [--isolation auto|container|dir] [--image ubuntu:24.04] [--engine docker|podman]
  upbeater-runner run                     常駐して Hub からジョブを取りに行く
  upbeater-runner service install         常駐の設定（macOS は launchd、Linux は systemd）を入れる
  upbeater-runner service uninstall       常駐をやめる
  upbeater-runner service print           常駐の設定の内容を表示する（入れない）
  upbeater-runner version

どのコマンドも --config <設定ファイル> で設定の置き場所を変えられます。
`

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintf(os.Stderr, usage, version)
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "register":
		err = cmdRegister(os.Args[2:])
	case "run":
		err = cmdRun(os.Args[2:])
	case "service":
		err = cmdService(os.Args[2:])
	case "version", "--version", "-v":
		fmt.Println(version)
	case "help", "--help", "-h":
		fmt.Printf(usage, version)
	default:
		fmt.Fprintf(os.Stderr, "知らないコマンドです：%s\n\n"+usage, os.Args[1], version)
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "エラー："+err.Error())
		os.Exit(1)
	}
}

func configFlag(fs *flag.FlagSet) *string {
	def, _ := config.DefaultPath()
	return fs.String("config", def, "設定ファイル")
}

func cmdRegister(args []string) error {
	fs := flag.NewFlagSet("register", flag.ContinueOnError)
	cfgPath := configFlag(fs)
	hubURL := fs.String("hub", "", "Hub の URL（https://…）")
	code := fs.String("code", "", "一回限りの登録コード")
	host, _ := os.Hostname()
	name := fs.String("name", host, "Runner の名前")
	labels := fs.String("labels", strings.Join(config.DefaultLabels(), ","), "ラベル（, 区切り）")
	isolation := fs.String("isolation", "auto", "作業場所の隔離（auto・container・dir）")
	image := fs.String("image", config.DefaultImage, "コンテナのイメージ")
	engine := fs.String("engine", "", "コンテナの道具（docker・podman。空なら自動）")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *hubURL == "" || *code == "" {
		return errors.New("--hub と --code が必要です")
	}
	if *isolation != "auto" && *isolation != "container" && *isolation != "dir" {
		return errors.New("--isolation は auto・container・dir のどれかです")
	}
	base, err := config.ValidateHubURL(*hubURL)
	if err != nil {
		return err
	}
	var ls []string
	for _, l := range strings.Split(*labels, ",") {
		if l = strings.TrimSpace(l); l != "" {
			ls = append(ls, l)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	res, err := hub.New(base, "").Register(ctx, *code, *name, ls)
	if err != nil {
		return fmt.Errorf("登録できません：%w", err)
	}
	cfg := &config.Config{HubURL: base, RunnerID: res.RunnerID, Token: res.Token, Name: *name, Labels: res.Labels, Isolation: *isolation, ContainerImage: *image, ContainerEngine: *engine}
	if err := config.Save(*cfgPath, cfg); err != nil {
		return fmt.Errorf("設定を保存できません：%w", err)
	}
	fmt.Printf("登録しました（%s・ラベル %s）。設定：%s（権限 600）\n次に `upbeater-runner service install` で常駐させてください\n", *name, strings.Join(res.Labels, ","), *cfgPath)
	return nil
}

func cmdRun(args []string) error {
	fs := flag.NewFlagSet("run", flag.ContinueOnError)
	cfgPath := configFlag(fs)
	once := fs.Bool("once", false, "ジョブを 1 件実行したら終わる")
	if err := fs.Parse(args); err != nil {
		return err
	}
	cfg, err := config.Load(*cfgPath)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	a := agent.New(cfg, version, log.New(os.Stderr, "", log.LstdFlags))
	a.Once = *once
	return a.Run(ctx)
}

func cmdService(args []string) error {
	if len(args) < 1 {
		return errors.New("service の後に install・uninstall・print のどれかを指定してください")
	}
	fs := flag.NewFlagSet("service", flag.ContinueOnError)
	cfgPath := configFlag(fs)
	if err := fs.Parse(args[1:]); err != nil {
		return err
	}
	if args[0] == "uninstall" {
		if err := service.Uninstall(); err != nil {
			return err
		}
		fmt.Println("常駐をやめました")
		return nil
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	if exe, err = filepath.EvalSymlinks(exe); err != nil {
		return err
	}
	abs, err := filepath.Abs(*cfgPath)
	if err != nil {
		return err
	}
	if _, err := config.Load(abs); err != nil {
		return err
	}
	spec := service.Spec{Exe: exe, Config: abs, Path: os.Getenv("PATH"), LogDir: filepath.Join(filepath.Dir(abs), "logs")}
	switch args[0] {
	case "install", "print":
		msg, err := service.Install(spec, args[0] == "print")
		if err != nil {
			return err
		}
		fmt.Println(msg)
		return nil
	}
	return fmt.Errorf("知らない操作です：%s", args[0])
}
