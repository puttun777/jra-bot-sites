-- 移植元: puttun777/jra-bot-web@7bcf1c4 db-migration/src/main/resources/db/migration/V1__baseline.sql（MySQL 8.4）
-- SQLite / Cloudflare D1 向けの変換（docs/DATABASE.md §2 の規則）:
--   DATETIME(6) → TEXT（UTC の ISO 8601 `YYYY-MM-DDTHH:MM:SS.sssZ`）、DATE → TEXT `YYYY-MM-DD`、TIME → TEXT `HH:MM:SS`、
--   ENUM → TEXT + CHECK(IN)、JSON → TEXT + CHECK(json_valid)、REGEXP → GLOB、AUTO_INCREMENT → INTEGER PRIMARY KEY AUTOINCREMENT、
--   `<=>` → IS。テーブル・列・主キー・一意制約・外部キー・CHECK の意味は V1 と同じにする。
-- D1 は明示的な BEGIN/COMMIT を使えないため、このファイルにトランザクション文を書かない。

CREATE TABLE tenant (
  tenant_id INTEGER NOT NULL PRIMARY KEY CHECK (tenant_id >= 1),
  name TEXT NOT NULL CHECK (length(name) <= 100),
  created_at TEXT NOT NULL
);

CREATE TABLE app_user (
  tenant_id INTEGER NOT NULL REFERENCES tenant (tenant_id),
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('VIEWER', 'ADMIN')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, email),
  CONSTRAINT uq_app_user_email UNIQUE (email),
  CONSTRAINT ck_app_user_email_form CHECK (length(email) BETWEEN 3 AND 254 AND instr(email, '@') > 1),
  CONSTRAINT ck_app_user_email_lower CHECK (email = lower(email))
);

CREATE TABLE code_venue (
  venue_code TEXT NOT NULL PRIMARY KEY CHECK (venue_code BETWEEN '01' AND '10' AND length(venue_code) = 2),
  name TEXT NOT NULL
);
INSERT INTO code_venue (venue_code, name) VALUES
  ('01', '札幌'), ('02', '函館'), ('03', '福島'), ('04', '新潟'), ('05', '東京'),
  ('06', '中山'), ('07', '中京'), ('08', '京都'), ('09', '阪神'), ('10', '小倉');

CREATE TABLE races (
  tenant_id INTEGER NOT NULL REFERENCES tenant (tenant_id),
  race_id TEXT NOT NULL,
  race_date TEXT NOT NULL,
  venue_code TEXT NOT NULL REFERENCES code_venue (venue_code),
  race_no INTEGER NOT NULL CHECK (race_no BETWEEN 1 AND 99),
  kai INTEGER NULL CHECK (kai IS NULL OR kai BETWEEN 1 AND 99),
  nichime INTEGER NULL CHECK (nichime IS NULL OR nichime BETWEEN 1 AND 99),
  post_time TEXT NULL,
  post_time_unknown INTEGER NOT NULL DEFAULT 0 CHECK (post_time_unknown IN (0, 1)),
  name TEXT NULL CHECK (name IS NULL OR length(name) <= 100),
  distance_m INTEGER NULL CHECK (distance_m IS NULL OR distance_m > 0),
  track_type_cd TEXT NULL,
  course_kubun_cd TEXT NULL,
  tenko_cd TEXT NULL,
  shiba_baba_cd TEXT NULL,
  dirt_baba_cd TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, race_id),
  CONSTRAINT ck_races_race_id_form CHECK (race_id GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'),
  CONSTRAINT ck_races_post_time CHECK (post_time_unknown = 0 OR post_time IS NULL),
  CONSTRAINT ck_races_race_id_parts CHECK (race_id = replace(race_date, '-', '') || venue_code || printf('%02d', race_no))
);
CREATE INDEX ix_races_date ON races (tenant_id, race_date, venue_code, race_no);

CREATE TABLE horses (
  tenant_id INTEGER NOT NULL REFERENCES tenant (tenant_id),
  ketto_num TEXT NOT NULL CHECK (length(ketto_num) <= 10),
  bamei TEXT NULL,
  sex_cd TEXT NULL,
  birth_date TEXT NULL,
  tozai_cd TEXT NULL,
  trainer_code TEXT NULL,
  owner_code TEXT NULL,
  breeder_code TEXT NULL,
  pedigree_json TEXT NULL CHECK (pedigree_json IS NULL OR json_valid(pedigree_json)),
  style_tendency_json TEXT NULL CHECK (style_tendency_json IS NULL OR json_valid(style_tendency_json)),
  chaku_by_surface_json TEXT NULL CHECK (chaku_by_surface_json IS NULL OR json_valid(chaku_by_surface_json)),
  chaku_by_condition_json TEXT NULL CHECK (chaku_by_condition_json IS NULL OR json_valid(chaku_by_condition_json)),
  chaku_by_distance_json TEXT NULL CHECK (chaku_by_distance_json IS NULL OR json_valid(chaku_by_distance_json)),
  race_count INTEGER NULL CHECK (race_count IS NULL OR race_count >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, ketto_num)
);

