# PROGRESS

最終更新: 2026-11-27 / ブランチ: `claude/jra-bot-sites-migration-2pk888` / 担当: Claude Code

## 現在の状態
PR #1 は main にマージ済み（`1ac2aae`）。2026-11-27、本人が U-1〜U-4 をすべて承認 → 追加の実装を同じブランチで継続中（PR #2）:
旧データの移行・過去日の再判定（バックテスト）・データ保持・JRA 公式サイトからの取得（開催日・出馬表・着順・払戻）。
残りは ChatGPT 側の Sites 固有作業（HANDOFF・CHATGPT_DEPLOY_PROMPT）と、JRA のオッズの取得・ML・Discord。

## 完了
| Phase | 内容 | 成果物 |
|---|---|---|
| 1 既存調査 | 3 リポジトリの main を読み取り（jra-bot f7dbf69 / web 7bcf1c4 / infra 123e046） | CURRENT_SYSTEM.md |
| 2 Sites 調査 | 公式ページは本環境から直接読めず、検索要約（A）と第三者スターター（B）で整理。E-1〜E-8 を未検証として管理 | SITES_CONSTRAINTS.md |
| 3 移行方針 | 途中で方針変更（2026-11-27: jra-bot-web をベースに最小改修）。A〜E 分類 | FEATURE_MATRIX.md・MIGRATION.md |
| 4 データ取得元 | 公開 Web の自動取得は規約未確認で保留（U-1）。ChatGPT（MCP）+ 手動取込 | DATA_SOURCES.md |
| 5 設計 | 層・依存・Sites 接続を 1 ファイルに | ARCHITECTURE.md・REQUIREMENTS.md |
| 6〜8 構築・ロジック移植 | 判定ロジック（ゴールデン 21 件 + 既定値で旧 Python と一致）・Python 互換の丸め・正しく丸めた log/exp | src/domain/analysis |
| 9 DB・取込 | V1〜V5 → SQLite/D1、リポジトリ、正規化 JSON 取込、カレンダー、手動補正 | migrations・src/infrastructure・src/domain |
| 10 API・ChatGPT 連携 | /api/v1（web と同じ DTO）・管理操作・MCP ツール 14 個 | src/api |
| 11 画面 | web の画面をコピー + レース詳細・取得状況・手動実行・JSON 取込・取込クライアント追加 | src/web |
| 12 運用 | 実行履歴・リース（重複実行防止・期限切れ回収）・停止モード・保留の再適用・エクスポート・バックアップ CLI | services.ts・cli.ts |
| 13〜14 試験・修正 | 109 件成功。発見・修正: ①Math.log/exp の 1 ULP（D-S03）②取込の重複判定に観測時刻が無い（D-S11）③予定の鮮度 120 分では Sites で毎日 STALE（D-S07）④MCP の取込で agent 行が無く外部キー違反 | TEST_REPORT.md |
| 15〜17 文書・push・PR・引き継ぎ | — | HANDOFF.md・CHATGPT_DEPLOY_PROMPT.md・OPERATIONS.md・AGENTS.md・CLAUDE.md・README.md |

## 試験結果（2026-11-27）
`npm run typecheck` 0 エラー / `npm run lint` 0 エラー / `npm run build` 成功 / `npm test` 109 件成功（失敗 0・skip 0）。
検証したツリー: `75d9fd6`（ローカル）。Sites 上の検証は未実施。

**GitHub Actions（PR #1 https://github.com/puttun777/jra-bot-sites/pull/1）**: 最初の 2 回はジョブがランナーで開始されず失敗（ステップ 0・ログ 404。コードの失敗ではない）。
本人の再実行（run 45954983508 attempt 2、head `5ba4d7f`）で `ci gate` が**成功**（npm ci・typecheck・lint・test の全ステップ success）。

## 判断
MIGRATION.md §2（D-S01〜D-S13）。

## 未解決・本人判断
HANDOFF §12（U-1 公開 Web 取得の可否 / U-2 Plus の上限と課金 / U-3 ライセンス表記 / U-4 旧データの移行）。

## 2026-11-27 追加分（PR #2）
| 内容 | 試験 |
|---|---|
| 旧 SQLite の移行（legacy-export / legacy-import / push）| 統合 3 |
| 過去日の再判定（BACKFILL・CLI backtest）| 統合（legacy に含む） |
| データ保持（管理 API・既定はドライラン）| 統合 2 |
| JRA 公式サイトからの取得（CLI fetch-jra・管理 API・MCP fetch_jra）| 単体 5・実ページで確認 |
環境: 開発用に許可ホストへ www.jra.go.jp・jra.jp を追加（本人の環境「jra-botリプレース」。承認済み）。
試験: `npm test` 119 件成功、typecheck・lint 0 エラー。

## 2026-11-28 追加分（PR #3）
JRA 公式のオッズ（単勝・ワイド・3 連複）の取得（発走前のレースだけ・時点 = ページの「◯時◯分現在オッズ」・3 連複は上位 6 頭の 2 頭以上を含む組）、
人気の補完（D-S18）。実ページで取得 → 判定まで確認。`npm test` 125 件成功。

## 次の作業
1. ChatGPT 側: docs/CHATGPT_DEPLOY_PROMPT.md の手順（最小構成の確認 → D1 → 認証の検証 → MCP → Automations）
2. Claude Code 側: ML の判定への組み込みと旧データでの学習（G1・G2 の推論は移植済み）、Discord 送信（E-3 が可なら）

## 再開手順
`git fetch origin claude/jra-bot-sites-migration-2pk888 && git checkout claude/jra-bot-sites-migration-2pk888 && npm ci --ignore-scripts && npm test`。
PR がマージ済みなら main から新しいブランチを作る。
