/** 統合試験の共通部品（メモリ上の SQLite + マイグレーション + 固定時計）。合成データだけを使う。 */
import { join } from "node:path";
import { createServices, type Services } from "../../src/application/services.js";
import { handleRequest, type AppContext } from "../../src/api/router.js";
import type { AuthConfig } from "../../src/api/auth.js";
import { NodeSqliteDatabase } from "../../src/infrastructure/db/nodeSqlite.js";
import { migrate } from "../../src/local/migrate.js";
import type { Clock } from "../../src/domain/race.js";

export const MIGRATIONS = join(process.cwd(), "migrations");

export class FixedClock implements Clock {
  constructor(public at: Date) {}
  now(): Date {
    return new Date(this.at.getTime());
  }
  set(iso: string): void {
    this.at = new Date(iso);
  }
}

export function setup(nowIso = "2026-11-28T03:00:00.000Z"): { db: NodeSqliteDatabase; s: Services; clock: FixedClock } {
  const db = new NodeSqliteDatabase(":memory:");
  migrate(db, MIGRATIONS);
  const clock = new FixedClock(new Date(nowIso));
  const s = createServices(db, clock);
  return { db, s, clock };
}

export async function ensureAgent(s: Services, id = "test-agent"): Promise<void> {
  if ((await s.agents.find(1, id)) === null) await s.agents.create(1, { agentId: id, name: id, tokenHash: "f".repeat(64), expiresAt: "2099-01-01T00:00:00.000Z", createdBy: "test" }, "2026-01-01T00:00:00.000Z");
}

export const AUTH: AuthConfig = {
  emailHeader: "oai-authenticated-user-email",
  ownerEmails: ["owner@example.invalid"],
  viewerEmails: ["viewer@example.invalid"],
  ingestToken: "t".repeat(40),
  devUserEmail: null,
};

export function ctx(s: Services, auth: AuthConfig = AUTH): AppContext {
  return { services: s, auth, assets: null };
}

export async function call(c: AppContext, method: string, path: string, opts: { user?: string; body?: unknown; csrf?: boolean; bearer?: string } = {}): Promise<{ status: number; body: unknown }> {
  const headers = new Headers({ "content-type": "application/json" });
  if (opts.user !== undefined) headers.set("oai-authenticated-user-email", opts.user);
  if (opts.csrf ?? true) headers.set("x-requested-with", "jrabot-dashboard");
  if (opts.bearer !== undefined) headers.set("authorization", `Bearer ${opts.bearer}`);
  const req = new Request(`http://localhost${path}`, { method, headers, ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }) });
  const res = await handleRequest(req, c);
  const text = await res.text();
  return { status: res.status, body: text === "" ? null : (JSON.parse(text) as unknown) };
}

/** 合成の開催日 1 日分（2 レース）の正規化レコード。 */
export function syntheticDay(date: string): { id: string; payload: string }[] {
  const ymd = date.replaceAll("-", "");
  return [
    { id: "NYS", payload: JSON.stringify({ date: ymd, venue: "05", kai: 5, nichime: 8, status: "PLANNED", replacedBy: null }) },
    { id: "NRA", payload: JSON.stringify({ raceId: `${ymd}0511`, kubun: "2", createdOn: ymd, postTime: "1540", raceName: "合成記念", kai: 5, nichime: 8 }) },
    { id: "NRA", payload: JSON.stringify({ raceId: `${ymd}0512`, kubun: "2", createdOn: ymd, postTime: "1625", raceName: "合成S", kai: 5, nichime: 8 }) },
  ];
}

export function winOdds(raceId: string, odds: readonly number[]): { id: string; payload: string } {
  return { id: "NOW", payload: JSON.stringify({ raceId, entries: odds.map((o, i) => ({ umaban: i + 1, odds: o, pop: i + 1 })) }) };
}
