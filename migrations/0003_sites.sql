-- Sites 版で追加するもの（jra-bot-web には無い。docs/DATABASE.md §3）。
-- 1) 運用モード（旧 infra の NORMAL/STOPPED。AWS/GCP のパラメータに置いていた値を DB に持つ）
CREATE TABLE ops_mode (
  tenant_id INTEGER NOT NULL PRIMARY KEY REFERENCES tenant (tenant_id),
  mode TEXT NOT NULL CHECK (mode IN ('NORMAL', 'STOPPED')),
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL CHECK (length(updated_by) BETWEEN 1 AND 254),
  reason TEXT NULL CHECK (reason IS NULL OR length(reason) <= 500)
);

-- 2) 単一利用者（最大 2 名）の運用でもテナント境界は省略しない。初期テナントは 1。
INSERT INTO tenant (tenant_id, name, created_at) VALUES (1, 'default', '2026-11-27T00:00:00.000Z');
INSERT INTO ops_mode (tenant_id, mode, updated_at, updated_by, reason) VALUES (1, 'NORMAL', '2026-11-27T00:00:00.000Z', 'migration', NULL);
