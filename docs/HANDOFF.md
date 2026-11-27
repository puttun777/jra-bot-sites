# HANDOFF — ChatGPT（Sites）への引き継ぎ

ChatGPT 側は **本書と docs/CHATGPT_DEPLOY_PROMPT.md だけ**を最初に読めば作業を始められる。既存の 3 リポジトリを再調査する必要はない（整理済み: CURRENT_SYSTEM・FEATURE_MATRIX・MIGRATION）。

## 1. システム概要
jra-bot（中央競馬のオッズから期待値の正の買い目を見つける私的な Bot）の後継。jra-bot-web（Kotlin）の業務仕様と画面を TypeScript に移し、ChatGPT Sites で動かす。
データは ChatGPT（MCP ツール）か手動（CSV/JSON）で登録し、判定（EV・Kelly・買い目）はサイトのプログラムが行う（生成 AI は使わない）。

## 2. 実装済み
- 判定ロジック（単勝・ワイド・三連複、確率、Kelly、見送り、急落フィルタ、hit_rate/edge、総投資上限）: 旧 Python とゴールデンで一致
- 開催カレンダー（版・状態遷移・履歴・鮮度・手動補正）、取込（正規化 JSON・保留→再適用・隔離・冪等）、判定の実行（リース・停止モード・未来情報の不使用）、紙上成績
- `/api/v1/*`（jra-bot-web と同じ DTO）+ 管理操作 + MCP ツール 13 個 + 画面（概要・シグナル・成績・運用、レース詳細・取得状況・手動実行・JSON 取込）
- ローカル開発サーバ・CLI（マイグレーション・合成データ・取込・CSV・判定・バックアップ・復元・エクスポート）・試験 109 件・CI

## 3. 既存機能との差分（要点。全体は FEATURE_MATRIX）
- 廃止: JV-Link 取得・Windows エージェント・AWS/GCP の基盤・常駐の監視ループ（30 秒間隔の発走直前監視は再現しない）
- 保留: 公開 Web の自動取得（規約未確認）・Discord 送信（外部通信未確認）・ML 推論/学習（学習データ無し）・バックテスト・旧の決済表・データ保持の削除
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
Sites が受け付ける構成を先に最小構成で確認する（SITES_CONSTRAINTS E-7）。
- **案 1（生の Worker が使える場合）**: 入口 = `dist/sites/worker.js`（`export default { fetch(request, env) }`）。静的ファイル = `dist/public/`（ASSETS バインディング）。D1 = `env.DB`。
- **案 2（Vinext 等の推奨構成が必須の場合）**: 推奨構成の雛形を作り、すべてのパス（`/api/*`・`/mcp`・`/healthz`）を 1 つのルートで受けて `handleRequest(request, ctx)`（`src/api/router.ts`）に渡す。`ctx` の作り方は `src/sites/worker.ts` をそのまま使う。画面は `dist/public/` を `public/` に置く。**業務コードは変更しない**。
- `.openai/hosting.json` を作る: `{"d1": "DB", "r2": null}`（`project_id` は Sites が付ける。秘密は書かない）。

## 6. DB の構築・マイグレーション
- D1 に `migrations/0001_baseline.sql` → `0002_ops_calendar_ingest_ml.sql` → `0003_sites.sql` の順で適用（Sites のマイグレーションの仕組みに合わせて同梱。スターターでは `dist/.openai/drizzle/` に置く方式）。
- 失敗した構文があれば DATABASE §2 の変換表の該当箇所だけを直し、新しい番号のファイルで追加する（適用済みのファイルは書き換えない）。
- 確認: `GET /healthz` → `{"ok":true}`、ログイン後 `GET /api/v1/status` が 200。

## 7. 必要な環境変数（Sites の設定・シークレット。Git に値を書かない。キーは .env.example）
| キー | 必須 | 内容 |
|---|---|---|
| `OWNER_EMAILS` | 必須 | 管理者（本人）のメール。カンマ区切り |
| `VIEWER_EMAILS` | 任意 | 閲覧者（もう 1 名）のメール |
| `INGEST_TOKEN` | 任意 | MCP・取込用のベアラートークン（32 文字以上のランダム値）。画面の「取込クライアントを追加」で発行したトークンでもよい |
| `AUTH_EMAIL_HEADER` | 任意 | 身元ヘッダ名が `oai-authenticated-user-email` と違う場合だけ |
| `DISCORD_WEBHOOK_URL` | 不要 | 未使用（外部通信の確認後に実装） |

## 8. 認証の設定（最重要の検証: E-1）
1. サイトの対象者を「本人（と指定の 1 名）」に限定する（公開しない）。
2. ログインして `/api/v1/me` が本人のメール・ADMIN を返すことを確認。
3. **別のブラウザ（未ログイン）から `curl -H "oai-authenticated-user-email: <本人のメール>" https://<site>/api/v1/me` を送り、401/403 になることを確認**。200 なら公開を止め、`src/api/auth.ts` の `authenticateUser` を Sites の正式な身元確認に置き換える。

## 9. MCP の登録（E-4）
- サーバ: `POST https://<site>/mcp`（JSON-RPC 2.0。`initialize`・`tools/list`・`tools/call`。SSE・セッションは使わない）
- 認証: `Authorization: Bearer <INGEST_TOKEN または発行したトークン>`。Sites のプラグイン方式で別の認証が必要なら、`src/api/router.ts` の `/mcp` の認証部分だけを差し替える。
- ツール: get_sync_status / get_fetch_plan / list_races / get_race / upsert_race_days / upsert_races / upsert_odds / upsert_results / run_analysis / get_analysis_results / get_performance / list_failed_records / retry_pending
- 確認: `tools/list` が 13 個、`get_sync_status` が応答する。

## 10. Automations の登録（E-5）
OPERATIONS §4 の依頼文 A〜D を、§1 のタイミングで登録する。最初は手動で 1 回ずつ実行して動作を確かめてから定期化する。

## 11. 非公開サイトとしての公開
「保存（レビュー可能な版）→ 公開」。対象者は限定（§8）。公開後に §6〜§9 の確認を本番の URL で再実施。

## 12. 本人の判断が必要なこと
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
- ML 推論の移植（G1・G2 のゴールデンから）・学習はローカル実行でモデルを取込む方式の設計
- Discord 送信（E-3 が可のとき。G8-SINGLE/GROUPED の本文の移植）
- データ保持（古いオッズの削除）・バックテスト・旧の決済表（GD11）
- 公開 Web のアダプター（U-1 が可のとき）
