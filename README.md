# Upbeater

GitHub Actions の代替。設計は `docs/DESIGN.md`、現状は `docs/HANDOFF.md`。

| 部品 | 内容 |
| --- | --- |
| `hub/` | Cloudflare Workers：合図の受信・定義の解釈・待ち行列・ログ・GitHub への結果表示 |
| `runner/` | Go：macOS・Linux に常駐し、ジョブを使い捨ての作業場所で実行する |
| `app/` | Flutter：管理画面・端末への配布の受け手 |
