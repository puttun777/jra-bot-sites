/**
 * ChatGPT 連携用の MCP サーバ（JSON-RPC 2.0、Streamable HTTP の「1 リクエスト = 1 JSON 応答」だけ。SSE・セッションは使わない）。
 * Sites の正式な MCP の登録方法・認証方式は**未確認**（docs/SITES_CONSTRAINTS.md E-4）。ここは業務処理とインタフェースまでで、
 * 認証はベアラートークン（取込クライアント）を使う。Sites 固有の接続は引き継ぎ（docs/HANDOFF.md §MCP）。
 *
 * 利用枠の節約のため: 一括登録（1 呼び出し最大 200 レコード）・差分だけの応答（件数と先頭 10 件の問題だけ）・取得計画（get_fetch_plan）で
 * 「未取得・変更が要るものだけ」を ChatGPT に伝える。
 */
import { z } from "zod";
import { performanceReport, replayAllPending, runAnalysis, syncStatus, TENANT_ID, type Services } from "../application/services.js";
import { addDays, jstDate, uuid } from "../domain/race.js";
import type { Principal } from "./auth.js";
import { raceDetail, ingestEnvelope } from "./router.js";
import { fetchJraAndIngest } from "../application/jraFetch.js";
import { JraClient } from "../integrations/jra/client.js";
import { instantSchema, isoDate, raceIdSchema } from "./schemas.js";

const PROTOCOL_VERSION = "2025-06-18";

const nonEmpty = <T extends z.ZodType>(t: T) => z.array(t).min(1).max(200);
const baseIngest = { observedAt: instantSchema.describe("データを取得した時刻（ISO 8601）"), source: z.string().regex(/^[a-z0-9_-]{1,16}$/).default("chatgpt").describe("取得元の識別子") };