CREATE TABLE race_horses (
  tenant_id INTEGER NOT NULL,
  race_id TEXT NOT NULL,
  umaban INTEGER NOT NULL CHECK (umaban BETWEEN 1 AND 99),
  ketto_num TEXT NULL,
  bamei TEXT NULL,
  jockey_code TEXT NULL,
  trainer_code TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, race_id, umaban),
  CONSTRAINT fk_race_horses_race FOREIGN KEY (tenant_id, race_id) REFERENCES races (tenant_id, race_id)
);
CREATE INDEX ix_race_horses_ketto ON race_horses (tenant_id, ketto_num);

CREATE TABLE horse_past_runs (
  tenant_id INTEGER NOT NULL REFERENCES tenant (tenant_id),
  ketto_num TEXT NOT NULL,
  race_id TEXT NOT NULL,
  run_date TEXT NULL,
  venue_code TEXT NULL,
  race_no INTEGER NULL,
  umaban INTEGER NULL,
  finish INTEGER NULL,
  odds REAL NULL CHECK (odds IS NULL OR odds > 0),
  popularity INTEGER NULL,
  kyakusitu_kubun TEXT NULL,
  corner1 INTEGER NULL,
  corner2 INTEGER NULL,
  corner3 INTEGER NULL,
  corner4 INTEGER NULL,
  time_str TEXT NULL,
  time_diff_str TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, ketto_num, race_id)
);
CREATE INDEX ix_horse_past_runs_date ON horse_past_runs (tenant_id, run_date);

CREATE TABLE odds_snapshots (
  tenant_id INTEGER NOT NULL,
  race_id TEXT NOT NULL,
  market TEXT NOT NULL CHECK (market IN ('win', 'wide', 'sanrenpuku')),
  observed_at TEXT NOT NULL,
  umaban INTEGER NOT NULL CHECK (umaban BETWEEN 1 AND 99),
  odds REAL NOT NULL CHECK (odds > 0),
  popularity INTEGER NULL CHECK (popularity IS NULL OR popularity >= 0),
  PRIMARY KEY (tenant_id, race_id, market, observed_at, umaban),
  CONSTRAINT fk_odds_race FOREIGN KEY (tenant_id, race_id) REFERENCES races (tenant_id, race_id)
);

CREATE TABLE combo_odds_snapshots (
  tenant_id INTEGER NOT NULL,
  race_id TEXT NOT NULL,
  market TEXT NOT NULL CHECK (market IN ('win', 'wide', 'sanrenpuku')),
  collected_at TEXT NOT NULL,
  combo_key TEXT NOT NULL CHECK (length(combo_key) <= 16),
  odds REAL NOT NULL CHECK (odds > 0),
  popularity INTEGER NULL,
  source TEXT NULL,
  rt_key TEXT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, race_id, market, collected_at, combo_key),
  CONSTRAINT fk_combo_odds_race FOREIGN KEY (tenant_id, race_id) REFERENCES races (tenant_id, race_id)
);

CREATE TABLE results (
  tenant_id INTEGER NOT NULL,
  race_id TEXT NOT NULL,
  umaban INTEGER NOT NULL CHECK (umaban BETWEEN 1 AND 99),
  finish INTEGER NULL,
  payout REAL NULL CHECK (payout IS NULL OR payout >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, race_id, umaban),
  CONSTRAINT fk_results_race FOREIGN KEY (tenant_id, race_id) REFERENCES races (tenant_id, race_id)
);

CREATE TABLE payouts (
  tenant_id INTEGER NOT NULL,
  race_id TEXT NOT NULL,
  market TEXT NOT NULL CHECK (market IN ('win', 'wide', 'sanrenpuku')),
  combo_key TEXT NOT NULL CHECK (length(combo_key) <= 16),
  payout REAL NOT NULL CHECK (payout >= 0),
  is_provisional INTEGER NOT NULL DEFAULT 0 CHECK (is_provisional IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, race_id, market, combo_key),
  CONSTRAINT fk_payouts_race FOREIGN KEY (tenant_id, race_id) REFERENCES races (tenant_id, race_id)
);

