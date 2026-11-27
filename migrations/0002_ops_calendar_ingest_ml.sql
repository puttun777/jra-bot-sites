-- 移植元: puttun777/jra-bot-web@7bcf1c4 の V2__ops_calendar_ingest_ml.sql・V3__ingest_auth_fetch_backfill.sql・
-- V4__horse_master_history.sql・V5__audit_idempotency.sql（MySQL 8.4）。変換規則は 0001 と同じ。
-- Sites 版で持ち込まないもの（docs/MIGRATION.md §3。JV-Link・Windows エージェント固有）:
--   agent_registration_code / agent_heartbeat / agent_nonce / ingest_fetch / ingest_backfill / agent.sign_key_*（HMAC 署名）/
--   ingest_batch.fetch_id・fetch_seq / R__grants.sql（MySQL の権限）。
-- `agent` は「取込クライアント」（MCP・CSV 取込などの機械の書き手。ベアラートークンのハッシュで認証）として同じ列で使い続ける。

CREATE TABLE race_day (
  tenant_id INTEGER NOT NULL REFERENCES tenant (tenant_id),
  race_date TEXT NOT NULL,
  venue_code TEXT NOT NULL REFERENCES code_venue (venue_code),
  kai INTEGER NOT NULL CHECK (kai BETWEEN 1 AND 99),
  nichime INTEGER NOT NULL CHECK (nichime BETWEEN 1 AND 99),
  status TEXT NOT NULL CHECK (status IN ('UNPLANNED', 'PLANNED', 'UNCONFIRMED', 'CONFIRMED', 'RUNNING', 'SETTLING', 'COMPLETED', 'INCOMPLETE', 'CANCELLED', 'POSTPONED')),
  replaced_by_date TEXT NULL,
  first_seen_at TEXT NOT NULL,
  last_confirmed_at TEXT NULL,
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  PRIMARY KEY (tenant_id, race_date, venue_code)
);

CREATE TABLE race_schedule (
  tenant_id INTEGER NOT NULL REFERENCES tenant (tenant_id),
  race_id TEXT NOT NULL,
  race_date TEXT NOT NULL,
  venue_code TEXT NOT NULL REFERENCES code_venue (venue_code),
  race_no INTEGER NOT NULL CHECK (race_no BETWEEN 1 AND 99),
  kai INTEGER NULL CHECK (kai IS NULL OR kai BETWEEN 1 AND 99),
  nichime INTEGER NULL CHECK (nichime IS NULL OR nichime BETWEEN 1 AND 99),
  scheduled_post_at TEXT NULL,
  post_time_unknown INTEGER NOT NULL DEFAULT 0 CHECK (post_time_unknown IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('ANNOUNCED', 'CARD', 'MONITORING', 'OFF', 'RESULT_PENDING', 'RESULT_PARTIAL', 'SETTLED', 'FINALIZED', 'CANCELLED', 'DELETED')),
  data_kubun TEXT NOT NULL CHECK (length(data_kubun) = 1),
  source_version TEXT NOT NULL CHECK (length(source_version) >= 1),
  race_name TEXT NULL CHECK (race_name IS NULL OR length(race_name) <= 100),
  last_changed_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  PRIMARY KEY (tenant_id, race_id),
  CONSTRAINT ck_race_schedule_race_id_form CHECK (race_id GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'),
  CONSTRAINT ck_race_schedule_post CHECK (post_time_unknown = 0 OR scheduled_post_at IS NULL),
  CONSTRAINT ck_race_schedule_race_id_parts CHECK (race_id = replace(race_date, '-', '') || venue_code || printf('%02d', race_no))
);
CREATE INDEX ix_race_schedule_day ON race_schedule (tenant_id, race_date, scheduled_post_at);

CREATE TABLE agent (
  tenant_id INTEGER NOT NULL REFERENCES tenant (tenant_id),
  agent_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  token_hash TEXT NOT NULL,
  token_expires_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REVOKED')),
  created_at TEXT NOT NULL,
  created_by TEXT NULL,
  revoked_at TEXT NULL,
  revoked_by TEXT NULL,
  PRIMARY KEY (tenant_id, agent_id),
  CONSTRAINT uq_agent_agent_id UNIQUE (agent_id),
  CONSTRAINT ck_agent_id_form CHECK (length(agent_id) BETWEEN 1 AND 64 AND agent_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  CONSTRAINT ck_agent_token_hash CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  CONSTRAINT ck_agent_revoked CHECK ((status = 'REVOKED') = (revoked_at IS NOT NULL))
);

CREATE TABLE ingest_batch (
  tenant_id INTEGER NOT NULL,
  batch_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  batch_class TEXT NOT NULL CHECK (batch_class IN ('S', 'R')),
  dataspec TEXT NOT NULL CHECK (length(dataspec) <= 16),
  option_no INTEGER NULL,
  fromtime TEXT NULL,
  last_file_timestamp TEXT NULL,
  eof INTEGER NOT NULL DEFAULT 0 CHECK (eof IN (0, 1)),
  observed_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256) = 64),
  record_count INTEGER NOT NULL CHECK (record_count >= 0),
  accepted_count INTEGER NOT NULL DEFAULT 0,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'PROCESSING' CHECK (status IN ('PROCESSING', 'COMPLETED', 'FAILED')),
  completed_at TEXT NULL,
  fail_reason TEXT NULL,
  PRIMARY KEY (tenant_id, batch_id),
  CONSTRAINT fk_ingest_batch_agent FOREIGN KEY (tenant_id, agent_id) REFERENCES agent (tenant_id, agent_id),
  CONSTRAINT ck_ingest_batch_counts CHECK (accepted_count + duplicate_count <= record_count)
);
CREATE INDEX ix_ingest_batch_agent ON ingest_batch (tenant_id, agent_id, received_at);

