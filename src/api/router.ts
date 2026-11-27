/**
 * HTTP の入口（Web 標準の Request → Response。Sites（Workers 互換）とローカル（Node）で共通）。
 * 読取り API は jra-bot-web dashboard の ReadApi・MeController・AdminApi・MlModelApi・AgentAdminApi と**同じパス・同じ DTO**
 * （画面 src/web/schema.ts と契約見本 tests/web/contract で確認）。Sites 版で追加した管理操作は /api/v1/admin/* に置く。
 */
import type { z } from "zod";
import {
  createOverride,
  ingestBatch,
  IngestConflictError,
  performanceReport,
  PERFORMANCE_MAX_DAYS,
  replayAllPending,
  revokeOverride,
  runAnalysis,
  runDto,
  status,
  syncStatus,
  TENANT_ID,
  type Services,
} from "../application/services.js";
import type { CalendarOverride } from "../domain/calendar.js";
import { addDays, daysBetween, isIsoDate, jstDate, sha256Hex, uuid } from "../domain/race.js";
import { authenticateAgent, authenticateUser, CSRF_HEADER, newToken, type AuthConfig, type Principal } from "./auth.js";
import { handleMcp } from "./mcp.js";
import { CreateAgentRequest, CreateOverrideRequest, IngestEnvelopeRequest, RevokeAgentRequest, RunAnalysisRequest, SetModeRequest } from "./schemas.js";

export interface AppContext {
  readonly services: Services;
  readonly auth: AuthConfig;
  /** 静的ファイル（画面）。Sites は ASSETS バインディング、ローカルは dist/public。 */
  readonly assets: ((req: Request) => Promise<Response>) | null;
}

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

export function json(body: unknown, statusCode = 200): Response {
  return new Response(JSON.stringify(body), { status: statusCode, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...SECURITY_HEADERS } });
}
export function error(statusCode: number, code: string): Response {
  return json({ error: code }, statusCode);
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

function parseDate(v: string | null): string | null {
  if (v === null || v === "") return null;
  if (!isIsoDate(v)) throw new HttpError(400, "invalid_request");
  return v;
}

async function body<T extends z.ZodType>(req: Request, schema: T): Promise<z.infer<T>> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > 1_000_000) throw new HttpError(413, "payload_too_large");
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new HttpError(400, "invalid_json");
  }
  const r = schema.safeParse(raw);
  if (!r.success) throw new HttpError(400, "invalid_request");
  return r.data;
}

function requireAdmin(p: Principal): void {
  if (p.role !== "ADMIN") throw new HttpError(403, "forbidden");
}

function requireCsrf(req: Request): void {
  if (req.headers.get(CSRF_HEADER.name) !== CSRF_HEADER.value) throw new HttpError(403, "csrf");
}

/** 取込の記録（ingest_batch.agent_id の外部キー）のための取込クライアントの行を用意する。 */
async function ensureAgent(s: Services, agentId: string, name: string, by: string): Promise<void> {
  if ((await s.agents.find(TENANT_ID, agentId)) !== null) return;
  const now = s.clock.now();
  // 画面・環境変数トークンの取込は、この行のトークンでは認証しない（推測不能な値のハッシュを置く）
  await s.agents.create(TENANT_ID, { agentId, name, tokenHash: await sha256Hex(newToken()), expiresAt: addDays(jstDate(now), 3650) + "T00:00:00.000Z", createdBy: by }, now.toISOString());
}

