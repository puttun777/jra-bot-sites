# HANDOFF — ChatGPT（Sites）への引き継ぎ

ChatGPT 側は **本書と docs/CHATGPT_DEPLOY_PROMPT.md だけ**を最初に読めば作業を始められる。既存の 3 リポジトリを再調査する必要はない（整理済み: CURRENT_SYSTEM・FEATURE_MATRIX・MIGRATION）。

## 1. システム概要
jra-bot（中央競馬のオッズから期待値の正の買い目を見つける私的な Bot）の後継。jra-bot-web（Kotlin）の業務仕様と画面を TypeScript に移し、ChatGPT Sites で動かす。
データは ChatGPT（MCP ツール）か手動（CSV/JSON）で登録し、判定（EV・Kelly・買い目）はサイトのプログラムが行う（生成 AI は使わない）。

## 2. 実装済み
- 判定ロジック（単勝・ワイド・三連複、確率、Kelly、見送り、急落フィルタ、hit_rate/edge、総投資上限）: 旧 Python とゴールデンで一致
- 開催カレンダー（版・状態遷移・履歴・鮮度・手動補正）、取込（正規化 JSON・保留→再適用・隔離・冪等）、判定の実行（リース・停止モード・未来情報の不使用）、紙上成績
- `/api/v1/*`（jra-bot-web と同じ DTO）+ 管理操作 + MCP ツール 14 個 + 画面（概要・シグナル・成績・運用、レース詳細・取得状況・手動実行・JSON 取込）
- ローカル開発サーバ・CLI（マイグレーション・合成データ・取込・CSV・判定・バックアップ・復元・エクスポート）・試験 109 件・CI

## 3. 既存機能との差分（要点。全体は FEATURE_MATRIX）
- 廃止: JV-Link 取得・Windows エージェント・AWS/GCP の基盤・常駐の監視ループ（30 秒間隔の発走直前監視は再現しない）
- 追加（2026-11-27）: JRA 公式サイトからの取得（開催日・出馬表・着順・払戻。オッズは未対応）、旧 SQLite の移行、過去日の再判定（バックテスト）、データ保持
- 保留: オッズの直接取得・Discord 送信（外部通信未確認）・ML 推論/学習・旧の決済表
- 変更: 予定の鮮度 18 時間（D-S07）、シグナルはサイト内表示 = 通知済み（D-S09）

## 4. 技術・ビルド・ローカル起動
- TypeScript 5.9（strict）・zod 4・esbuild 0.28・eslint 10（typescript-eslint）・Node 22.13 以上（ローカルは node:sqlite を使う）
```bash
npm ci --ignore-scripts
npm run typecheck && npm run lint && npm test     # 109 件
npm run build                                     # dist/src（Node）・dist/public（画面）・dist/sites/worker.js（Sites 用の束ね）
node dist/src/local/cli.js seed-demo              # 合成データ（実データではない）
npm start                                         # http://127.0.0.1:8787/（疑似ログイン owner@example.invalid）
```

## 5. Sites への載せ方（未検証。ChatGPT 側の作業）
**案 1（Worker ESM）**を採用。`npm run build:sites` で `dist/server/index.js` を生成する。Worker に組み込んだ既存 HTML/CSS/JS を配信し、`/api/*`・`/mcp` を既存ルーターにつなぐ。D1 は `env.DB` を使う。
- `.openai/hosting.json` に `d1: "DB"`、`r2: null`、`capabilities: ["mcp"]` を宣言する。`project_id` は Sites 側のソースで設定する。

## 6. DB の構築・マイグレーション
- `npm run build:sites` が `migrations/0001_baseline.sql` → `0002_ops_calendar_ingest_ml.sql` → `0003_sites.sql` の順に `dist/.openai/drizzle/` に同梱する。D1 の 50 バイト制限に合わせて、長い `GLOB` だけを成果物で同等の短い述語に分割する。公開済みの成果物を変更する場合は新しい番号のマイグレーションを追加する。
- 失敗した構文があれば DATABASE §2 の変換表の該当箇所だけを直し、新しい番号のファイルで追加する（適用済みのファイルは書き換えない）。
- 確認: `GET /healthz` → `{"ok":true}`、ログイン後 `GET /api/v1/status` が 200。

