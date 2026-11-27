# DATABASE — D1 / SQLite の設計

## 1. 構成

- 本番: Sites の D1（バインディング名は `.openai/hosting.json` の `d1`。既定 `DB`）。**Sites 上で未検証**（SITES_CONSTRAINTS E-2）。
- ローカル・試験: node:sqlite（`src/infrastructure/db/nodeSqlite.ts`。D1 と同じく外部キー ON、`batch` は 1 トランザクション）。
  **ローカルの成功は D1 互換の確認ではない**。
- 業務コードは `SqlDatabase`（D1 の `prepare().bind().all()/first()/run()`・`batch()` の部分集合）だけに依存する。
- 単一利用者でも `tenant_id` とテナント境界を残す（web と同じ。初期テナント 1）。

## 2. MySQL（web V1〜V5）→ SQLite / D1 の変換規則

| MySQL | SQLite / D1 |
|---|---|
| `DATETIME(6)` | TEXT（UTC の `YYYY-MM-DDTHH:MM:SS.sssZ`。固定長なので辞書順 = 時刻順） |
| `DATE` / `TIME` | TEXT `YYYY-MM-DD` / `HH:MM:SS` |
| `ENUM(...)` | TEXT + `CHECK (x IN (...))` |
| `JSON` | TEXT + `CHECK (json_valid(x))` |
| `REGEXP` の CHECK | `GLOB`（例: race_id は 12 桁の数字） |
| `AUTO_INCREMENT` | `INTEGER PRIMARY KEY AUTOINCREMENT`（`(tenant_id, id)` の一意制約は残す） |
| `a <=> 1` | `a IS 1` |
| race_id の整合 CHECK（CONCAT/LPAD） | `race_id = replace(race_date,'-','') || venue_code || printf('%02d', race_no)` |
| 生成列（ingest_gap.agent_key） | `GENERATED ALWAYS AS (...) STORED` |
| V5 の uq_native（仮想列 + 一意） | 部分一意インデックス `WHERE legacy_id IS NULL` |
| `ALTER TABLE ... ADD CONSTRAINT FOREIGN KEY`（race_evaluations → ml_model） | SQLite は不可のため**省略**（model_id は検査なしの列） |
| BEGIN/COMMIT（トランザクション） | 書かない。複数文は `batch`（D-S04） |

## 3. 表（0001〜0003）

0001（web V1）: tenant / app_user / code_venue / races / horses / race_horses / horse_past_runs / odds_snapshots / combo_odds_snapshots / results / payouts / signals / bets / bet_legs / race_evaluations / ticket_evaluations / model_metrics / ingest_cursor / import_quarantine / audit_log
0002（web V2〜V5）: race_day / race_schedule / agent（取込クライアント）/ ingest_batch / ingest_raw / ingest_gap / race_schedule_event / calendar_override / bot_run / ml_model / horse_master_history / race_timing_notice（+ combo_odds_snapshots.odds_high・race_evaluations の部分一意）
0003（Sites）: ops_mode（NORMAL/STOPPED）、初期テナント 1

持ち込まない表は FEATURE_MATRIX §2。

## 4. 冪等・重複防止・整合性

- 予定・開催日: 楽観ロック（version）+ 履歴（race_schedule_event の dedup_hash 一意）。同じ変化は 1 回だけ反映。
- オッズ: `(race, market, observed_at, umaban/combo_key)` が主キー。同じ時刻・同じ内容は UNCHANGED。
- 取込: ingest_batch（batchId。同じ ID で内容が違えば 409）、ingest_raw（観測時刻 + レコードのハッシュ。D-S11）。
- 判定: race_evaluations は同じレース・同じオッズ時刻で 1 件（部分一意）、signals は自然キー一意、race_timing_notice は (race, timing) で 1 件。
- 実行: bot_run の `(tenant, run_date, active_slot=1)` 一意 = 同じ日の実行は 1 件（リース切れは INTERRUPTED で回収）。
- 通知スナップショット（race_timing_notice.notice_json）は Sites 版の独自形式 `schema=101`（web の NoticeSnapshot とは別。SHA-256 で改ざん・破損を検出し、読めないものは成績で「読めない通知」として数える）。

## 5. 容量の目安と保持

- 1 開催日（36 レース）で、単勝オッズ 2 回 × 16 頭 ≈ 1,150 行、ワイド ≈ 4,300 行、三連複を全組合せで登録すると 1 回 ≈ 20,000 行。
  **三連複は判定に使う組（人気上位の流し・BOX）だけを登録する**と数百行で済む（Automations の依頼文で指示: OPERATIONS §4）。
- Plus のホスティング上限（SITES_CONSTRAINTS §1。未確認）を考え、DB は数百 MB 以下を目安にする。使用量は画面 API `GET /api/v1/admin/db-stats`（行数）と Sites の画面で確認。
- 保持期間の削除処理は未実装（web の retention の移植は残タスク）。

## 6. マイグレーション・バックアップ・復元

- ローカル: `npm run db:migrate`（`d1_migrations` 表で 1 回ずつ。wrangler と同じ表名）。
- D1: Sites の手順で `migrations/0001〜0003` を適用（HANDOFF §6）。適用済みのマイグレーションは書き換えない（変更は新しい番号で追加）。
- バックアップ: ローカルは `npm run db:backup -- <out.sqlite>`（VACUUM INTO）、JSON は `node dist/src/local/cli.js export <out.json>`。
  本番は画面 API `GET /api/v1/admin/export?from&to`（31 日まで）。D1 自体のバックアップ機能は未確認。
- 復元: ローカルは `npm run db:restore -- <in.sqlite>`（現在の DB は .bak に退避、integrity_check を表示）。本番の復元はエクスポートの JSON を取込（予定・オッズ・結果・払戻）で再登録する方式（手順は OPERATIONS §6）。