export async function handleRequest(req: Request, ctx: AppContext): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const s = ctx.services;
  try {
    if (path === "/healthz") return json({ ok: true });
    // ---- 機械の入口（ベアラートークン）----
    if (path === "/mcp" || path === "/api/v1/ingest/batches") {
      if (req.method !== "POST") throw new HttpError(405, "method_not_allowed");
      const a = await authenticateAgent(req, ctx.auth, s, s.clock.now());
      if (!a.ok) return error(a.status, "unauthorized");
      // 取込の記録（ingest_batch）の外部キーのため、環境変数トークンの書き手も agent 表に行を持たせる
      await ensureAgent(s, a.principal.id, a.principal.id, "system");
      if (path === "/mcp") return await handleMcp(req, s, a.principal);
      const env = await body(req, IngestEnvelopeRequest);
      return json(await ingestEnvelope(s, a.principal.id, env));
    }
    if (!path.startsWith("/api/")) {
      if (ctx.assets === null || req.method !== "GET") return error(404, "not_found");
      return await ctx.assets(req);
    }
    // ---- 画面の API（人）----
    const auth = await authenticateUser(req, ctx.auth, s);
    if (!auth.ok) return error(auth.status, auth.status === 401 ? "unauthorized" : "forbidden");
    const p = auth.principal;
    if (req.method === "POST") requireCsrf(req);
    const today = jstDate(s.clock.now());
    const route = `${req.method} ${path}`;
    switch (route) {
      case "GET /api/v1/me":
        return json({ email: p.id, role: p.role, tenantId: p.tenantId });
      case "GET /api/v1/status":
        return json(await status(s));
      case "GET /api/v1/runs":
        return json((await s.runs.listByDate(TENANT_ID, parseDate(url.searchParams.get("date")) ?? today)).map(runDto));
      case "GET /api/v1/races": {
        const rows = await s.schedules.listByDate(TENANT_ID, parseDate(url.searchParams.get("date")) ?? today);
        return json(rows.map((r) => ({ raceId: r.raceId, venueCode: r.raceId.slice(8, 10), raceNo: Number(r.raceId.slice(10, 12)), name: r.raceName, postAt: r.scheduledPostAt, status: r.status })));
      }
      case "GET /api/v1/signals": {
        const page = Number(url.searchParams.get("page") ?? "0");
        const size = Number(url.searchParams.get("size") ?? "50");
        if (!Number.isInteger(page) || page < 0 || page > 100_000 || !Number.isInteger(size) || size < 1 || size > 200) throw new HttpError(400, "invalid_request");
        const r = await s.signals.pageByDate(TENANT_ID, parseDate(url.searchParams.get("date")) ?? today, page, size);
        return json({
          items: r.items.map((x) => ({ signalId: x.id, raceId: x.raceId, market: x.market, umaban: x.umaban, observedAt: x.observedAt, odds: x.odds, prob: x.prob, ev: x.ev, stake: x.stake, probSource: x.probSource, state: x.state })),
          page,
          size,
          total: r.total,
        });
      }
      case "GET /api/v1/performance": {
        const end = parseDate(url.searchParams.get("to")) ?? today;
        const start = parseDate(url.searchParams.get("from")) ?? addDays(end, -30);
        if (end < start || daysBetween(start, end) > PERFORMANCE_MAX_DAYS) throw new HttpError(400, "invalid_request");
        const r = await performanceReport(s, start, end);
        return json({
          from: r.from,
          to: r.to,
          winCount: r.win.count,
          winHits: r.win.hits,
          winTotalStake: r.win.totalStake,
          winPaperPayout: r.win.paperPayout,
          winActualPayout: r.win.actualPayout,
          winHitRate: r.win.hitRate,
          winActualRoi: r.win.actualRoi,
          combos: r.combos.map((c) => ({ market: c.market, count: c.count, hits: c.hits, totalStake: c.totalStake, actualPayout: c.actualPayout, hitRate: c.hitRate, actualRoi: c.actualRoi })),
          winUnsettled: r.winUnsettled,
          comboUnsettled: r.comboUnsettled,
          racesWithoutPostTime: r.racesWithoutPostTime,
          unreadableNotices: r.unreadableNotices,
        });
      }
      case "GET /api/v1/race-detail": {
        const raceId = url.searchParams.get("raceId") ?? "";
        if (!/^\d{12}$/.test(raceId)) throw new HttpError(400, "invalid_request");
        return json(await raceDetail(s, raceId));
      }
      case "GET /api/v1/sync-status":
        return json(await syncStatus(s));
    }
    // ---- 管理（ADMIN だけ）----
    requireAdmin(p);
    switch (route) {
      case "GET /api/v1/admin/overrides": {
        const rows = await s.overrides.listByDate(TENANT_ID, parseDate(url.searchParams.get("date")) ?? today);
        return json(rows.map(overrideDto));
      }
      case "POST /api/v1/admin/overrides": {
        const b = await body(req, CreateOverrideRequest);
        const r = await createOverride(s, { scope: b.scope, date: b.date, raceId: b.raceId, action: b.action, postAt: b.postAt, postponedTo: b.postponedTo, reason: b.reason, createdBy: p.id });
        if (r.kind === "Invalid") throw new HttpError(400, "invalid_request");
        if (r.kind === "RaceNotFound") throw new HttpError(404, "race_not_found");
        if (r.kind === "Duplicate") throw new HttpError(409, "duplicate");
        await s.access.audit(TENANT_ID, { actorType: "USER", actor: p.id, action: "OVERRIDE_CREATE", targetType: "calendar_override", targetId: String(r.override.id), after: overrideDto(r.override), reason: b.reason }, s.clock.now().toISOString());
        return json(overrideDto(r.override), 201);
      }
      case "GET /api/v1/admin/ml-models":
        return json(await mlModels(s));
      case "GET /api/v1/admin/agents":
        return json(await s.agents.list(TENANT_ID));
      case "POST /api/v1/admin/agents": {
        const b = await body(req, CreateAgentRequest);
        if ((await s.agents.find(TENANT_ID, b.agentId)) !== null) throw new HttpError(409, "duplicate");
        const token = newToken();
        const now = s.clock.now();
        await s.agents.create(TENANT_ID, { agentId: b.agentId, name: b.name, tokenHash: await sha256Hex(token), expiresAt: new Date(now.getTime() + b.validDays * 86_400_000).toISOString(), createdBy: p.id }, now.toISOString());
        await s.access.audit(TENANT_ID, { actorType: "USER", actor: p.id, action: "AGENT_CREATE", targetType: "agent", targetId: b.agentId, after: { name: b.name, validDays: b.validDays }, reason: null }, now.toISOString());
        // トークンはこの応答でだけ返す（保存はハッシュ。ログに出さない）
        return json({ agentId: b.agentId, token }, 201);
      }
      case "POST /api/v1/admin/analysis/run": {
        const b = await body(req, RunAnalysisRequest);
        const r = await runAnalysis(s, { ...(b.date === undefined ? {} : { date: b.date }), ...(b.raceId === undefined ? {} : { raceId: b.raceId }), trigger: b.backfill === true ? "BACKFILL" : "MANUAL", actor: p.id });
        return json(r, r.state === "ALREADY_RUNNING" ? 409 : 200);
      }
      case "POST /api/v1/admin/ingest": {
        const env = await body(req, IngestEnvelopeRequest);
        await ensureAgent(s, "manual-import", "画面からの手動取込", p.id);
        return json(await ingestEnvelope(s, "manual-import", env));
      }
      case "POST /api/v1/admin/ingest/replay":
        return json(await replayAllPending(s));
      case "POST /api/v1/admin/mode": {
        const b = await body(req, SetModeRequest);
        const now = s.clock.now().toISOString();
        await s.access.setMode(TENANT_ID, b.mode, p.id, b.reason, now);
        await s.access.audit(TENANT_ID, { actorType: "USER", actor: p.id, action: "MODE_SET", targetType: "ops_mode", targetId: null, after: { mode: b.mode }, reason: b.reason }, now);
        return json({ mode: b.mode });
      }
      case "GET /api/v1/admin/db-stats":
        return json(await s.access.tableCounts(TENANT_ID));
      case "GET /api/v1/admin/export": {
        const from = parseDate(url.searchParams.get("from")) ?? addDays(today, -7);
        const to = parseDate(url.searchParams.get("to")) ?? today;
        if (to < from || daysBetween(from, to) > 31) throw new HttpError(400, "invalid_request");
        return json(await exportRange(s, from, to));
      }
    }
    const revokeOverrideMatch = /^\/api\/v1\/admin\/overrides\/(\d{1,15})\/revoke$/.exec(path);
    if (req.method === "POST" && revokeOverrideMatch?.[1] !== undefined) {
      const r = await revokeOverride(s, Number(revokeOverrideMatch[1]), p.id);
      if (r === "NotFound") throw new HttpError(404, "not_found");
      if (r === "AlreadyRevoked") throw new HttpError(409, "already_revoked");
      await s.access.audit(TENANT_ID, { actorType: "USER", actor: p.id, action: "OVERRIDE_REVOKE", targetType: "calendar_override", targetId: revokeOverrideMatch[1], after: null, reason: null }, s.clock.now().toISOString());
      return json({ revoked: true });
    }
    const revokeAgentMatch = /^\/api\/v1\/admin\/agents\/([A-Za-z0-9_-]{1,64})\/revoke$/.exec(path);
    if (req.method === "POST" && revokeAgentMatch?.[1] !== undefined) {
      const b = await body(req, RevokeAgentRequest);
      const ok = await s.agents.revoke(TENANT_ID, revokeAgentMatch[1], p.id, s.clock.now().toISOString());
      if (!ok) throw new HttpError((await s.agents.find(TENANT_ID, revokeAgentMatch[1])) === null ? 404 : 409, "not_revocable");
      await s.access.audit(TENANT_ID, { actorType: "USER", actor: p.id, action: "AGENT_REVOKE", targetType: "agent", targetId: revokeAgentMatch[1], after: null, reason: b.reason }, s.clock.now().toISOString());
      return json({ revoked: true });
    }
    return error(404, "not_found");
  } catch (e) {
    if (e instanceof HttpError) return error(e.status, e.code);
    if (e instanceof IngestConflictError) return error(409, "batch_conflict");
    // 内部の例外の詳細は返さない・ログに個人情報を出さない
    console.error(`request failed: ${req.method} ${path}: ${e instanceof Error ? e.name : "Error"}`);
    return error(500, "internal_error");
  }
}

