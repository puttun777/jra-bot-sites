/**
 * ローカル用のマイグレーション実行（migrations/NNNN_*.sql を番号順に 1 回ずつ）。記録は wrangler の D1 と同じ名前の表 `d1_migrations`。
 * 本番 D1 への適用はこのコードでは行わない（Sites の手順。docs/HANDOFF.md §DB）。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { NodeSqliteDatabase } from "../infrastructure/db/nodeSqlite.js";

export function listMigrations(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
    .sort();
}

export function migrate(db: NodeSqliteDatabase, dir: string): string[] {
  db.execScript("CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);");
  const applied = new Set(db.raw.prepare("SELECT name FROM d1_migrations").all().map((r) => String(r["name"])));
  const done: string[] = [];
  for (const f of listMigrations(dir)) {
    if (applied.has(f)) continue;
    const sql = readFileSync(join(dir, f), "utf8");
    db.execScript("BEGIN");
    try {
      db.execScript(sql);
      db.raw.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(f);
      db.execScript("COMMIT");
    } catch (e) {
      db.execScript("ROLLBACK");
      throw new Error(`migration ${f} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    done.push(f);
  }
  return done;
}