CREATE TABLE signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  legacy_id INTEGER NULL,
  race_id TEXT NOT NULL,
  market TEXT NOT NULL CHECK (market IN ('win', 'wide', 'sanrenpuku')),
  umaban INTEGER NOT NULL CHECK (umaban BETWEEN 1 AND 99),
  observed_at TEXT NOT NULL,
  odds REAL NOT NULL CHECK (odds > 0),
  prob REAL NOT NULL CHECK (prob BETWEEN 0 AND 1),
  ev REAL NOT NULL,
  is_paper INTEGER NOT NULL DEFAULT 1 CHECK (is_paper IN (0, 1)),
  stake REAL NOT NULL DEFAULT 1.0 CHECK (stake >= 0),
  expected_profit REAL NULL,
  skip_reason TEXT NULL CHECK (skip_reason IS NULL OR length(skip_reason) <= 200),
  kelly_raw REAL NULL,
  kelly_adj REAL NULL,
  bet_before_clip REAL NULL,
  clipped INTEGER NOT NULL DEFAULT 0 CHECK (clipped IN (0, 1)),
  mkt REAL NULL,
  mkt_adj REAL NULL,
  ratio REAL NULL,
  expected_return REAL NULL,
  suggested_bet REAL NULL,
  prob_source TEXT NULL CHECK (prob_source IS NULL OR length(prob_source) <= 100),
  reason TEXT NULL CHECK (reason IS NULL OR length(reason) <= 500),
  notify_state TEXT NOT NULL DEFAULT 'UNSENT' CHECK (notify_state IN ('UNSENT', 'CLAIMED', 'SENT', 'SEND_UNKNOWN')),
  notify_updated_at TEXT NULL,
  created_at TEXT NOT NULL,
  CONSTRAINT uq_signals_natural UNIQUE (tenant_id, race_id, market, umaban, observed_at),
  CONSTRAINT uq_signals_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_signals_legacy UNIQUE (tenant_id, legacy_id),
  CONSTRAINT fk_signals_race FOREIGN KEY (tenant_id, race_id) REFERENCES races (tenant_id, race_id)
);
CREATE INDEX ix_signals_unsent ON signals (tenant_id, notify_state, id);

CREATE TABLE bets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  legacy_id INTEGER NULL,
  race_id TEXT NOT NULL,
  placed_at TEXT NOT NULL,
  market TEXT NOT NULL DEFAULT 'win' CHECK (market IN ('win', 'wide', 'sanrenpuku')),
  stake REAL NOT NULL CHECK (stake >= 0),
  source TEXT NOT NULL DEFAULT 'paper' CHECK (source IN ('paper', 'manual')),
  note TEXT NULL,
  selection TEXT NULL,
  odds_at_bet REAL NULL CHECK (odds_at_bet IS NULL OR odds_at_bet > 0),
  prob_used_for_bet REAL NULL,
  ev REAL NULL,
  expected_profit REAL NULL,
  signal_id INTEGER NULL,
  status TEXT NULL,
  settled_at TEXT NULL,
  payout REAL NULL,
  profit REAL NULL,
  skip_reason TEXT NULL,
  created_at TEXT NOT NULL,
  CONSTRAINT uq_bets_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_bets_legacy UNIQUE (tenant_id, legacy_id),
  CONSTRAINT fk_bets_race FOREIGN KEY (tenant_id, race_id) REFERENCES races (tenant_id, race_id),
  CONSTRAINT fk_bets_signal FOREIGN KEY (tenant_id, signal_id) REFERENCES signals (tenant_id, id)
);
CREATE INDEX ix_bets_race ON bets (tenant_id, race_id, placed_at);
CREATE INDEX ix_bets_signal ON bets (tenant_id, signal_id);

CREATE TABLE bet_legs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  legacy_id INTEGER NULL,
  bet_id INTEGER NOT NULL,
  umaban INTEGER NOT NULL CHECK (umaban BETWEEN 1 AND 99),
  odds_at_bet REAL NOT NULL CHECK (odds_at_bet > 0),
  prob_at_bet REAL NULL,
  ev_at_bet REAL NULL,
  created_at TEXT NOT NULL,
  CONSTRAINT uq_bet_legs_legacy UNIQUE (tenant_id, legacy_id),
  CONSTRAINT fk_bet_legs_bet FOREIGN KEY (tenant_id, bet_id) REFERENCES bets (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX ix_bet_legs_bet ON bet_legs (tenant_id, bet_id);

CREATE TABLE race_evaluations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  legacy_id INTEGER NULL,
  race_id TEXT NOT NULL,
  snapshot_at TEXT NOT NULL,
  model_type_used TEXT NULL,
  model_path_used TEXT NULL,
  model_id TEXT NULL,
  fallback_reason TEXT NULL,
  bet_types TEXT NULL CHECK (bet_types IS NULL OR json_valid(bet_types)),
  priority_mode TEXT NULL,
  ev_threshold REAL NULL,
  win_odds_max REAL NULL,
  win_prob_min REAL NULL,
  win_ratio_min REAL NULL,
  best_candidate_json TEXT NULL CHECK (best_candidate_json IS NULL OR json_valid(best_candidate_json)),
  best_ev REAL NULL,
  rejection_summary_json TEXT NULL CHECK (rejection_summary_json IS NULL OR json_valid(rejection_summary_json)),
  signal_sent INTEGER NOT NULL DEFAULT 0 CHECK (signal_sent IN (0, 1)),
  settled_at TEXT NULL,
  hit INTEGER NULL,
  payout_used REAL NULL,
  is_provisional INTEGER NOT NULL DEFAULT 0,
  settle_status TEXT NULL,
  best_win_hint_json TEXT NULL CHECK (best_win_hint_json IS NULL OR json_valid(best_win_hint_json)),
  created_at TEXT NOT NULL,
  CONSTRAINT uq_race_evaluations_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_race_evaluations_legacy UNIQUE (tenant_id, legacy_id),
  CONSTRAINT fk_race_evaluations_race FOREIGN KEY (tenant_id, race_id) REFERENCES races (tenant_id, race_id)
);
CREATE INDEX ix_race_evaluations_race ON race_evaluations (tenant_id, race_id, snapshot_at);