export async function ingestEnvelope(s: Services, agentId: string, env: IngestEnvelopeRequest) {
  return ingestBatch(s, agentId, { batchId: env.batchId, source: env.source, observedAt: new Date(env.observedAt).toISOString(), records: env.records.map((r) => ({ id: r.id, payload: JSON.stringify(r.data) })) });
}

function overrideDto(o: CalendarOverride) {
  return { id: o.id, scope: o.scope, date: o.raceDate, raceId: o.raceId, action: o.action, value: o.value, reason: o.reason, createdBy: o.createdBy, createdAt: o.createdAt, validUntil: o.validUntil, revokedAt: o.revokedAt, revokedBy: o.revokedBy };
}

async function mlModels(s: Services) {
  const r = await s.db.prepare("SELECT * FROM ml_model WHERE tenant_id = ? ORDER BY (status = 'ACTIVE') DESC, created_at DESC LIMIT 100").bind(TENANT_ID).all();
  return r.results.map((m) => {
    let metrics: Record<string, number> = {};
    let readable = true;
    try {
      const parsed: unknown = typeof m["metrics_json"] === "string" ? JSON.parse(m["metrics_json"]) : {};
      if (typeof parsed === "object" && parsed !== null) metrics = Object.fromEntries(Object.entries(parsed).filter((e): e is [string, number] => typeof e[1] === "number"));
    } catch {
      readable = false;
    }
    return {
      modelId: String(m["model_id"]),
      kind: String(m["kind"]),
      status: String(m["status"]),
      schemaVersion: Number(m["schema_version"]),
      featureSchemaHash: String(m["feature_schema_hash"]),
      trainedFrom: (m["trained_from"] as string | null) ?? null,
      trainedTo: (m["trained_to"] as string | null) ?? null,
      nTrain: (m["n_train"] as number | null) ?? null,
      createdAt: String(m["created_at"]),
      activatedAt: (m["activated_at"] as string | null) ?? null,
      activatedBy: (m["activated_by"] as string | null) ?? null,
      previousModelId: (m["previous_model_id"] as string | null) ?? null,
      metrics,
      gatePurpose: null,
      gateReasons: [],
      metricsReadable: readable,
    };
  });
}

