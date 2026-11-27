# CLAUDE.md

共通ルールは **AGENTS.md**（必ず従う）。作業開始時は `docs/PROGRESS.md` → 関係する資料だけを読む。

Claude Code 固有:
- 単一エージェントで進める。サブエージェントは独立レビュー・調査だけ（同時 1 つ）。
- 既存 3 リポジトリの調査結果は `docs/CURRENT_SYSTEM.md`・`FEATURE_MATRIX.md`・`MIGRATION.md` にある。再調査しない（必要な箇所だけ移行元のファイルを開く）。
- 中断するときは `docs/PROGRESS.md` に未完了の範囲と再開手順を書いてから commit・push。