const TOOLS = {
  get_sync_status: {
    description: "本日の取得状況（予定・オッズ・結果・払戻の有無、保留・失敗件数、直近の取込）を返す。最初に呼ぶ。",
    input: z.object({}).strict(),
  },
  get_fetch_plan: {
    description: "指定日の『まだ取得していない・更新が必要なデータ』だけを返す（全件の再取得を避けるため）。",
    input: z.object({ date: isoDate.optional() }).strict(),
  },
  list_races: { description: "指定日の開催予定（レース一覧）。", input: z.object({ date: isoDate.optional() }).strict() },
  get_race: { description: "1 レースの詳細（最新オッズ・結果・払戻・判定）。", input: z.object({ raceId: raceIdSchema }).strict() },
  upsert_race_days: {
    description: "開催日（場ごと）を登録・更新する。status は PLANNED/CANCELLED/POSTPONED。",
    input: z
      .object({
        ...baseIngest,
        days: nonEmpty(z.object({ date: isoDate, venue: z.string().regex(/^(0[1-9]|10)$/), kai: z.number().int().min(1).max(99), nichime: z.number().int().min(1).max(99), status: z.enum(["PLANNED", "CANCELLED", "POSTPONED"]), replacedBy: isoDate.nullable().default(null) }).strict()),
      })
      .strict(),
  },
  upsert_races: {
    description: "レース（出馬表の段階なら発走時刻つき）を登録・更新する。kubun: 1=出走馬名表, 2=出馬表, 9=中止, 0=削除。createdOn はその情報の作成日。",
    input: z
      .object({
        ...baseIngest,
        races: nonEmpty(
          z.object({ raceId: raceIdSchema, kubun: z.enum(["1", "2", "9", "0"]), createdOn: isoDate, postTime: z.string().regex(/^\d{2}:\d{2}$/).nullable(), raceName: z.string().max(100).nullable(), kai: z.number().int().min(1).max(99).nullable(), nichime: z.number().int().min(1).max(99).nullable() }).strict(),
        ),
      })
      .strict(),
  },
  upsert_odds: {
    description: "発走前のオッズ（単勝・ワイド・三連複）を登録する。observedAt は実際に取得した時刻（確定オッズを発走前の値として登録しない）。",
    input: z
      .object({
        ...baseIngest,
        raceId: raceIdSchema,
        win: z.array(z.object({ umaban: z.number().int().min(1).max(99), odds: z.number().positive(), popularity: z.number().int().min(0).nullable() }).strict()).max(99).default([]),
        wide: z.array(z.object({ a: z.number().int(), b: z.number().int(), low: z.number().positive(), high: z.number().positive().nullable() }).strict()).max(200).default([]),
        sanrenpuku: z.array(z.object({ a: z.number().int(), b: z.number().int(), c: z.number().int(), odds: z.number().positive() }).strict()).max(1000).default([]),
      })
      .strict(),
  },
  upsert_results: {
    description: "着順と払戻（100 円あたりの円）を登録する。払戻のキーは 0 埋めの昇順（単勝 07 / ワイド 02-07 / 三連複 02-07-09）。",
    input: z
      .object({
        ...baseIngest,
        raceId: raceIdSchema,
        finishes: z.array(z.object({ umaban: z.number().int().min(1).max(99), finish: z.number().int().min(1).max(99).nullable() }).strict()).max(99).default([]),
        payouts: z.array(z.object({ market: z.enum(["win", "wide", "sanrenpuku"]), key: z.string(), payout: z.number().positive() }).strict()).max(100).default([]),
        provisional: z.boolean().default(false),
      })
      .strict(),
  },
  fetch_jra: {
    description: "JRA 公式サイトから直接取得して登録する（card = 開催日・出馬表、results = 着順・払戻）。サイトから外部へ通信できない環境では失敗する。オッズは未対応（upsert_odds を使う）。",
    input: z.object({ what: z.enum(["card", "results"]), date: isoDate, venue: z.string().regex(/^(0[1-9]|10)$/).optional() }).strict(),
  },
  run_analysis: { description: "判定（EV・買い目）を実行する。date か raceId。同じオッズで判定済みなら何もしない。", input: z.object({ date: isoDate.optional(), raceId: raceIdSchema.optional() }).strict() },
  get_analysis_results: { description: "指定日のシグナル（推奨）の要約。", input: z.object({ date: isoDate.optional(), limit: z.number().int().min(1).max(100).default(30) }).strict() },
  get_performance: { description: "紙上成績（期間。既定は直近 30 日）。", input: z.object({ from: isoDate.optional(), to: isoDate.optional() }).strict() },
  list_failed_records: { description: "保留・失敗した取込レコード（先頭 20 件）。", input: z.object({}).strict() },
  retry_pending: { description: "保留中の取込レコードを再適用する。", input: z.object({}).strict() },
} as const;

type ToolName = keyof typeof TOOLS;
function isTool(n: string): n is ToolName {
  return Object.hasOwn(TOOLS, n);
}

interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id?: string | number | null;
  readonly method: string;
  readonly params?: unknown;
}
function isRpc(v: unknown): v is JsonRpcRequest {
  return typeof v === "object" && v !== null && (v as { jsonrpc?: unknown }).jsonrpc === "2.0" && typeof (v as { method?: unknown }).method === "string";
}

function rpcResult(id: string | number | null | undefined, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, result }), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
function rpcError(id: string | number | null | undefined, code: number, message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

export function toolList() {
  return Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: z.toJSONSchema(t.input, { io: "input" }) }));
}

export async function handleMcp(req: Request, s: Services, principal: Principal): Promise<Response> {
  let msg: unknown;
  try {
    msg = await req.json();
  } catch {
    return rpcError(null, -32700, "Parse error");
  }
  if (!isRpc(msg)) return rpcError(null, -32600, "Invalid Request");
  switch (msg.method) {
    case "initialize":
      return rpcResult(msg.id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "jra-bot-sites", version: "0.1.0" } });
    case "notifications/initialized":
      return new Response(null, { status: 202 });
    case "ping":
      return rpcResult(msg.id, {});
    case "tools/list":
      return rpcResult(msg.id, { tools: toolList() });
    case "tools/call": {
      const p = msg.params as { name?: unknown; arguments?: unknown } | undefined;
      const name = typeof p?.name === "string" ? p.name : "";
      if (!isTool(name)) return rpcError(msg.id, -32602, "Unknown tool");
      try {
        const out = await callTool(s, principal, name, p?.arguments ?? {});
        return rpcResult(msg.id, { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out, isError: false });
      } catch (e) {
        // 入力の誤りはツールの結果として返す（ChatGPT が直せるように理由だけ。内部の詳細は出さない）
        const text = e instanceof z.ZodError ? `invalid arguments: ${e.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` : `failed: ${e instanceof Error ? e.name : "Error"}`;
        return rpcResult(msg.id, { content: [{ type: "text", text }], isError: true });
      }
    }
    default:
      return rpcError(msg.id, -32601, "Method not found");
  }
}

