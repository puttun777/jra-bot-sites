/**
 * ローカル・試験用の SqlDatabase（node:sqlite）。**本番（Sites の D1）では使わない**（sites/worker.ts は読み込まない）。
 * ここでの成功は D1 での成功を保証しない（docs/SITES_CONSTRAINTS.md の E 項目）。
 */
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { SqlDatabase, SqlResult, SqlStatement, SqlValue } from "./sql.js";

class NodeStatement implements SqlStatement {
  constructor(
    private readonly db: DatabaseSync,
    readonly sql: string,
    readonly params: readonly SqlValue[] = [],
  ) {}

  bind(...values: SqlValue[]): SqlStatement {
    return new NodeStatement(this.db, this.sql, values);
  }

  private args(): SQLInputValue[] {
    return [...this.params];
  }

  runSync(): SqlResult<never> {
    const r = this.db.prepare(this.sql).run(...this.args());
    return { results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }

  all<T>(): Promise<SqlResult<T>> {
    try {
      const rows = this.db.prepare(this.sql).all(...this.args());
      return Promise.resolve({ results: rows.map((r) => ({ ...r }) as T), meta: { changes: 0, last_row_id: 0 } });
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
  }

  first<T>(): Promise<T | null> {
    try {
      const row = this.db.prepare(this.sql).get(...this.args());
      return Promise.resolve(row === undefined ? null : ({ ...row } as T));
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
  }

  run(): Promise<SqlResult<never>> {
    try {
      return Promise.resolve(this.runSync());
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
  }
}

export class NodeSqliteDatabase implements SqlDatabase {
  readonly raw: DatabaseSync;

  constructor(path = ":memory:") {
    this.raw = new DatabaseSync(path);
    // D1 と同じく外部キーを強制する
    this.raw.exec("PRAGMA foreign_keys = ON;");
    if (path !== ":memory:") this.raw.exec("PRAGMA journal_mode = WAL;");
  }

  prepare(sql: string): SqlStatement {
    return new NodeStatement(this.raw, sql);
  }

  /** D1 の batch と同じく、全文を 1 トランザクションで実行する（1 文でも失敗すれば全体を戻す）。 */
  batch(statements: SqlStatement[]): Promise<SqlResult<unknown>[]> {
    const out: SqlResult<unknown>[] = [];
    this.raw.exec("BEGIN");
    try {
      for (const s of statements) {
        if (!(s instanceof NodeStatement)) throw new Error("foreign statement");
        if (/^\s*select/i.test(s.sql)) {
          const rows = this.raw.prepare(s.sql).all(...s.params);
          out.push({ results: rows, meta: { changes: 0, last_row_id: 0 } });
        } else {
          out.push(s.runSync());
        }
      }
      this.raw.exec("COMMIT");
    } catch (e) {
      this.raw.exec("ROLLBACK");
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
    return Promise.resolve(out);
  }

  /** マイグレーション用の複数文の実行（ローカル専用）。 */
  execScript(sql: string): void {
    this.raw.exec(sql);
  }

  close(): void {
    this.raw.close();
  }
}
