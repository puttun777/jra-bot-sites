/**
 * SQL の実行口（Cloudflare D1 の API の部分集合と同じ形）。本番は Sites の D1 バインディングをそのまま渡し、
 * ローカル・試験は node:sqlite の実装（nodeSqlite.ts）を使う。業務コードはこの型だけに依存する。
 *
 * 規則（D1 の制約に合わせる）:
 * - 明示的な BEGIN/COMMIT を書かない。複数文を原子的に反映するときは `batch()`（D1 は 1 トランザクションで実行する）。
 * - 値は必ずプレースホルダ（?）で渡す（文字列連結で SQL を作らない）。
 */
export type SqlValue = string | number | null;

export interface SqlRunMeta {
  readonly changes: number;
  readonly last_row_id: number;
}

export interface SqlResult<T> {
  readonly results: T[];
  readonly meta: SqlRunMeta;
}

export interface SqlStatement {
  bind(...values: SqlValue[]): SqlStatement;
  all<T = Record<string, unknown>>(): Promise<SqlResult<T>>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<SqlResult<never>>;
}

export interface SqlDatabase {
  prepare(sql: string): SqlStatement;
  batch(statements: SqlStatement[]): Promise<SqlResult<unknown>[]>;
}

/** 値の取り出し（DB の行は外部入力として扱い、型を実行時に確かめる）。 */
export function str(row: Record<string, unknown>, key: string): string {
  const v = row[key];
  if (typeof v !== "string") throw new Error(`column ${key} is not text`);
  return v;
}
export function optStr(row: Record<string, unknown>, key: string): string | null {
  const v = row[key];
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") throw new Error(`column ${key} is not text`);
  return v;
}
export function int(row: Record<string, unknown>, key: string): number {
  const v = row[key];
  if (typeof v === "bigint") return Number(v);
  if (typeof v !== "number" || !Number.isInteger(v)) throw new Error(`column ${key} is not integer`);
  return v;
}
export function optInt(row: Record<string, unknown>, key: string): number | null {
  const v = row[key];
  if (v === null || v === undefined) return null;
  return int(row, key);
}
export function real(row: Record<string, unknown>, key: string): number {
  const v = row[key];
  if (typeof v === "bigint") return Number(v);
  if (typeof v !== "number") throw new Error(`column ${key} is not number`);
  return v;
}
export function optReal(row: Record<string, unknown>, key: string): number | null {
  const v = row[key];
  if (v === null || v === undefined) return null;
  return real(row, key);
}
