/**
 * データ保持（jra-bot-web@7bcf1c4 domain/retention/Retention.kt の移植。D1 の容量対策: docs/DATABASE.md §5）。
 * 削除してよいのは再取得できる、または役目を終えた記録だけ。成績の元（races・results・payouts・signals・evaluations・単勝オッズ）は対象外。
 * **既定はドライラン**（件数を数えるだけ）。削除は execute=true のときだけ。1 回の呼び出しで 1 対象あたり最大 MAX_PER_CALL 行（Sites の実行時間の上限に備える。
 * 残りがあれば truncated=true になるので、もう一度呼ぶ）。冪等。
 * 注意（Sites 版）: 組オッズを消すと、その期間のワイド・三連複は再判定（バックテスト）できなくなる。
 */
import type { SqlDatabase } from "../infrastructure/db/sql.js";

export type RetentionTarget = "COMBO_ODDS" | "INGEST_RAW" | "SCHEDULE_EVENTS" | "BOT_RUNS";

/** 既定の保持日数（web と同じ: 組オッズ 14・生レコード 30・履歴 365・実行記録 365）。 */
export const DEFAULT_RETENTION_DAYS: Readonly<Record<RetentionTarget, number>> = { COMBO_ODDS: 14, INGEST_RAW: 30, SCHEDULE_EVENTS: 365, BOT_RUNS: 365 };
export const MIN_DAYS = 7;
export const MAX_DAYS = 3650;
export const MAX_PER_CALL = 5000;

/** 対象ごとの表・時刻の列・追加の条件（固定の文字列だけ。入力から SQL を作らない）。 */
const SPEC: Readonly<Record<RetentionTarget, { table: string; column: string; extra: string }>> = {
  COMBO_ODDS: { table: "combo_odds_snapshots", column: "collected_at", extra: "" },
  INGEST_RAW: { table: "ingest_raw", column: "received_at", extra: " AND parse_status <> 'PENDING'" },
  SCHEDULE_EVENTS: { table: "race_schedule_event", column: "received_at", extra: "" },
  BOT_RUNS: { table: "bot_run", column: "started_at", extra: " AND active_slot IS NULL" },
};

export interface RetentionLine {
  readonly target: RetentionTarget;
  readonly cutoff: string;
  readonly eligible: number;
  readonly deleted: number;
  readonly truncated: boolean;
}

export async function runRetention(db: SqlDatabase, tenantId: number, now: Date, execute: boolean, days: Partial<Record<RetentionTarget, number>> = {}): Promise<{ dryRun: boolean; lines: RetentionLine[] }> {
  const lines: RetentionLine[] = [];
  for (const target of Object.keys(SPEC) as RetentionTarget[]) {
    const d = days[target] ?? DEFAULT_RETENTION_DAYS[target];
    if (!Number.isInteger(d) || d < MIN_DAYS || d > MAX_DAYS) throw new RangeError(`保持日数は ${MIN_DAYS}〜${MAX_DAYS} 日`);
    const cutoff = new Date(now.getTime() - d * 86_400_000).toISOString();
    const sp = SPEC[target];
    const where = `tenant_id = ? AND ${sp.column} < ?${sp.extra}`;
    const c = await db.prepare(`SELECT COUNT(*) AS n FROM ${sp.table} WHERE ${where}`).bind(tenantId, cutoff).first<{ n: number }>();
    const eligible = c?.n ?? 0;
    let deleted = 0;
    if (execute && eligible > 0) {
      const r = await db.prepare(`DELETE FROM ${sp.table} WHERE rowid IN (SELECT rowid FROM ${sp.table} WHERE ${where} LIMIT ?)`).bind(tenantId, cutoff, MAX_PER_CALL).run();
      deleted = r.meta.changes;
    }
    lines.push({ target, cutoff, eligible, deleted, truncated: execute && eligible > deleted });
  }
  return { dryRun: !execute, lines };
}
