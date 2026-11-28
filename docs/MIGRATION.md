# MIGRATION — 移行の対応表・変更点・判断

移行元のコミット: jra-bot `f7dbf69`、jra-bot-web `7bcf1c4`、jra-bot-infra `123e046`（CURRENT_SYSTEM.md）。
方針: **jra-bot-web をベースに必要な部分だけ改修・移植**（2026-11-27 の方針変更）。分類は FEATURE_MATRIX.md。

## 1. ファイルの対応（移行元 → 移行先）

| 移行先 | 移行元 | 分類 | 変更 |
|---|---|---|---|
| `src/web/{api,app,dom,format,schema,validate,view}.ts`・`src/web/static/{index.html,style.css}` | web `dashboard/src/main/ts/*`・`dashboard/src/main/resources/static/*` | A/B | 追記のみ（レース詳細・取得状況・手動実行・JSON 取込・取込クライアント追加。`api.ts` に `postJson`） |
| `tests/web/*.test.ts`・`tests/web/contract/*.json` | web `dashboard/src/test/ts/*`・`dashboard/src/test/resources/frontend-contract/*` | A | import のパスだけ変更。contract 試験の要素の種類の表に textarea/p を追加 |
| `tests/golden/fixtures/*.json.gz` | web `tools/golden/fixtures/*.json`（合成データ。27 件を gzip） | A | 圧縮のみ |
| `tests/golden/harness.ts`・`analysis.test.ts` | web `golden-runner/GoldenCompare.kt`・`GoldenCalls.kt` | C | 比較規則・引数の解釈を移植 |
| `src/domain/analysis/{ev,probability,filters,betStrategy,decision}.ts` | jra-bot `src/jraev/ev/*.py`（旧の正）＋ web `domain/decision/*.kt`（構造・欠陥の扱い） | C | 数値は旧と同じ（ゴールデンで確認）。ML の DB 読み取りは差込口に置換 |
| `src/domain/pycompat.ts`・`analysis/crmath.ts` | web `domain/decision/PythonCompat.kt` | C | 正しく丸めた log/exp を追加（D-S03） |
| `src/domain/calendar.ts` | web `domain/calendar/{Transitions,SourceVersion,ScheduleEvent,ScheduleUpdates,RaceDay,CalendarOverride,EffectiveCalendar}.kt` | C | 非同期化。鮮度 18 時間（D-S07） |
| `src/domain/ingest.ts` | web `ingest/agent/NormalizedJsonRecordParser.kt`・`domain/ingest/{Observations,ObservationApplier}.kt` | B/C | 正規化 JSON を本番の取込形式に（D-S05）。組合せオッズの保存を既定で有効（D-S06） |
| `src/domain/performance.ts` | web `domain/performance/{PaperSettlement,ComboPaperSettlement,PerformanceAggregator}.kt` | C | 変更なし |
| `src/domain/notify.ts` | jra-bot `notify/discord.py`・web `notify/{ContentSplitter,RateLimitWait,NoticeFormatter}.kt` | C | 送信は未実装（E-3） |
| `src/domain/race.ts` | web `domain/race/{RaceId,Venue}.kt`・`odds/ComboKeys`・`time/Zones` | C | — |
| `src/application/services.ts` | web `domain/ingest/{BatchIngestor,PendingReplayer}.kt`・`domain/botrun/{RaceEvaluator,RaceCycleProcessor}.kt`・`PerformanceReadService.kt`・`dashboard ReadApi.status` | C/D | 常駐の bot-run → 1 リクエストの有限実行 |
| `src/infrastructure/repositories.ts` | web `persistence/dao/*`（Doma SQL） | C | MySQL → SQLite/D1。楽観ロック + 履歴は batch（D-S04） |
| `src/api/router.ts` | web `dashboard/api/{ReadApi,AdminApi,MeController,MlModelApi,AgentAdminApi}.kt` | C | 同じパス・DTO。Sites 用の管理操作を追加 |
| `src/api/auth.ts` | web `dashboard/api/ApiAuthFilter.kt`・CSRF フィルタ・`domain/ingest/AgentAuth.kt` | D/C | 身元は Sites のヘッダ（E-1）、機械はベアラー（HMAC 署名は廃止: D-S08） |
| `src/api/mcp.ts` | 新規 | D | MCP ツール 14 個 |
| `migrations/0001〜0002` | web `db-migration/.../V1〜V5` | B | 型の変換だけ（DATABASE.md §2） |
| `migrations/0003_sites.sql` | infra `OPERATIONS_DESIGN`（モード） | D | ops_mode・初期テナント |
| `.github/workflows/ci.yml` | web `.github/workflows/ci.yml`（action の SHA・concurrency） | B | 1 ジョブに縮小 |
| `LICENSE` | jra-bot `LICENSE`（MIT, © 2026 puttun777） | A | — |

jra-bot-web・jra-bot-infra には LICENSE ファイルが無い（同じ作者のリポジトリ）。コピーしたファイルの出典は各ファイルの先頭コメントと本表に記録した。公開範囲・ライセンスの表記は本人判断（HANDOFF §12）。

## 2. 判断（Sites 版。web の D-xxx と区別して D-S を付ける）

