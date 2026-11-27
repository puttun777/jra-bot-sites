/**
 * JRA 公式サイトから取得して取込む（第 1 優先の取得方式: プログラムで直接。ChatGPT の推論を使わない）。
 * 取得（integrations/jra）と保存（ingestBatch）を分ける。ローカル CLI からも、サイト（外部通信が可能なら: SITES_CONSTRAINTS E-3）からも使う。
 */
import type { JraClient } from "../integrations/jra/client.js";
import { fetchCard, fetchResults } from "../integrations/jra/fetch.js";
import { sha256Hex } from "../domain/race.js";
import { ingestBatch, TENANT_ID, type IngestSummary, type Services } from "./services.js";

export const JRA_AGENT_ID = "jra-web";

export interface JraFetchResult {
  readonly what: "card" | "results";
  readonly date: string;
  readonly requests: number;
  readonly records: number;
  readonly notes: readonly string[];
  readonly ingest: IngestSummary | null;
}

export async function fetchJraAndIngest(s: Services, client: JraClient, what: "card" | "results", date: string, venue?: string): Promise<JraFetchResult> {
  const now = s.clock.now();
  const env = what === "card" ? await fetchCard(client, date, now, venue) : await fetchResults(client, date, now, venue);
  const records = env.records;
  if (records.length === 0) return { what, date, requests: client.requests, records: 0, notes: env.notes, ingest: null };
  if ((await s.agents.find(TENANT_ID, JRA_AGENT_ID)) === null) {
    await s.agents.create(TENANT_ID, { agentId: JRA_AGENT_ID, name: "JRA 公式サイトの取得", tokenHash: await sha256Hex(`${JRA_AGENT_ID}:${now.toISOString()}:${Math.random()}`), expiresAt: "2099-12-31T00:00:00.000Z", createdBy: "system" }, now.toISOString());
  }
  // batchId は内容から決める（同じ内容を何度取得しても二重に記録しない）
  const payload = records.map((r) => ({ id: r.id, payload: JSON.stringify(r.data) }));
  const h = await sha256Hex(JSON.stringify(payload));
  const batchId = `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h.charAt(16), 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
  const ingest = await ingestBatch(s, JRA_AGENT_ID, { batchId, source: env.source, observedAt: env.observedAt, records: payload });
  return { what, date, requests: client.requests, records: records.length, notes: env.notes, ingest };
}
