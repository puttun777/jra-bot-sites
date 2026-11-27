# SITES_CONSTRAINTS — ChatGPT Sites の仕様調査

- 調査日: **2026-11-27**（Claude Code クラウドセッション）
- 調査者: Claude（読み取りのみ。Sites 上での実機検証は未実施）

## 0. 調査方法と信頼度（重要）

この環境のネットワーク方針で **learn.chatgpt.com・help.openai.com への直接アクセスが拒否された**（DNS 解決不可 / プロキシ 403）。
そのため公式ページ本文は読めておらず、次の 3 種類の情報源で整理した。**A 以外は推測で実装可能と判断しない**。

| 記号 | 情報源 | 扱い |
|---|---|---|
| **A** | 公式ページ（learn.chatgpt.com / help.openai.com）の**検索結果の要約**（Web 検索ツールが本文から抜き出した記述） | 方針決定に使う。ただし本文未読のため ChatGPT 側で原文を確認する |
| **B** | 第三者の Sites 用スターター（GitHub `j-256/d1-r2-starter-openai` の README・`worker/index.ts`・`app/chatgpt-auth.ts`・`.openai/hosting.json`。raw.githubusercontent.com から取得） | 接続部の**設計の参考**に限る（公式ではない） |
| **C** | 第三者のブログ等 | 参考のみ。数値・料金は採用しない |

参照 URL（ユーザー指定 + 検索で見つかったもの）:
- https://help.openai.com/en/articles/20001339-creating-and-using-chatgpt-sites （A: 検索要約のみ）
- https://learn.chatgpt.com/docs/sites ・ /creating-a-site ・ /data-and-connections ・ /managing-a-site ・ /usage-and-cost （A: 検索要約のみ）
- https://help.openai.com/en/articles/20001547-hosting-a-plugin-with-chatgpt-sites （A: 検索要約のみ。MCP）
- https://learn.chatgpt.com/docs/webmcp （A: 検索要約のみ。Sites とは別機能「Site tools」）
- https://github.com/j-256/d1-r2-starter-openai （B）

## 1. 項目別の確認結果

| 項目 | 確認できた内容 | 信頼度 | 未確認・要検証（ChatGPT 側） |
|---|---|---|---|
| フロントエンド | スターターは Vinext（Vite ベースの Next.js 互換）+ React | B | 静的 SPA（HTML + ES モジュール）をそのまま配信できるか |
| バックエンド実行環境 | D1・R2 という名前（Cloudflare の製品名と同じ）。スターターは Workers 形式（`export default { fetch(request, env, ctx) }`、`compatibility_flags: ["nodejs_compat"]`） | A（名前）/ B | Workers ランタイムか・Node API の範囲・利用可能な npm |
| ビルド方式・成果物 | スターター: `npm run build` → `dist/`、マイグレーションは `dist/.openai/drizzle/` に同梱され「新しい版がトラフィックを受ける前に適用」。Sites は「保存（レビュー可能な版）→ 公開」の 2 段階で、ビルドは Sites 内でも外部の検証済み成果物でもよい | B | 生の Worker（`src/sites/worker.ts` の束ね）を受け付けるか、Vinext 構成が必須か |
| 既存プロジェクトの取り込み | 「ChatGPT / Codex にサイトへ追加を依頼」。ローカルのソース版はビルドに使った Git コミットと関連付けられる | A / B | GitHub リポジトリから直接取り込めるか |
| GitHub 連携 | ソース版とコミットの関連付け（B）。自動デプロイの記述は見つからない | B | **GitHub Actions からの自動デプロイは未確認 → 実装しない** |
| D1 | 1 サイトに D1（容量上限 10 GB の記述あり）。`.openai/hosting.json` の `d1` が論理バインディング名 | A | 上限値・バックアップ機能 |
| SQLite 互換 | D1 は SQLite 方言（Cloudflare D1 の一般仕様）。明示的な BEGIN/COMMIT は不可、`batch` が原子的 | C（Cloudflare 一般知識） | **Sites の D1 で `batch`・生成列・部分インデックス・json_valid・printf・GLOB の CHECK が動くこと** |
| マイグレーション | スターター: Drizzle 形式で `dist/.openai/drizzle/` に同梱、Sites が公開前に適用 | B | 素の SQL（`migrations/NNNN_*.sql`）をどう同梱するか |
| R2 | `.openai/hosting.json` の `r2`（無ければ null） | A | 本システムでは使わない（ファイル保存の要件なし） |
| 環境変数・シークレット | `.openai/hosting.json` に秘密を書かない。値はサイトの設定（ChatGPT 上）。ローカルは `.env` / `.env.example` | A | 設定画面の名前・Worker の `env` への渡り方 |
| 認証・認可 | 内部サイトはワークスペース利用者の身元、公開サイトは任意で「Sign in with ChatGPT」。スターター: Sites が `/signin-with-chatgpt`・`/signout-with-chatgpt`・`/callback`・Cookie・**身元ヘッダの注入**を担い、サーバは `oai-authenticated-user-email`（任意で `oai-authenticated-user-full-name`）を受け取る。「サインインは身元の確立で、アプリの権限ではない」 | A / B | **ヘッダ名・クライアントが同名ヘッダを偽装したとき Sites が除去するか（E-1）** |
| 共有設定 | 対象者（audience）の設定で上流で制御。公開サイトはワークスペース外からも見える | A / B | Plus での「本人と指定 1 名だけ」の共有方法 |
| MCP | 「サイト内に MCP サーバをホストし、プラグインとして ChatGPT で使える」。ツール追加後は所有者が再公開。Business/Enterprise ではワークスペースで共有可 | A | **Plus での可否・登録手順・認証方式（E-4）** |
| 外部 HTTP 通信 | 公式の記述は見つからない（「一部のフレームワーク・プライベートネットワーク・DB・バックグラウンドサービス・ホスティング形態は非対応の可能性」） | A | **外部 fetch の可否（E-3）**。確認まで Discord 送信・自動取得を有効にしない |
| 定期実行 | 「サイトに紐づくスケジュールをサイトの Automations で管理できる」「訪問者が承認したアプリのアクセスは、バックグラウンドの定期タスクには使えない」「定期実行前に、クラウドで実行したときに DB・データ接続へ届くか確認する」 | A | Automations から**サイトの API / MCP を呼べるか**、頻度の上限（E-5） |
| バックグラウンド処理 | 「バックグラウンドサービスは非対応の可能性」 | A | → 常駐処理は作らない（有限の 1 リクエスト処理だけ） |
| 実行時間・リクエスト数 | 記述は見つからない | — | **1 リクエストの CPU / 実行時間の上限（E-6）**。分析は日付単位・レース単位に分割可能にした |
| Plus の料金 | 構築・編集は Codex の利用枠を消費（ホスティングとは別）。ホスティングは一定期間無料、その後は月の上限を超えた分が課金対象（期日は情報源で 2026-12-31 / 2027-01-31 と食い違い）。Plus の上限はクレジット制（第三者要約: 月 125、DB 付きサイト 1 つで約 25、10 万リクエストで 15、1 GiB で約 150） | A / C | **原文の確認必須**。Plus で上限超過時に課金されるのか停止するのか |
| Codex 利用枠 | サイトの構築・編集は Codex の利用枠を消費 | A | — |
| `.openai/hosting.json` | 公式例: `{"project_id": "<…>", "d1": "DB", "r2": null}`。`d1`・`r2` は論理バインディング名（無ければ null）。新規の雛形は `project_id` 無しで始め、Sites がプロビジョニング時に付ける。秘密・環境値は書かない | A / B | 他のフィールドの有無 |

