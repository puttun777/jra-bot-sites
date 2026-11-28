/**
 * JRA 公式サイトから取得して取込む（第 1 優先の取得方式: プログラムで直接。ChatGPT の推論を使わない）。
 * 取得（integrations/jra）と保存（ingestBatch）を分ける。ローカル CLI からも、サイト（外部通信が可能なら: SITES_CONSTRAINTS E-3）からも使う。
 */
import type { JraClient } from "../integrations/jra/client.js";
import { fetchCard, fetchOdds, fetchResults } from "../integrations/jra/fetch.js";
import { sha256Hex } from "../domain/race.js";
import { ingestBatch, TENANT_ID, type Services } from "./services.js";

export const JRA_AGENT_ID = "jra-web";
export type JraWhat = "card" | "results" | "odds";

export interface JraFetchResult {
  readonly what: JraWhat;
  readonly date: string;
  readonly requests: number;
  readonly batches: number;
  readonly records: number;
  readonly notes: readonly string[];
  /** 取込の合計（封筒が複数のときは足し合わせ）。何も取込まなかったら null。 */
  readonly ingest: { applied: number; unchanged: number; duplicates: number; deferred: number; rejected: number; quarantined: number; replayed: number; duplicateBatches: number } | null;
}

async function stableBatchId(seed: string): Promise<string> {
  const h = await sha256Hex(seed);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h.charAt(16), 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export async function fetchJraAndIngest(
  s: Services,
  client: JraClient,
  what: JraWhat,
  date: string,
  opts: { venue?: string; withinMinutes?: number } = {},
): Promise<JraFetchResult> {
  const now = s.clock.now();
  let envelopes: { observedAt: string; records: { id: string; data: Record<string, unknown> }[] }[];
  let notes: string[];
  if (what === "odds") {
    const r = await fetchOdds(client, date, now, opts);
    envelopes = r.envelopes;
    notes = r.notes;
  } else {
    const e = what === "card" ? await fetchCard(client, date, now, opts.venue) : await fetchResults(client, date, now, opts.venue);
    envelopes = e.records.length > 0 ? [e] : [];
    notes = e.notes;
  }
  const records = envelopes.reduce((a, e) => a + e.records.length, 0);
  if (records === 0) return { what, date, requests: client.requests, batches: 0, records: 0, notes, ingest: null };
  if ((await s.agents.find(TENANT_ID, JRA_AGENT_ID)) === null) {
    await s.agents.create(TENANT_ID, { agentId: JRA_AGENT_ID, name: "JRA 公式サイトの取得", tokenHash: await sha256Hex(`${JRA_AGENT_ID}:${now.toISOString()}:${crypto.randomUUID()}`), expiresAt: "2099-12-31T00:00:00.000Z", createdBy: "system" }, now.toISOString());
  }
  const total = { applied: 0, unchanged: 0, duplicates: 0, deferred: 0, rejected: 0, quarantined: 0, replayed: 0, duplicateBatches: 0 };
  for (const env of envelopes) {
    const payload = env.records.map((r) => ({ id: r.id, payload: JSON.stringify(r.data) }));
    // batchId は時点と内容から決める（同じ時点の同じ内容を何度取得しても二重に記録しない）
    const batchId = await stableBatchId(`${env.observedAt}|${JSON.stringify(payload)}`);
    const x = await ingestBatch(s, JRA_AGENT_ID, { batchId, source: "jra-web", observedAt: env.observedAt, records: payload });
    if (x.status === "DUPLICATE_BATCH") total.duplicateBatches++;
    total.applied += x.applied;
    total.unchanged += x.unchanged;
    total.duplicates += x.duplicates;
    total.deferred += x.deferred;
    total.rejected += x.rejected;
    total.quarantined += x.quarantined;
    total.replayed += x.replayed;
  }
  return { what, date, requests: client.requests, batches: envelopes.length, records, notes, ingest: total };
}
