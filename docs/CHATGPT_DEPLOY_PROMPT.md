# CHATGPT_DEPLOY_PROMPT — ChatGPT にそのまま貼る依頼文

以下を ChatGPT（Sites を作成できる画面）に貼り付けてください。`<...>` は置き換えてください。

---

GitHub リポジトリ `puttun777/jra-bot-sites`（ブランチ `<マージ後なら main。未マージなら claude/jra-bot-sites-migration-2pk888>`）のコードで、**非公開の ChatGPT Site** を作ってください。
最初に `docs/HANDOFF.md` だけを読んでください（既存リポジトリ jra-bot / jra-bot-web / jra-bot-infra の再調査は不要です。コードの再実装もしないでください）。

制約:
- 追加の月額・従量課金が発生する設定はしないでください。発生しそうなら作業を止めて私に確認してください。
- 秘密（トークン・メール以外の資格情報）は `.openai/hosting.json` やコードに書かず、サイトの設定に入れてください。
- 業務コード（`src/domain`・`src/application`・`src/api`）は変更しないでください。Sites 固有の接続（`src/sites/worker.ts` 相当）だけを必要に応じて作り替えてください。

手順（各段の結果を短く報告してください）:
1. **最小構成の確認**: Sites が受け付ける構成を確認し、`docs/HANDOFF.md` §5 の案 1（生の Worker: `npm ci --ignore-scripts && npm run build` の `dist/sites/worker.js` + `dist/public/`）か案 2（推奨構成の 1 ルートから `handleRequest` を呼ぶ）を選ぶ。`/healthz` が `{"ok":true}` を返すところまで。
2. **D1**: `.openai/hosting.json` を `{"d1": "DB", "r2": null}` で作り、`migrations/0001_baseline.sql`・`0002_ops_calendar_ingest_ml.sql`・`0003_sites.sql` を順に適用する。失敗したら、その SQL 文とエラーを報告する（勝手に表の構成を変えない）。
3. **設定**: `OWNER_EMAILS=<本人のメール>`、`VIEWER_EMAILS=<もう 1 名のメール。無ければ空>`、`INGEST_TOKEN=<32 文字以上のランダム値>` をサイトの設定（シークレット）に入れる。
4. **認証の検証（最重要）**: 対象者を本人（と指定の 1 名）に限定して公開前の版で確認する。ログイン後 `/api/v1/me` が本人と ADMIN を返すこと、**未ログインのクライアントが `oai-authenticated-user-email` ヘッダを偽装しても 401/403 になること**（HANDOFF §8）。偽装が通る場合は公開せず報告する。
5. **画面**: `/` で「概要・シグナル・成績・運用」のタブが表示されること。運用タブの「選択した日付の判定を実行」が結果を表示すること（データが無ければ「対象のレースがありません」）。
6. **MCP**: `POST /mcp`（ベアラー: INGEST_TOKEN）をこのサイトのプラグイン（MCP サーバ）として登録し、`tools/list` が 13 個、`get_sync_status` が応答することを確認する（HANDOFF §9）。Plus で登録できない場合は報告する（手動取込で運用する）。
7. **外部通信と実行時間の確認**（任意）: `docs/SITES_CONSTRAINTS.md` §3 の E-3・E-6 を確認し、結果を報告する。
8. **公開**: 非公開（対象者限定）のまま公開する。
9. **Automations**: `docs/OPERATIONS.md` §4 の依頼文 A〜D を、§1 のタイミングで登録する。最初の 1 回は手動で実行して、取得できなかった値を登録していないこと・`observedAt` が取得時刻であることを確認する。
10. 最後に、確認できたこと / できなかったこと（SITES_CONSTRAINTS の E-1〜E-8 ごと）を一覧で報告する。

---