-- payload は正規化 JSON（UTF-8 のテキスト）。HTML などの生データは保存しない。
CREATE TABLE ingest_raw (
  tenant_id INTEGER NOT NULL,
  record_hash TEXT NOT NULL CHECK (length(record_hash) = 64 AND record_hash NOT GLOB '*[^0-9a-f]*'),
  batch_id TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq >= 0),
  dataspec TEXT NOT NULL,
  record_id TEXT NOT NULL CHECK (length(record_id) <= 4),
  payload TEXT NOT NULL,
  received_at TEXT NOT NULL,
  parse_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (parse_status IN ('PENDING', 'PARSED', 'FAILED')),
  parse_error TEXT NULL CHECK (parse_error IS NULL OR length(parse_error) <= 200),
  PRIMARY KEY (tenant_id, record_hash),
  CONSTRAINT fk_ingest_raw_batch FOREIGN KEY (tenant_id, batch_id) REFERENCES ingest_batch (tenant_id, batch_id)
);
CREATE INDEX ix_ingest_raw_batch ON ingest_raw (tenant_id, batch_id, seq);
CREATE INDEX ix_ingest_raw_received ON ingest_raw (tenant_id, received_at);
CREATE INDEX ix_ingest_raw_pending ON ingest_raw (tenant_id, parse_status, parse_error);

CREATE TABLE ingest_gap (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES tenant (tenant_id),
  agent_id TEXT NULL,
  agent_key TEXT GENERATED ALWAYS AS (COALESCE(agent_id, '')) STORED NOT NULL,
  dataspec TEXT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('STOPPED', 'AGENT_UNREACHABLE', 'FETCH_FAILURE', 'OTHER')),
  gap_from TEXT NOT NULL,
  gap_to TEXT NULL,
  detected_at TEXT NOT NULL,
  resolved_at TEXT NULL,
  detail TEXT NULL,
  CONSTRAINT uq_ingest_gap_natural UNIQUE (tenant_id, reason, gap_from, agent_key),
  CONSTRAINT uq_ingest_gap_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT fk_ingest_gap_agent FOREIGN KEY (tenant_id, agent_id) REFERENCES agent (tenant_id, agent_id),
  CONSTRAINT ck_ingest_gap_range CHECK (gap_to IS NULL OR gap_to >= gap_from)
);
CREATE INDEX ix_ingest_gap_agent ON ingest_gap (tenant_id, agent_id);

CREATE TABLE race_schedule_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES tenant (tenant_id),
  race_id TEXT NULL,
  race_date TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('ADDED', 'DELETED', 'CANCELLED', 'TIME_CHANGE', 'SCRATCH', 'JOCKEY_CHANGE', 'COURSE_CHANGE', 'WEATHER', 'DAY_STATUS',
    'POSTPONED', 'REVOKED', 'MANUAL_OVERRIDE', 'MANUAL_REVOKE', 'FETCH_FAILURE', 'STALE')),
  old_value TEXT NULL CHECK (old_value IS NULL OR json_valid(old_value)),
  new_value TEXT NULL CHECK (new_value IS NULL OR json_valid(new_value)),
  source TEXT NOT NULL CHECK (source IN ('YSCH', 'RACE', '0B15', '0B14', 'MANUAL', 'SYSTEM')),
  observed_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  batch_id TEXT NULL,
  dedup_hash TEXT NOT NULL CHECK (length(dedup_hash) = 64 AND dedup_hash NOT GLOB '*[^0-9a-f]*'),
  CONSTRAINT uq_race_schedule_event_dedup UNIQUE (tenant_id, dedup_hash),
  CONSTRAINT fk_race_schedule_event_race FOREIGN KEY (tenant_id, race_id) REFERENCES race_schedule (tenant_id, race_id),
  CONSTRAINT fk_race_schedule_event_batch FOREIGN KEY (tenant_id, batch_id) REFERENCES ingest_batch (tenant_id, batch_id)
);
CREATE INDEX ix_race_schedule_event_race ON race_schedule_event (tenant_id, race_id, observed_at);
CREATE INDEX ix_race_schedule_event_date ON race_schedule_event (tenant_id, race_date);
CREATE INDEX ix_race_schedule_event_batch ON race_schedule_event (tenant_id, batch_id);