## 2. 設計への反映（推測で決めないための線引き）

1. **プラットフォーム非依存のコードを先行実装**: 業務ロジック・DB アクセス・API は Web 標準の `Request`/`Response` と、D1 の部分集合の `SqlDatabase` 型だけに依存（`src/api/router.ts` の `handleRequest`）。
2. Sites 固有の接続は **1 ファイル**（`src/sites/worker.ts`）に閉じ込めた。Sites が Vinext 構成を要求する場合は、そのルートから `handleRequest` を呼ぶ薄い接続に置き換える（HANDOFF §5）。
3. `.openai/hosting.json` は**作っていない**（形式は A で確認できたが、`project_id` は Sites が付ける。ChatGPT 側で作成）。
4. 外部通信（Discord・公開 Web の自動取得）は**既定で無効**。取得は ChatGPT（MCP）・手動取込で行う。
5. 定期実行はサイト内に持たない（バックグラウンド非対応の可能性）。ChatGPT Automations から MCP / API を呼ぶ前提で、依頼文を用意（OPERATIONS §4）。

## 3. 実機検証が必要な項目（最小の検証項目。ChatGPT 側で実施）

| ID | 検証項目 | 合格条件 | 不合格のときの代替 |
|---|---|---|---|
| **E-1** | 身元ヘッダの名前と偽装防止 | ログイン後に `/api/v1/me` が本人のメールを返す。**未ログイン・別ブラウザから `oai-authenticated-user-email: owner@…` を付けて送っても 401/403** | 偽装を防げない場合は公開しない。Sites の公式の認証 API に置き換える（`src/api/auth.ts` の `authenticateUser` だけ） |
| **E-2** | D1 で `migrations/0001〜0003` が適用できる | 全テーブル作成・`PRAGMA foreign_keys` 相当が有効・CHECK が効く | 失敗した構文だけを置き換える（DATABASE §2 の変換表） |
| **E-3** | 外部 fetch の可否 | Worker から `https://discord.com/api/webhooks/...` へ POST できるか（テスト用 Webhook） | 不可なら Discord 通知は ChatGPT Automations の通知・サイト内表示で代替（既定のまま） |
| **E-4** | MCP の登録 | `/mcp` に ChatGPT から `tools/list` が届く。認証方式（ベアラー / Sites の方式） | 不可なら CSV/JSON の手動取込（画面）で運用 |
| **E-5** | Automations からサイトを呼べるか | 定期タスクから `get_fetch_plan` → `upsert_*` → `run_analysis` が通る | 手動実行（画面のボタン・ChatGPT からの依頼） |
| **E-6** | 実行時間の上限 | 1 日 36 レースの `run_analysis` が 1 リクエストで終わる | `raceId` ごとに分割して呼ぶ（API は対応済み） |
| **E-7** | 静的ファイルの配信 | `/`・`/js/app.js`・`/style.css` が配信される（ASSETS バインディング等） | Sites の推奨構成（Vinext）の `public/` に置く |
| **E-8** | 料金・上限 | Plus で追加課金が発生しない運用か（DB 容量・リクエスト数） | DB の保持期間を短くする（OPERATIONS §5） |
