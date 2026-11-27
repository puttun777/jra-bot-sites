# CURRENT_SYSTEM — 既存システムの整理（移行元）

調査日: 2026-11-27。既存 3 リポジトリは**読み取りのみ**（変更・push なし）。

| リポジトリ | 参照したコミット（main） | 役割 | 状態 |
|---|---|---|---|
| puttun777/jra-bot | `f7dbf69fd8940121782870de902e8c449e6ca149` | 旧実装（Python / SQLite / Streamlit / JV-Link / Discord） | 動作比較の参照元。MIT |
| puttun777/jra-bot-web | `7bcf1c41b6c3b290b8388f70c1281703105ae532` | Kotlin/Spring Boot の Web 版（業務仕様の正本）+ TypeScript の画面 | **移行のベース** |
| puttun777/jra-bot-infra | `123e0466f1f31c23aecbe61865fd45360c2c77d3` | GCP→AWS の資源定義（Terraform/Pulumi）・運用 CLI（TypeScript） | 運用設計の参照元 |

既存の詳細な資料は移行元にある（ここに再掲しない）。必要なときだけ参照する:
- jra-bot-web: `docs/MIGRATION_MATRIX.md`（旧機能 F01〜F26・scripts 70 本の棚卸し・旧実装の欠陥 E1〜E17）、`docs/REQUIREMENTS.md`、`ARCHITECTURE.md`、`CONTRACTS.md`、`DECISIONS.md`、`RACE_CALENDAR_DESIGN.md`、`ML_DESIGN.md`、`DATA_SOURCE_COMPLIANCE.md`
- jra-bot-infra: `docs/OPERATIONS_DESIGN.md`（運用モード NORMAL/STOPPED）、`docs/AWS_ARCHITECTURE.md`、`docs/AWS_OPERATIONS.md`

## 1. 旧 jra-bot（Python）の機能の要約

JRA のオッズを発走前に定点観測し、**期待値（EV）が正の買い目だけを Discord に通知する Bot**。

- 取得: JV-Link（Windows 32bit COM）で当日のレース・単勝/ワイド/三連複オッズ・結果・払戻・馬マスタ・過去走
- 判定（`ev/decision.py` 1,012 行・`ev/bet_strategy.py` 803 行）: 市場確率（1/オッズ）またはロジスティック回帰の勝率 → logit 空間で市場とブレンド → 確率上限 → 単勝・ワイド・三連複の買い目（Plackett–Luce の組合せ確率、流し・BOX、実オッズ必須）→ EV・Kelly 基準の投資額 → 急落・人気急上昇のフィルタ → hit_rate / edge の優先順 → レース総投資上限
- 通知: Discord Webhook（2000 字分割・429 の待機・メンション）
- 保存: SQLite 15 表（races / odds_snapshots / combo_odds_snapshots / signals / results / payouts / bets / race_evaluations など）
- 画面: Streamlit（概要・レース詳細・馬詳細・成績・シグナル・運用）
- ML: numpy のロジスティック回帰（calibration / alpha / ensemble）の学習・推論
- 常駐: `run_daemon.py`（無限ループ。発走 240〜−5 分の監視窓でポーリング）

## 2. jra-bot-web（Kotlin）の到達点（移行のベース）

- モジュール: `:domain`（18.8k 行）`:persistence`（Doma/MySQL）`:db-migration`（Flyway V1〜V5）`:bot`（有限ジョブの bot-run）`:ingest`（取得エージェントの受信 API）`:dashboard`（読取り API + 画面）`:ml-train` `:legacy-import` `:golden-runner`
- 旧 Python との数値互換を**ゴールデン 36 件**（合成データ）で確認済み（`tools/golden/fixtures`）
- 画面は TypeScript（外部ライブラリなし、CSP 準拠、`textContent` だけで描画、応答は実行時検査）。API は `/api/v1/*`
- JV-Link 取得は Windows の C# エージェント（`agent/cs`）→ 署名付き ingest API。実データのパーサは一次仕様未確認で未実装（正規化 JSON の合成パーサのみ）
- 配置は AWS（EC2 1 台・普段停止）。本番デプロイは未実施（本人承認待ち）

## 3. ドキュメントと実装の食い違い（実装を優先した点）

| 項目 | 資料 | 実装 | Sites 版の扱い |
|---|---|---|---|
| ワイドの的中判定 | 旧 README は「払戻と突合」 | 旧 `get_winning_combo_keys` は 1・2 着の組だけ（E17） | jra-bot-web の実装どおり**確定払戻の行の有無**で判定 |
| `bet_strategy` 設定 | config.example に `bet_strategy: kelly/fixed` | 旧 `evaluate_odds` 内で変数が上書きされ常に None（Kelly） | 旧の実際の挙動（常に Kelly）を再現（ゴールデンで確認） |
| 関数既定値 vs 設定例 | 例: `ev_shrink_factor` 0.7 / 0.55 | 運用は設定例の値 | 運用は `RECOMMENDED_DECISION_CONFIG`（設定例）、比較試験は関数既定値 |
| 予定の鮮度 | web は 120 分で STALE | 常時取得のエージェント前提 | Sites は取得頻度が低いので 18 時間（D-S07） |