## 7. 必要な環境変数（Sites の設定・シークレット。Git に値を書かない。キーは .env.example）
| キー | 必須 | 内容 |
|---|---|---|
| `OWNER_EMAILS` | 必須 | 管理者（本人）のメール。カンマ区切り |
| `VIEWER_EMAILS` | 任意 | 閲覧者（もう 1 名）のメール |
| `INGEST_TOKEN` | 任意 | MCP・取込用のベアラートークン（32 文字以上のランダム値）。画面の「取込クライアントを追加」で発行したトークンでもよい |
| `DISCORD_WEBHOOK_URL` | 不要 | 未使用（外部通信の確認後に実装） |

## 8. 認証の設定（最重要の検証: E-1）
1. サイトの対象者を「本人（と指定の 1 名）」に限定する（公開しない）。
2. ログインして `/api/v1/me` が本人のメール・ADMIN を返すことを確認。
3. **別のブラウザ（未ログイン）から `curl -H "oai-authenticated-user-email: <本人のメール>" https://<site>/api/v1/me` を送り、401/403 になることを確認**。200 なら公開を止め、`src/api/auth.ts` の `authenticateUser` を Sites の正式な身元確認に置き換える。

## 9. MCP の登録（E-4）
- サーバ: `POST https://<site>/mcp`（JSON-RPC 2.0。`initialize`・`tools/list`・`tools/call`。SSE・セッションは使わない）
- 認証: Sites のプラグイン接続では Sites が渡す利用者の身元を受け、ADMIN の呼び出しを Worker 内で `INGEST_TOKEN` に接続する。外部の取込クライアントは、Sites のサービスアクセスに加えて `Authorization: Bearer <INGEST_TOKEN または発行したトークン>` を送る。
- ツール: get_sync_status / get_fetch_plan / list_races / get_race / upsert_race_days / upsert_races / upsert_odds / upsert_results / fetch_jra / run_analysis / get_analysis_results / get_performance / list_failed_records / retry_pending
- 確認: `tools/list` が 14 個、`get_sync_status` が応答する。

## 10. Automations の登録（E-5）
OPERATIONS §4 の依頼文 A〜D を、§1 のタイミングで登録する。最初は手動で 1 回ずつ実行して動作を確かめてから定期化する。

## 11. 非公開サイトとしての公開
「保存（レビュー可能な版）→ 公開」。対象者は限定（§8）。公開後に §6〜§9 の確認を本番の URL で再実施。

## 12. 本人の判断（2026-11-27 に U-1〜U-4 すべて「問題なし」と回答済み）
| ID | 事項 |
|---|---|
| U-1 | 公開 Web（JRA 公式など）からの取得の可否（利用規約・robots の確認）。ChatGPT による取得も同じ |
| U-2 | Plus のホスティング上限と、超過時の課金の有無（SITES_CONSTRAINTS E-8）。課金が発生するなら運用を止める |
| U-3 | ライセンス表記（jra-bot-web・infra に LICENSE が無い。jra-bot は MIT） |
| U-4 | 旧 SQLite（JV-Link 由来の実データ）をクラウドに入れるか（入れない前提で設計） |

## 13. 想定される追加費用
現時点で追加費用を発生させる設定はしていない。Sites のホスティング上限（未確認）を超えた場合の扱いだけが不明（U-2）。外部 API・有料サービスは使っていない。

## 14. 制限事項
- 判定の精度・利益を保証しない（紙上成績は実測の指標だけを表示）。ML は未使用で市場確率ベース。
- 発走直前の高頻度監視は無い（取得は 1 日数回）。オッズが無いレースは分析不能。

## 15. 残タスク（Claude Code 側でも続けられるもの）
- JRA のオッズの取得（発売中のページの構造を確認してから）
- ML 推論の移植（G1・G2 のゴールデンから）・学習（旧データの移行で学習データを用意できる）
- Discord 送信（E-3 が可のとき。G8-SINGLE/GROUPED の本文の移植）
- 旧の決済表（GD11）

## 16. 旧データの移行の手順（本人の PC。旧 SQLite は Git に入れない）
```bash
node dist/src/local/cli.js legacy-export <旧 jraev.sqlite> data/legacy.json      # 変換（件数と除外の理由を表示）
INGEST_TOKEN=<トークン> node dist/src/local/cli.js push data/legacy.json --url https://<site>   # サイトへ送信（再実行しても二重に入らない）
node dist/src/local/cli.js legacy-import <旧 jraev.sqlite>                        # ローカル DB へ取込む場合
node dist/src/local/cli.js backtest --from 2025-01-01 --to 2025-12-31            # ローカルで再判定と紙上成績（DB のコピーで実行を推奨）
```
送信量の目安: 1 封筒 200 レコード。D1 の容量（DATABASE §5）を見て、期間（`--from`/`--to`）を区切って送る。
