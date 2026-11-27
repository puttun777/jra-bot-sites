# AGENTS.md — 共通の開発ルール（ChatGPT / Codex と Claude Code）

jra-bot（中央競馬の期待値 Bot）を ChatGPT Sites で動かす後継版。業務仕様の正本は jra-bot-web（Kotlin）で、ここはその TypeScript 移植。

## 最初に読むもの（全部は読まない）
1. `docs/PROGRESS.md`（現在の状態・次の作業） 2. 作業に関係する資料だけ: `docs/HANDOFF.md`（Sites への載せ方）、`docs/FEATURE_MATRIX.md`（機能の分類）、`docs/ARCHITECTURE.md`、`docs/DATABASE.md`、`docs/DATA_SOURCES.md`、`docs/SITES_CONSTRAINTS.md`

## 絶対ルール
- 既存リポジトリ（jra-bot / jra-bot-web / jra-bot-infra）は読むだけ。変更・push しない。新規リポジトリを作らない。リポジトリの公開範囲を変えない。
- 追加の月額・従量課金、外部サービスの契約、AWS/GCP/Azure、OpenAI API、実行時の Anthropic API、JV-Link・JRA-VAN を使わない。必要になったら止めて本人に確認。
- 秘密・実データ・DB ダンプ・学習済みモデルを Git に入れない（.env.example はキー名だけ）。試験は合成データだけ。
- 取得できないデータを推測で埋めない（null・未取得のまま）。発走後のオッズを発走前の値として使わない。
- 公開 Web の自動取得は利用規約・robots の確認（本人判断 U-1）まで実装しない。
- 計算式・判定の仕様を独断で変えない。変えるときは理由と影響を `docs/MIGRATION.md` §2・§4 に記録する。
- `main` へ直接 push しない。作業ブランチ → PR。CI とレビューの確認なしにマージしない。

## コード
- TypeScript strict。`any`・二重キャスト・non-null assertion で型検査を回避しない。外部入力（HTTP・MCP・DB の行・取込）は実行時に検査する（zod / 自前の検査）。
- 層: `src/domain`（純粋。DB・HTTP・Node API 禁止）→ `src/application` → `src/infrastructure`（SQL）/ `src/api`（入出力）。Sites 固有は `src/sites/` だけ、Node 専用は `src/local/` だけ。
- SQL はプレースホルダだけ。D1 のため BEGIN/COMMIT を書かず `batch` を使う。マイグレーションは新しい番号で追加（適用済みは書き換えない）。
- 旧実装と同じ数値が要る処理は `src/domain/pycompat.ts`・`crmath.ts` を使う。変更したらゴールデン（`tests/golden`）で確認。

## 検証（push の前）
`npm ci --ignore-scripts && npm run typecheck && npm run lint && npm test`（109 件以上・失敗 0）。Sites 上でしか確かめられないことは「未検証」と書く（成功と書かない）。

## 記録
作業の区切りで `docs/PROGRESS.md` を更新（完了・未完了・試験結果・判断・次の作業・コミット）。判断は `docs/MIGRATION.md` §2（D-Sxx）。
