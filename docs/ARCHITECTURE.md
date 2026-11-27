# ARCHITECTURE

## 1. 全体

```
ChatGPT（Automations・会話）──MCP / ベアラー──┐
CSV・JSON（画面・CLI）────────────────────────┤
                                              ▼
 Sites（Workers 互換と推定。未検証）  src/sites/worker.ts（Sites 固有の接続。1 ファイル）
                                              │ Web 標準の Request / Response
                                              ▼
 src/api/        router.ts（/api/v1 = jra-bot-web と同じ DTO・管理操作）・auth.ts・mcp.ts・schemas.ts（zod）
                                              │
 src/application/services.ts   取込（保留→再適用）・判定の実行（リース・停止モード）・成績・状態・手動補正
                                              │
 src/domain/      analysis/（EV・確率・買い目・判定）・calendar・ingest・performance・notify・race（純粋。DB・HTTP に依存しない）
                                              │
 src/infrastructure/  repositories.ts（SQL）・db/sql.ts（D1 互換の型）・db/nodeSqlite.ts（ローカルだけ）
                                              │
                                   D1（本番）/ node:sqlite（ローカル・試験）
 src/web/  画面（jra-bot-web からコピー。esbuild で dist/public/js/app.js へ）
 src/local/ ローカルの開発サーバ・CLI・マイグレーション（Node 専用。本番では使わない）
 src/integrations/ 取得元のアダプター（CSV 取込。公開 Web の取得は保留）
```

## 2. 責務と依存の向き

- `domain` は何にも依存しない（Node API・DB・HTTP・zod を使わない）。旧実装との数値互換はここで閉じる（ゴールデン試験）。
- `application` は `domain` と `infrastructure`（SQL）を組み立てる。`SqlDatabase` の型だけに依存し、D1 / node:sqlite を知らない。
- `api` は入力の検証（zod）・認証・認可・DTO の変換だけ。業務の判断はしない。
- Sites 固有（`sites/worker.ts`）とローカル固有（`local/*`）は入口だけ。`build-assets.mjs` が Worker を platform: neutral で束ね、Node 専用 API の混入を検出する。

## 3. 主な処理の流れ

1. **取込**: ChatGPT が `get_fetch_plan` で未取得を知る → 公開情報を取得 → `upsert_*`（MCP）→ `ingestBatch`: 生レコードを保存（重複は数えるだけ）→ 正規化 JSON を解析 → 観測を適用（検査・隔離・保留）→ レースが届いたら保留を再適用。
2. **判定**: `run_analysis`（MCP・画面のボタン・Automations）→ 運用モード確認 → 日付のリース取得（重複実行防止）→ 有効な予定（手動補正を反映）→ レースごとに発走前の最新オッズで `evaluateOdds`（旧と同じ計算）→ race_evaluations・signals・通知スナップショットを保存 → リース解放。
3. **成績**: `/api/v1/performance` が signals・通知スナップショット・着順・払戻から毎回計算（保存しない。web D-234）。
4. **通知**: シグナルはサイト内に表示（`state=SENT`）。Discord は外部通信の確認後（E-3）。

## 4. セキュリティ

- 認証: 人 = Sites が注入する身元ヘッダ（E-1 で偽装防止を確認するまで公開しない）、機械 = ベアラートークン（SHA-256 のハッシュで保存・定数時間比較・32 文字以上）。
- 認可: サーバ側で VIEWER / ADMIN を判定。管理 API は ADMIN だけ。取込クライアントは取込・MCP だけ（画面の管理 API は使えない）。
- CSRF: POST に `X-Requested-With: jrabot-dashboard` を要求。CSP は `default-src 'self'`、画面は `textContent` だけで描画（XSS 対策。web の試験で確認）。
- SQL はすべてプレースホルダ。入力は zod の `strict`（余分なキーを拒否）。応答に内部の例外文を出さない。ログに個人情報・トークンを出さない。
- ローカルの疑似ログインはローカルサーバの入口だけ（Worker は `devUserEmail: null` 固定。試験で確認）。
- 外部データ（ChatGPT が取得した内容）は**データとして検査するだけ**で、命令として解釈しない（MCP の入力はスキーマで型を固定）。