CREATE TABLE calendar_override (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES tenant (tenant_id),
  scope TEXT NOT NULL CHECK (scope IN ('DAY', 'RACE')),
  race_date TEXT NOT NULL,
  race_id TEXT NULL,
  action TEXT NOT NULL CHECK (action IN ('MARK_RACE_DAY', 'MARK_NO_RACE', 'CANCEL', 'SET_POST_TIME', 'POSTPONE_TO', 'ALLOW_RUN', 'DENY_RUN')),
  value TEXT NULL CHECK (value IS NULL OR json_valid(value)),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  created_by TEXT NOT NULL CHECK (length(created_by) <= 254),
  created_at TEXT NOT NULL,
  valid_until TEXT NULL,
  revoked_at TEXT NULL,
  revoked_by TEXT NULL,
  CONSTRAINT fk_calendar_override_race FOREIGN KEY (tenant_id, race_id) REFERENCES race_schedule (tenant_id, race_id),
  CONSTRAINT ck_calendar_override_scope CHECK ((scope = 'DAY' AND race_id IS NULL) OR (scope = 'RACE' AND race_id IS NOT NULL)),
  CONSTRAINT ck_calendar_override_revoked CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
CREATE INDEX ix_calendar_override_day ON calendar_override (tenant_id, race_date, scope);
CREATE INDEX ix_calendar_override_race ON calendar_override (tenant_id, race_id);

CREATE TABLE bot_run (
  tenant_id INTEGER NOT NULL REFERENCES tenant (tenant_id),
  run_id TEXT NOT NULL,
  run_date TEXT NOT NULL,
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('SCHEDULER', 'MANUAL', 'RECONCILE', 'BACKFILL')),
  state TEXT NOT NULL CHECK (state IN ('STARTING', 'RUNNING', 'DRAINING', 'SUCCEEDED', 'FAILED', 'ABORTED', 'STOPPED_BY_MODE', 'INTERRUPTED')),
  lease_owner TEXT NULL,
  lease_expires_at TEXT NULL,
  heartbeat_at TEXT NULL,
  active_slot INTEGER NULL,
  checkpoint TEXT NULL CHECK (checkpoint IS NULL OR json_valid(checkpoint)),
  planned_start TEXT NULL,
  planned_end TEXT NULL,
  exit_reason TEXT NULL CHECK (exit_reason IS NULL OR length(exit_reason) <= 200),
  started_at TEXT NOT NULL,
  finished_at TEXT NULL,
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  PRIMARY KEY (tenant_id, run_id),
  CONSTRAINT uq_bot_run_active UNIQUE (tenant_id, run_date, active_slot),
  CONSTRAINT ck_bot_run_run_id CHECK (length(run_id) = 36 AND run_id GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-*'),
  CONSTRAINT ck_bot_run_slot CHECK (
    (state IN ('STARTING', 'RUNNING', 'DRAINING') AND active_slot IS 1)
    OR (state NOT IN ('STARTING', 'RUNNING', 'DRAINING') AND active_slot IS NULL)
  ),
  CONSTRAINT ck_bot_run_finished CHECK (active_slot IS NULL OR finished_at IS NULL),
  CONSTRAINT ck_bot_run_finished_order CHECK (finished_at IS NULL OR finished_at >= started_at)
);
CREATE INDEX ix_bot_run_started ON bot_run (tenant_id, started_at);

CREATE TABLE ml_model (
  tenant_id INTEGER NOT NULL REFERENCES tenant (tenant_id),
  model_id TEXT NOT NULL CHECK (length(model_id) BETWEEN 1 AND 64 AND model_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  kind TEXT NOT NULL CHECK (kind IN ('calibration', 'alpha', 'legacy_compat', 'ensemble_set')),
  schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
  feature_schema_hash TEXT NOT NULL CHECK (length(feature_schema_hash) <= 71),
  artifact_uri TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  signature_sha256 TEXT NOT NULL CHECK (length(signature_sha256) = 64 AND signature_sha256 NOT GLOB '*[^0-9a-f]*'),
  status TEXT NOT NULL DEFAULT 'CANDIDATE' CHECK (status IN ('CANDIDATE', 'ACTIVE', 'RETIRED', 'REJECTED')),
  active_flag INTEGER NULL,
  trained_from TEXT NULL,
  trained_to TEXT NULL,
  n_train INTEGER NULL CHECK (n_train IS NULL OR n_train >= 0),
  metrics_json TEXT NULL CHECK (metrics_json IS NULL OR json_valid(metrics_json)),
  created_at TEXT NOT NULL,
  activated_at TEXT NULL,
  activated_by TEXT NULL,
  previous_model_id TEXT NULL,
  PRIMARY KEY (tenant_id, model_id),
  CONSTRAINT uq_ml_model_active UNIQUE (tenant_id, kind, active_flag),
  CONSTRAINT uq_ml_model_id_tenant UNIQUE (model_id, tenant_id),
  CONSTRAINT fk_ml_model_previous FOREIGN KEY (previous_model_id, tenant_id) REFERENCES ml_model (model_id, tenant_id),
  CONSTRAINT ck_ml_model_active CHECK (
    (status = 'ACTIVE' AND active_flag IS 1 AND activated_at IS NOT NULL)
    OR (status <> 'ACTIVE' AND active_flag IS NULL)
  ),
  CONSTRAINT ck_ml_model_trained CHECK (trained_from IS NULL OR trained_to IS NULL OR trained_to >= trained_from)
);
CREATE INDEX ix_ml_model_previous ON ml_model (previous_model_id, tenant_id);

-- V3: ワイドの上限オッズ
ALTER TABLE combo_odds_snapshots ADD COLUMN odds_high REAL NULL CHECK (odds_high IS NULL OR odds_high >= odds);

-- V4: 馬マスタの履歴（時点で再現できる特徴量のため）
CREATE TABLE horse_master_history (
  tenant_id INTEGER NOT NULL,
  ketto_num TEXT NOT NULL,
  known_at TEXT NOT NULL,
  source TEXT NOT NULL CHECK (length(source) BETWEEN 1 AND 32 AND source NOT GLOB '*[^a-z0-9_-]*'),
  style_tendency_json TEXT NULL CHECK (style_tendency_json IS NULL OR json_valid(style_tendency_json)),
  chaku_by_surface_json TEXT NULL CHECK (chaku_by_surface_json IS NULL OR json_valid(chaku_by_surface_json)),
  chaku_by_condition_json TEXT NULL CHECK (chaku_by_condition_json IS NULL OR json_valid(chaku_by_condition_json)),
  chaku_by_distance_json TEXT NULL CHECK (chaku_by_distance_json IS NULL OR json_valid(chaku_by_distance_json)),
  race_count INTEGER NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, ketto_num, known_at),
  CONSTRAINT fk_horse_master_history_horse FOREIGN KEY (tenant_id, ketto_num) REFERENCES horses (tenant_id, ketto_num)
);

-- V5: 評価の冪等（同じレース・同じ時刻の評価は 1 件。旧データ legacy_id 付きは対象外）
CREATE UNIQUE INDEX uq_race_evaluations_native ON race_evaluations (tenant_id, race_id, snapshot_at) WHERE legacy_id IS NULL;

-- V5: 通知のスナップショット（成績集計の入力。1 レース × 1 タイミングで 1 件）
CREATE TABLE race_timing_notice (
  tenant_id INTEGER NOT NULL,
  race_id TEXT NOT NULL,
  timing_centi INTEGER NOT NULL CHECK (timing_centi BETWEEN 1 AND 144000),
  run_id TEXT NOT NULL,
  evaluation_id INTEGER NOT NULL,
  odds_observed_at TEXT NOT NULL,
  notice_schema INTEGER NOT NULL CHECK (notice_schema >= 0),
  notice_json TEXT NOT NULL CHECK (json_valid(notice_json)),
  notice_sha256 TEXT NOT NULL CHECK (length(notice_sha256) = 64 AND notice_sha256 NOT GLOB '*[^0-9a-f]*'),
  fired_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, race_id, timing_centi),
  CONSTRAINT fk_race_timing_notice_race FOREIGN KEY (tenant_id, race_id) REFERENCES races (tenant_id, race_id),
  CONSTRAINT fk_race_timing_notice_eval FOREIGN KEY (tenant_id, evaluation_id) REFERENCES race_evaluations (tenant_id, id)
);
CREATE INDEX ix_race_timing_notice_eval ON race_timing_notice (tenant_id, evaluation_id);
