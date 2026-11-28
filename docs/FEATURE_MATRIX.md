# FEATURE_MATRIX — 機能ごとの移行の分類

分類（2026-11-27 の方針変更後の定義。最初の依頼の A〜E とは意味が違う）:
**A** 既存コードをそのまま利用 / **B** 既存コードを部分修正して利用 / **C** 既存仕様を維持して言語移植（Kotlin/Python → TypeScript）/
**D** Sites 固有機能による置き換え / **E** 制約により保留または廃止。
「検証」は TypeScript 側の試験（docs/TEST_REPORT.md）。「Sites 未検証」は SITES_CONSTRAINTS の E 項目。

## 1. 機能

| # | 機能（旧 ID: jra-bot-web MIGRATION_MATRIX） | 分類 | 移行元 → 移行先 | 理由・影響 | 検証 |
|---|---|---|---|---|---|
| 1 | EV・期待回収・Kelly・投資額（F05・F06） | C | jra-bot `ev/ev_calc.py`・web `decision/EvMath.kt` `KellyMath.kt` → `src/domain/analysis/ev.ts` | JVM は動かない（Sites は Workers 互換と推定）。式は不変 | GD01（ゴールデン一致） |
| 2 | 市場確率・正規化（F07） | C | `probability.py` / `MarketProbability.kt` → `probability.ts` | 同上 | GD02 |
| 3 | 単勝・ワイド・三連複の買い目、PL 確率、流し/BOX、実オッズ必須（F08） | C | `bet_strategy.py` / `BetStrategyBuilder.kt` `PlackettLuce.kt` → `betStrategy.ts` | 同上。旧の欠陥 E6〜E12 も旧どおり（変更は未承認） | GD05×6・GD07 |
| 4 | 購入判定・見送り・急落/人気急上昇・hit_rate/edge・総投資上限（F09） | C | `decision.py` / `WinDecisionEvaluator.kt` → `decision.ts` | 同上。旧集計に入らない除外（E3）は別に数える | GD03・GD04・GD06・GD07・GD08・GD09・GD10 |
| 5 | 浮動小数の互換（log/exp・sum・丸め） | C | web `PythonCompat.kt` → `pycompat.ts`・`crmath.ts` | V8 の Math.log/exp は 1 ULP 違うことがあり同点の順位が変わる → double-double で正しく丸める | GD06・単体 |
| 6 | 開催カレンダー（状態遷移・版の新旧・履歴・鮮度）（F03） | C | web `domain/calendar/*.kt` → `src/domain/calendar.ts` | 規則は同じ。鮮度の閾値のみ 120 分 → 18 時間（D-S07） | 統合（版・中止の終端・履歴） |
| 7 | 手動補正（開催日・レース。中止/時刻/延期/実行許可・禁止）と監査 | C | `CalendarOverride.kt`・`AdminApi.kt` → `calendar.ts`・`services.ts`・`router.ts` | 同上 | 統合・API |
| 8 | 取込: 正規化 JSON パーサ（NYS/NRA/NTC/NOW/NOD/NOS/NRS/NHR） | B | web `ingest/agent/NormalizedJsonRecordParser.kt` → `src/domain/ingest.ts` | web では合成検証専用（本番無効）だったものを、**Sites 版の唯一の取込形式として有効化** | 単体・統合 |
| 9 | 取込: 観測の適用・取込境界の検査・保留→再適用・隔離・冪等（ObservationApplier / BatchIngestor / PendingReplayer） | C | → `ingest.ts`・`services.ts` | 規則は同じ。ワイド・三連複の保存は既定で有効（判定に実オッズが要る: D-S06） | 統合 |
| 10 | JV-Link 取得・固定長パーサ・Windows エージェント（F01・F02・F21・F22・F23） | **E**（廃止） | — | JV-Link・JRA-VAN を使わない（依頼の必須制約） | — |
| 11 | 公開 Web からの自動取得（JRA 公式） | D | 新規 `src/integrations/jra/`・`src/application/jraFetch.ts` | 本人の承認（U-1）。開催日・出馬表・着順・払戻・オッズ（単勝・ワイド・3 連複。発走前だけ）を実装 | 単体（自作 HTML）・実ページで取得を確認 |
| 12 | ChatGPT からの取込（MCP ツール） | D | 新規 `src/api/mcp.ts` | 取得は ChatGPT（Automations / 手動）が行い、サイトは検査して保存 | API・MCP 試験。Sites 未検証 E-4 |
| 13 | CSV/JSON の手動取込 | D | 新規 `src/integrations/csvImport.ts`・画面の JSON 取込・CLI | 第 3 優先の取得方式 | 単体・API |
| 14 | 判定の実行（bot-run・RaceEvaluator）・実行履歴・リース・重複実行防止・停止モード（F14） | C | web `domain/botrun/*`・infra `ops/src/state.ts`（モード）→ `services.ts runAnalysis` | 常駐ループを廃し、1 リクエストの有限ジョブ（日付・レース単位で分割可能） | 統合 |
| 15 | 運用モード NORMAL/STOPPED（infra の起動・停止） | D | infra `OPERATIONS_DESIGN`・`ops/src/state.ts` → `ops_mode` 表・画面ボタン | クラウド資源の起動・停止は無いので、モードだけを残す（STARTING/STOPPING は不要） | 統合 |
| 16 | 定期実行（Cloud Scheduler / EventBridge）（F23） | D | → ChatGPT Automations の依頼文（OPERATIONS §4） | サイト内に常駐処理を持たない | Sites 未検証 E-5 |
| 17 | 紙上成績（単勝・ワイド・三連複の代表集計）（F15・F20） | C | web `performance/*.kt`・`PerformanceReadService.kt` → `src/domain/performance.ts`・`services.ts` | 規則は同じ（確定払戻ベース。発走前の最新 1 件） | 統合（ワイド 1-3 着の的中） |
| 18 | 旧の決済（bets・race_evaluations の settled 更新）（GD11） | **E**（保留） | web `SettlementCalculator.kt` | web でも成績は毎回計算（D-234）で、旧の決済表は使っていない。必要なら後で移植 | GD11 は未対応（成功に数えない） |
| 19 | 読取り API `/api/v1/*`（status/races/signals/performance/runs/me/admin/*） | C | web `dashboard/api/*.kt` → `src/api/router.ts` | **パス・DTO は同じ**（画面の修正を最小に） | 契約見本との形の一致 |
| 20 | 画面（概要・シグナル・成績・運用・手動補正・ML 一覧・エージェント一覧） | **A** | web `dashboard/src/main/ts/*`・`static/*` → `src/web/*` | ほぼそのまま。ビルドは esbuild で 1 ファイルに束ねる | web の試験 54 件 |
| 21 | 画面の追加: レース詳細・取得状況・手動実行・JSON 取込・取込クライアント追加 | B | `src/web/app.ts`・`view.ts`・`schema.ts` に追記 | Sites 版で必要な操作（ワンタイム実行・取込） | 画面の目視（PC・スマホ・ダーク） |
| 22 | 取得エージェント管理（F20 web R20） | B | `agent` 表・AgentAdminApi → 「取込クライアント」（MCP・取込のトークン） | Windows エージェントは無いが、機械の書き手の管理として同じ表・画面を使う | API |
| 23 | 認証（IAP/OIDC・Cognito）・認可（VIEWER/ADMIN）・CSRF | D + C | web `ApiAuthFilter.kt` → `src/api/auth.ts` | 身元は Sites が注入するヘッダ（未検証 E-1）。役割は app_user 表 / 環境変数 | API |
| 24 | Discord 通知（F13） | **E**（保留）/ C（補助） | `discord.py` の分割・429 待機・重複除去 → `src/domain/notify.ts` | 外部通信の可否が未確認（E-3）。通知はサイト内表示（signals）で代替。整形・分割は移植済み | G8 の 3 件 |
| 25 | ML 推論（F10）・学習（F11・F12） | C（一部）/ **E** | 旧 `ml/model.py`・`features.py` → `src/domain/ml/winModel.ts`・`md5.ts` | 旧 WinProbabilityModel の推論（オッズ・人気の特徴・Platt・市場ブレンド）とハッシュ特徴を移植。判定への組み込み・学習・DB の特徴量（G3〜G7）は保留。学習済み・検証済みとして扱わない | G1・G2 一致 |
| 26 | バックテスト（BacktestRunner.kt） | D | `runAnalysis`（trigger BACKFILL）・CLI `backtest` | 過去日を発走前のオッズだけで再判定して紙上成績を出す（web の BacktestRunner とは別実装） | 統合（旧データの再判定） |
| 27 | データ保持（retention）・バックアップ | C + D | web `Retention.kt` → `src/application/retention.ts`（管理 API。既定はドライラン）、バックアップは CLI（VACUUM INTO・JSON）・期間エクスポート API | D1 のバックアップ機能は未確認 | 統合 |
| 28 | Terraform / Pulumi / EC2 / Cloud Run / Docker 本番 / IAM / WIF | **E**（廃止） | — | AWS/GCP/Azure を使わない | — |
| 29 | 旧データの移行（legacy-import） | C | web `legacy-import`（Transform/Convert の規則）→ `src/local/legacy.ts`・CLI `legacy-export`/`legacy-import`/`push` | 本人の承認（U-4）。races・オッズ・組オッズ・着順・払戻を正規化 JSON にして取込。signals・bets・evaluations・馬の情報は移さない | 統合（合成の旧スキーマ DB） |

## 2. DB

| 表（jra-bot-web V1〜V5） | 分類 | Sites 版 |
|---|---|---|
| tenant・app_user・code_venue・races・horses・race_horses・horse_past_runs・odds_snapshots・combo_odds_snapshots・results・payouts・signals・bets・bet_legs・race_evaluations・ticket_evaluations・model_metrics・ingest_cursor・import_quarantine・audit_log | B（型の変換のみ） | `migrations/0001_baseline.sql` |
| race_day・race_schedule・agent・ingest_batch・ingest_raw・ingest_gap・race_schedule_event・calendar_override・bot_run・ml_model・horse_master_history・race_timing_notice | B | `migrations/0002_ops_calendar_ingest_ml.sql` |
| agent_registration_code・agent_heartbeat・agent_nonce・ingest_fetch・ingest_backfill・R__grants | E（廃止） | JV-Link・Windows エージェント・MySQL 固有 |
| ops_mode（新規） | D | `migrations/0003_sites.sql` |