| ID | 判断 | 理由 |
|---|---|---|
| D-S01 | 言語は TypeScript（strict）。依存は zod だけ（開発: typescript・eslint・esbuild） | Sites は JVM 不可と推定。依存の最小化・Workers 互換 |
| D-S02 | フレームワーク・ORM を採用しない（Web 標準の Request/Response と D1 互換の `SqlDatabase`） | Sites の推奨構成が未確定。大規模なフレームワーク依存を避ける |
| D-S03 | log/exp は double-double で正しく丸める | V8 の Math.log/exp が 1 ULP 違い、EV の同点の並び（GD06）が変わるため |
| D-S04 | 楽観ロックの更新と履歴の追記は `batch`（履歴は「更新後の version の行がある」条件付き INSERT） | D1 は BEGIN/COMMIT 不可 |
| D-S05 | 正規化 JSON（web の合成パーサ）を本番の取込形式にする | JV-Link を使わない。既存の検査・保留・冪等の仕組みをそのまま使える |
| D-S06 | ワイド・三連複のオッズを既定で保存する | 判定は実オッズ必須（`require_real_odds_for_combo`）。保存しないと組合せの判定ができない |
| D-S07 | 予定の鮮度を 120 分 → 18 時間 | 取得が 1 日 1〜2 回（ChatGPT）。120 分では毎日 STALE で判定が止まる |
| D-S08 | 取込の HMAC 署名・nonce・登録コードは使わない（ベアラートークンのハッシュだけ） | Windows エージェントが無い。MCP の認証方式が未確定 |
| D-S09 | 判定で生成したシグナルは `SENT`（サイト内に表示 = 通知済み）として成績の対象にする | Discord 送信が無い（E-3）。web の成績は SENT だけを数える |
| D-S10 | 判定に使うオッズは「観測時刻 ≤ min(現在, 発走)」の最新だけ | 確定オッズ・未来の値の混入防止（バックテストの未来情報） |
| D-S11 | 取込の重複判定のハッシュに観測時刻を含める | 同じ値のオッズでも時刻が違えば別の観測（試験で発見した不具合の修正） |
| D-S12 | 公開 Web（JRA 等）の自動取得は実装しない | 利用規約・robots を確認できていない（DATA_SOURCES §1）。本人判断 |
| D-S13 | 予定の段階の取込（NRA の kubun）は web と同じ 1/2/9/0 だけ | 結果系の区分（3〜7）は web でも予定に反映しない |
| D-S14 | JRA 公式サイトから開催日・出馬表・着順・払戻を取得する（オッズは未対応） | 本人の承認（U-1）。robots.txt 全許可・私的利用。オッズは発売中のページ構造を確認するまで実装しない |
| D-S15 | 旧データは正規化 JSON に変換して通常の取込を通す（DB へ直接書かない） | 検査・冪等・保留を同じにする。batchId は内容から決めるので再実行しても二重に入らない |
| D-S16 | 過去日の再判定（BACKFILL）は、開催日の確認が無くても発走時刻が分かるレースを対象にする | 旧データには race_day が無い。オッズは発走前の観測だけなので未来情報は入らない |
| D-S18 | 人気が取得元に無いとき（JRA 公式のオッズのページ）は、判定のときだけ単勝オッズの低い順を人気とする（同じオッズは同順位）。保存は null のまま | 流し相手・BOX・人気急上昇の判定に人気が要る。JRA の人気は票数順なので、表示のオッズが同じ馬どうしでだけ違い得る（D-S18 の唯一の差） |
| D-S19 | 3 連複のオッズは単勝オッズ上位 6 頭のうち 2 頭以上を含む組だけ保存する | 全 816 組は D1 の容量に対して多い。判定が使うのは人気上位の流し（top_k 最大 6）と BOX の組だけ |
| D-S17 | データ保持は web と同じ既定（組オッズ 14 日など）・既定はドライラン | 組オッズを消すとその期間のワイド・三連複は再判定できない（運用で日数を選ぶ） |

## 3. 持ち込まなかったもの（理由）

（2026-11-27 追記）旧データの移行で移さないもの: signals・bets・race_evaluations（旧の判定。Sites で同じオッズから再判定できる: D-S16）、
horses・race_horses・horse_past_runs（ML の特徴量。ML の移植まで保留）、results.payout（単位の疑義: web JVLINK_DESIGN §1.4）。


JV-Link・Windows エージェント（`agent/cs`）・取得の fetch/backfill 表・HMAC 署名・Terraform/Pulumi・Docker 本番・AWS/GCP の運用 CLI（`ops/src/aws`・`gcp`）・MySQL の権限（R__grants）・Spring Boot の設定。
いずれも依頼の必須制約（AWS/GCP/JV-Link を使わない）か、Sites に該当する機能が無いため。

## 4. 既存仕様からの変更（計算結果に影響するもの）

| 変更 | 影響 | 記録 |
|---|---|---|
| なし（判定・EV・Kelly・確率・買い目は旧と同じ。ゴールデンで確認） | — | TEST_REPORT §1 |
| ワイドの的中判定: 旧 Python（1・2 着の組のみ）→ 確定払戻の行（jra-bot-web と同じ） | 成績のワイドの的中が増える（正しくなる） | web E17・D-234 |
| 予定の鮮度 18 時間（D-S07） | 判定の対象になる時間帯が広がる | 本書 §2 |