/** レース詳細（Sites 版で追加。出走ごとの最新オッズ・確率・結果・払戻・最新の判定）。 */
export async function raceDetail(s: Services, raceId: string) {
  const schedule = await s.schedules.find(TENANT_ID, raceId);
  if (schedule === null) throw new HttpError(404, "not_found");
  const now = s.clock.now();
  const cutoff = schedule.scheduledPostAt !== null ? new Date(Math.min(now.getTime(), Date.parse(schedule.scheduledPostAt))).toISOString() : now.toISOString();
  const [win, results, payouts, evaluation, signals] = await Promise.all([
    s.market.latestWinOdds(TENANT_ID, raceId, cutoff),
    s.market.listResults(TENANT_ID, raceId),
    Promise.all((["win", "wide", "sanrenpuku"] as const).map(async (m) => ({ market: m, rows: await s.market.listPayouts(TENANT_ID, raceId, m) }))),
    s.evaluations.latestByRace(TENANT_ID, raceId),
    s.signals.listByRace(TENANT_ID, raceId),
  ]);
  return {
    raceId,
    name: schedule.raceName,
    status: schedule.status,
    postAt: schedule.scheduledPostAt,
    oddsObservedAt: win?.observedAt ?? null,
    entries: (win?.entries ?? []).map((e) => ({ umaban: e.umaban, odds: e.odds, popularity: e.popularity, finish: results.find((r) => r.umaban === e.umaban)?.finish ?? null })),
    payouts,
    evaluation:
      evaluation === null
        ? null
        : { snapshotAt: evaluation["snapshot_at"], bestEv: evaluation["best_ev"], bestCandidate: evaluation["best_candidate_json"], rejections: evaluation["rejection_summary_json"], signalSent: evaluation["signal_sent"] === 1 },
    signals: signals.map((x) => ({ market: x.market, umaban: x.umaban, observedAt: x.observedAt, odds: x.odds, prob: x.prob, ev: x.ev, stake: x.stake, reason: x.reason })),
  };
}