CREATE TABLE ticket_evaluations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  legacy_id INTEGER NULL,
  race_evaluation_id INTEGER NOT NULL,
  race_id TEXT NOT NULL,
  snapshot_at TEXT NOT NULL,
  bet_type TEXT NOT NULL,
  combo_key TEXT NULL,
  umaban INTEGER NULL,
  odds REAL NOT NULL CHECK (odds > 0),
  p_model REAL NULL,
  p_mkt REAL NULL,
  p_final REAL NULL,
  ratio REAL NULL,
  ev REAL NULL,
  stake REAL NULL,
  rank_no INTEGER NULL,
  reject_reason TEXT NULL,
  accepted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  CONSTRAINT uq_ticket_evaluations_legacy UNIQUE (tenant_id, legacy_id),
  CONSTRAINT fk_ticket_evaluations_eval FOREIGN KEY (tenant_id, race_evaluation_id) REFERENCES race_evaluations (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_ticket_evaluations_race FOREIGN KEY (tenant_id, race_id) REFERENCES races (tenant_id, race_id)
);
CREATE INDEX ix_ticket_evaluations_eval ON ticket_evaluations (tenant_id, race_evaluation_id);
CREATE INDEX ix_ticket_evaluations_race ON ticket_evaluations (tenant_id, race_id, snapshot_at);

CREATE TABLE model_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES tenant (tenant_id),
  legacy_id INTEGER NULL,
  date_from TEXT NULL,
  date_to TEXT NULL,
  market TEXT NOT NULL DEFAULT 'win' CHECK (market IN ('win', 'wide', 'sanrenpuku')),
  sample_count INTEGER NOT NULL CHECK (sample_count >= 0),
  brier REAL NULL,
  logloss REAL NULL,
  calibration_json TEXT NULL CHECK (calibration_json IS NULL OR json_valid(calibration_json)),
  created_at TEXT NOT NULL,
  CONSTRAINT uq_model_metrics_legacy UNIQUE (tenant_id, legacy_id)
);
CREATE INDEX ix_model_metrics_market_date ON model_metrics (tenant_id, market, date_from, date_to);

CREATE TABLE ingest_cursor (
  tenant_id INTEGER NOT NULL REFERENCES tenant (tenant_id),
  data_type TEXT NOT NULL,
  last_file_timestamp TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, data_type)
);

CREATE TABLE import_quarantine (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES tenant (tenant_id),
  migration_run TEXT NOT NULL,
  source_table TEXT NOT NULL,
  source_key TEXT NULL,
  reason_code TEXT NOT NULL,
  reason_detail TEXT NULL,
  payload TEXT NULL CHECK (payload IS NULL OR json_valid(payload)),
  created_at TEXT NOT NULL,
  resolved_at TEXT NULL
);
CREATE INDEX ix_import_quarantine_run ON import_quarantine (tenant_id, migration_run, source_table);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES tenant (tenant_id),
  occurred_at TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('USER', 'AGENT', 'SYSTEM')),
  actor TEXT NOT NULL CHECK (length(actor) <= 254),
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NULL,
  before_json TEXT NULL CHECK (before_json IS NULL OR json_valid(before_json)),
  after_json TEXT NULL CHECK (after_json IS NULL OR json_valid(after_json)),
  reason TEXT NULL CHECK (reason IS NULL OR length(reason) <= 500),
  request_id TEXT NULL
);
CREATE INDEX ix_audit_log_time ON audit_log (tenant_id, occurred_at);