function envelope(observedAt: string, source: string, records: { id: "NYS" | "NRA" | "NOW" | "NOD" | "NOS" | "NRS" | "NHR"; data: Record<string, unknown> }[]) {
  return { batchId: uuid(), source, observedAt, records };
}

export async function callTool(s: Services, principal: Principal, name: ToolName, rawArgs: unknown): Promise<Record<string, unknown>> {
  const today = jstDate(s.clock.now());
  switch (name) {
    case "get_sync_status":
      TOOLS.get_sync_status.input.parse(rawArgs);
      return syncStatus(s);
    case "get_fetch_plan": {
      const a = TOOLS.get_fetch_plan.input.parse(rawArgs);
      const date = a.date ?? today;
      const st = await syncStatus(s);
      const races = date === today ? st.races : (await s.schedules.listByDate(TENANT_ID, date)).map((r) => ({ raceId: r.raceId, status: r.status, postAt: r.scheduledPostAt, latestWinOddsAt: null, hasResult: false, hasPayout: false }));
      const now = s.clock.now().getTime();
      return {
        date,
        needSchedule: races.length === 0,
        needCards: races.filter((r) => r.postAt === null && r.status !== "CANCELLED").map((r) => r.raceId),
        needOdds: races.filter((r) => r.postAt !== null && Date.parse(r.postAt) > now && r.latestWinOddsAt === null).map((r) => r.raceId),
        needResults: races.filter((r) => r.postAt !== null && Date.parse(r.postAt) + 15 * 60_000 < now && (!r.hasResult || !r.hasPayout)).map((r) => r.raceId),
        note: "need* に挙がったものだけを取得してください。オッズは発走前に取得した値だけを登録し、取得時刻を observedAt に入れてください。",
      };
    }
    case "list_races": {
      const a = TOOLS.list_races.input.parse(rawArgs);
      const rows = await s.schedules.listByDate(TENANT_ID, a.date ?? today);
      return { date: a.date ?? today, races: rows.map((r) => ({ raceId: r.raceId, name: r.raceName, postAt: r.scheduledPostAt, status: r.status })) };
    }
    case "get_race": {
      const a = TOOLS.get_race.input.parse(rawArgs);
      return raceDetail(s, a.raceId);
    }
    case "upsert_race_days": {
      const a = TOOLS.upsert_race_days.input.parse(rawArgs);
      const recs = a.days.map((d) => ({ id: "NYS" as const, data: { date: d.date.replaceAll("-", ""), venue: d.venue, kai: d.kai, nichime: d.nichime, status: d.status, replacedBy: d.replacedBy === null ? null : d.replacedBy.replaceAll("-", "") } }));
      return { ...(await ingestEnvelope(s, principal.id, envelope(a.observedAt, a.source, recs))) };
    }
    case "upsert_races": {
      const a = TOOLS.upsert_races.input.parse(rawArgs);
      const recs = a.races.map((r) => ({ id: "NRA" as const, data: { raceId: r.raceId, kubun: r.kubun, createdOn: r.createdOn.replaceAll("-", ""), postTime: r.postTime === null ? null : r.postTime.replace(":", ""), raceName: r.raceName, kai: r.kai, nichime: r.nichime } }));
      return { ...(await ingestEnvelope(s, principal.id, envelope(a.observedAt, a.source, recs))) };
    }
    case "upsert_odds": {
      const a = TOOLS.upsert_odds.input.parse(rawArgs);
      const recs: { id: "NOW" | "NOD" | "NOS"; data: Record<string, unknown> }[] = [];
      if (a.win.length > 0) recs.push({ id: "NOW", data: { raceId: a.raceId, entries: a.win.map((e) => ({ umaban: e.umaban, odds: e.odds, pop: e.popularity })) } });
      if (a.wide.length > 0) recs.push({ id: "NOD", data: { raceId: a.raceId, entries: a.wide.map((e) => ({ a: e.a, b: e.b, low: e.low, high: e.high, pop: null })) } });
      if (a.sanrenpuku.length > 0) recs.push({ id: "NOS", data: { raceId: a.raceId, entries: a.sanrenpuku.map((e) => ({ a: e.a, b: e.b, c: e.c, odds: e.odds, pop: null })) } });
      if (recs.length === 0) throw new z.ZodError([{ code: "custom", path: ["win"], message: "win・wide・sanrenpuku のどれかが必要", input: undefined }]);
      return { ...(await ingestEnvelope(s, principal.id, envelope(a.observedAt, a.source, recs))) };
    }
    case "upsert_results": {
      const a = TOOLS.upsert_results.input.parse(rawArgs);
      const recs: { id: "NRS" | "NHR"; data: Record<string, unknown> }[] = [];
      if (a.finishes.length > 0) recs.push({ id: "NRS", data: { raceId: a.raceId, entries: a.finishes } });
      for (const market of ["win", "wide", "sanrenpuku"] as const) {
        const rows = a.payouts.filter((p) => p.market === market);
        if (rows.length > 0) recs.push({ id: "NHR", data: { raceId: a.raceId, market, provisional: a.provisional, entries: rows.map((r) => ({ key: r.key, payout: r.payout })) } });
      }
      if (recs.length === 0) throw new z.ZodError([{ code: "custom", path: ["finishes"], message: "finishes か payouts が必要", input: undefined }]);
      return { ...(await ingestEnvelope(s, principal.id, envelope(a.observedAt, a.source, recs))) };
    }
    case "fetch_jra": {
      const a = TOOLS.fetch_jra.input.parse(rawArgs);
      const r = await fetchJraAndIngest(s, new JraClient(), a.what, a.date, a.venue);
      return { ...r, ingest: r.ingest === null ? null : { status: r.ingest.status, applied: r.ingest.applied, unchanged: r.ingest.unchanged, deferred: r.ingest.deferred, quarantined: r.ingest.quarantined } };
    }
    case "run_analysis": {
      const a = TOOLS.run_analysis.input.parse(rawArgs);
      const r = await runAnalysis(s, { ...a, trigger: "MANUAL", actor: `agent:${principal.id}` });
      return { ...r, races: r.races.filter((x) => x.status !== "NOT_IN_WINDOW").slice(0, 40) };
    }
    case "get_analysis_results": {
      const a = TOOLS.get_analysis_results.input.parse(rawArgs);
      const p = await s.signals.pageByDate(TENANT_ID, a.date ?? today, 0, a.limit);
      return { date: a.date ?? today, total: p.total, signals: p.items.map((x) => ({ raceId: x.raceId, market: x.market, umaban: x.umaban, odds: x.odds, ev: x.ev, stake: x.stake, observedAt: x.observedAt })) };
    }
    case "get_performance": {
      const a = TOOLS.get_performance.input.parse(rawArgs);
      const to = a.to ?? today;
      const r = await performanceReport(s, a.from ?? addDays(to, -30), to);
      return { ...r };
    }
    case "list_failed_records": {
      TOOLS.list_failed_records.input.parse(rawArgs);
      const pending = await s.ingest.allPending(TENANT_ID, 20);
      const failed = await s.db.prepare("SELECT record_id, parse_error, received_at FROM ingest_raw WHERE tenant_id = ? AND parse_status = 'FAILED' ORDER BY received_at DESC LIMIT 20").bind(TENANT_ID).all();
      return { pending: pending.map((x) => ({ recordId: x.recordId, reason: x.parseError, batchId: x.batchId })), failed: failed.results };
    }
    case "retry_pending":
      TOOLS.retry_pending.input.parse(rawArgs);
      return replayAllPending(s);
  }
}