/** エクスポート（バックアップ。期間の予定・オッズ・結果・払戻・シグナルを JSON で）。 */
async function exportRange(s: Services, from: string, to: string) {
  const out: Record<string, unknown[]> = {};
  const tables: readonly [string, string][] = [
    ["race_day", "race_date"],
    ["race_schedule", "race_date"],
    ["races", "race_date"],
  ];
  for (const [t, col] of tables) {
    out[t] = (await s.db.prepare(`SELECT * FROM ${t} WHERE tenant_id = ? AND ${col} BETWEEN ? AND ? ORDER BY 2, 3`).bind(TENANT_ID, from, to).all()).results;
  }
  const lo = from.replaceAll("-", "") + "0000";
  const hi = to.replaceAll("-", "") + "9999";
  for (const t of ["odds_snapshots", "combo_odds_snapshots", "results", "payouts", "signals", "race_evaluations", "race_timing_notice"]) {
    out[t] = (await s.db.prepare(`SELECT * FROM ${t} WHERE tenant_id = ? AND race_id BETWEEN ? AND ?`).bind(TENANT_ID, lo, hi).all()).results;
  }
  out["calendar_override"] = (await s.db.prepare("SELECT * FROM calendar_override WHERE tenant_id = ? AND race_date BETWEEN ? AND ?").bind(TENANT_ID, from, to).all()).results;
  return { format: "jra-bot-sites/export/v1", exportedAt: s.clock.now().toISOString(), from, to, tables: out, id: uuid() };
}
