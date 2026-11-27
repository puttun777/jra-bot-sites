/**
 * API の試験: 認証・認可（所有者と閲覧者の分離・サーバ側の認可）・CSRF・入力検証・契約（jra-bot-web の画面と同じ DTO の形）・MCP・取込のベアラー認証。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { ingestBatch } from "../../src/application/services.js";
import { uuid } from "../../src/domain/race.js";
import { AUTH, call, ctx, ensureAgent, setup, syntheticDay, winOdds } from "./helpers.js";

const OWNER = "owner@example.invalid";
const VIEWER = "viewer@example.invalid";
const TOKEN = "t".repeat(40);

async function seeded() {
  const env = setup("2026-11-28T06:30:00.000Z");
  await ensureAgent(env.s);
  await ingestBatch(env.s, "test-agent", { batchId: uuid(), source: "test", observedAt: "2026-11-28T00:00:00.000Z", records: syntheticDay("2026-11-28") });
  await ingestBatch(env.s, "test-agent", { batchId: uuid(), source: "test", observedAt: "2026-11-28T06:20:00.000Z", records: [winOdds("202611280511", [3.1, 4.6, 6.8, 11.5, 24, 41])] });
  return env;
}

/** 値の形（キーの集合と、null でない値の JSON 型）。Kotlin の ReadAdminApiMySqlIntegrationTest と同じ考え方。 */
function shape(v: unknown): unknown {
  if (Array.isArray(v)) return v.length === 0 ? [] : [shape(v[0])];
  if (v !== null && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, shape((v as Record<string, unknown>)[k])]));
  return v === null ? "null" : typeof v;
}
function sameKeys(actual: unknown, contract: unknown, path = "$"): string[] {
  if (Array.isArray(contract) && Array.isArray(actual)) return contract.length && actual.length ? sameKeys(actual[0], contract[0], `${path}[0]`) : [];
  if (contract !== null && typeof contract === "object" && actual !== null && typeof actual === "object") {
    const ck = Object.keys(contract).sort().join(",");
    const ak = Object.keys(actual).sort().join(",");
    if (ck !== ak) return [`${path}: keys ${ak} != ${ck}`];
    return Object.keys(contract).flatMap((k) => sameKeys((actual as Record<string, unknown>)[k], (contract as Record<string, unknown>)[k], `${path}.${k}`));
  }
  if (contract !== null && actual !== null && typeof contract !== typeof actual) return [`${path}: ${typeof actual} != ${typeof contract}`];
  return [];
}
const contract = (name: string): unknown => JSON.parse(readFileSync(join("tests/web/contract", name), "utf8"));

describe("認証・認可", () => {
  test("本人のヘッダが無ければ 401、許可リストに無い人は 403", async () => {
    const { s } = await seeded();
    assert.equal((await call(ctx(s), "GET", "/api/v1/status")).status, 401);
    assert.equal((await call(ctx(s), "GET", "/api/v1/status", { user: "stranger@example.invalid" })).status, 403);
    assert.equal((await call(ctx(s), "GET", "/api/v1/status", { user: "not-an-email" })).status, 401);
  });

  test("閲覧者は読取りだけ。管理 API は 403（サーバ側で判定）", async () => {
    const { s } = await seeded();
    assert.equal((await call(ctx(s), "GET", "/api/v1/races?date=2026-11-28", { user: VIEWER })).status, 200);
    assert.equal((await call(ctx(s), "GET", "/api/v1/admin/overrides", { user: VIEWER })).status, 403);
    assert.equal((await call(ctx(s), "POST", "/api/v1/admin/analysis/run", { user: VIEWER, body: {} })).status, 403);
    const me = await call(ctx(s), "GET", "/api/v1/me", { user: VIEWER.toUpperCase() });
    assert.deepEqual(me.body, { email: VIEWER, role: "VIEWER", tenantId: 1 });
  });

  test("POST は CSRF の印が無ければ 403", async () => {
    const { s } = await seeded();
    assert.equal((await call(ctx(s), "POST", "/api/v1/admin/analysis/run", { user: OWNER, body: {}, csrf: false })).status, 403);
    assert.equal((await call(ctx(s), "POST", "/api/v1/admin/analysis/run", { user: OWNER, body: {} })).status, 200);
  });

  test("ローカルの疑似ログインは devUserEmail を渡したときだけ（Sites の入口は常に null）", async () => {
    const { s } = await seeded();
    const local = ctx(s, { ...AUTH, devUserEmail: OWNER });
    assert.equal((await call(local, "GET", "/api/v1/me")).status, 200);
    assert.equal((await call(ctx(s), "GET", "/api/v1/me")).status, 401);
    const worker = readFileSync("src/sites/worker.ts", "utf8");
    assert.match(worker, /devUserEmail: null/);
    assert.doesNotMatch(worker, /LOCAL_DEV_USER_EMAIL/);
  });

  test("入力の検証: 不正な日付・ページ・本文は 400、知らない操作は 400", async () => {
    const { s } = await seeded();
    assert.equal((await call(ctx(s), "GET", "/api/v1/races?date=2026-13-01", { user: OWNER })).status, 400);
    assert.equal((await call(ctx(s), "GET", "/api/v1/signals?page=-1", { user: OWNER })).status, 400);
    assert.equal((await call(ctx(s), "POST", "/api/v1/admin/overrides", { user: OWNER, body: { scope: "DAY", action: "DROP_TABLE", date: "2026-11-28", raceId: null, postAt: null, postponedTo: null, reason: "x" } })).status, 400);
    assert.equal((await call(ctx(s), "POST", "/api/v1/admin/overrides", { user: OWNER, body: { scope: "DAY", action: "CANCEL", date: "2026-11-28", raceId: null, postAt: null, postponedTo: null, reason: "x", extra: 1 } })).status, 400);
  });

  test("SQL 注入の文字列は値として扱われる（プレースホルダ）", async () => {
    const { s } = await seeded();
    const r = await call(ctx(s), "POST", "/api/v1/admin/overrides", { user: OWNER, body: { scope: "DAY", action: "MARK_RACE_DAY", date: "2026-11-28", raceId: null, postAt: null, postponedTo: null, reason: "'; DROP TABLE races; --" } });
    assert.equal(r.status, 201);
    assert.equal((await call(ctx(s), "GET", "/api/v1/races?date=2026-11-28", { user: OWNER })).status, 200);
  });
});

describe("契約（jra-bot-web の画面と同じ DTO の形）", () => {
  test("読取り API の応答のキーと型が契約見本と一致する", async () => {
    const { s } = await seeded();
    await call(ctx(s), "POST", "/api/v1/admin/analysis/run", { user: OWNER, body: { date: "2026-11-28" } });
    await call(ctx(s), "POST", "/api/v1/admin/overrides", { user: OWNER, body: { scope: "RACE", action: "SET_POST_TIME", date: "2026-11-28", raceId: "202611280512", postAt: "2026-11-28T07:30:00Z", postponedTo: null, reason: "変更" } });
    const cases: [string, string][] = [
      ["/api/v1/status", "status.json"],
      ["/api/v1/races?date=2026-11-28", "races.json"],
      ["/api/v1/signals?date=2026-11-28", "signals.json"],
      ["/api/v1/runs?date=2026-11-28", "runs.json"],
      ["/api/v1/admin/overrides?date=2026-11-28", "overrides.json"],
      ["/api/v1/me", "me.json"],
    ];
    for (const [path, file] of cases) {
      const r = await call(ctx(s), "GET", path, { user: OWNER });
      assert.equal(r.status, 200, path);
      assert.deepEqual(sameKeys(r.body, contract(file)), [], `${path}: ${JSON.stringify(shape(r.body)).slice(0, 300)}`);
    }
    const perf = await call(ctx(s), "GET", "/api/v1/performance?from=2026-11-01&to=2026-11-28", { user: OWNER });
    const c = contract("performance.json") as Record<string, unknown>;
    assert.deepEqual(Object.keys(perf.body as object).sort(), Object.keys(c).sort());
  });

  test("取込クライアント: 発行したトークンで取込でき、失効後は 401。一覧の形は契約見本と同じ", async () => {
    const { s } = await seeded();
    const created = await call(ctx(s), "POST", "/api/v1/admin/agents", { user: OWNER, body: { agentId: "chatgpt-mcp", name: "ChatGPT MCP", validDays: 30 } });
    assert.equal(created.status, 201);
    const token = (created.body as { token: string }).token;
    assert.equal(token.length, 64);
    const list = await call(ctx(s), "GET", "/api/v1/admin/agents", { user: OWNER });
    assert.deepEqual(sameKeys(list.body, contract("agents.json")), []);
    const env = { batchId: uuid(), source: "chatgpt", observedAt: "2026-11-28T06:25:00Z", records: [{ id: "NOW", data: { raceId: "202611280511", entries: [{ umaban: 1, odds: 3.0, pop: 1 }, { umaban: 2, odds: 4.4, pop: 2 }] } }] };
    const ok = await call(ctx(s), "POST", "/api/v1/ingest/batches", { bearer: token, body: env, csrf: false });
    assert.equal(ok.status, 200);
    assert.equal((ok.body as { applied: number }).applied, 1);
    await call(ctx(s), "POST", "/api/v1/admin/agents/chatgpt-mcp/revoke", { user: OWNER, body: { reason: "テスト" } });
    assert.equal((await call(ctx(s), "POST", "/api/v1/ingest/batches", { bearer: token, body: { ...env, batchId: uuid() }, csrf: false })).status, 401);
    assert.equal((await call(ctx(s), "POST", "/api/v1/ingest/batches", { bearer: "short", body: env, csrf: false })).status, 401);
  });
});

describe("MCP（JSON-RPC）", () => {
  const rpc = (method: string, params?: unknown) => ({ jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) });

  test("tools/list は入力スキーマ付きのツールを返す", async () => {
    const { s } = await seeded();
    const r = await call(ctx(s), "POST", "/mcp", { bearer: TOKEN, body: rpc("tools/list"), csrf: false });
    const tools = ((r.body as { result: { tools: { name: string; inputSchema: { type: string } }[] } }).result.tools);
    assert.ok(tools.some((t) => t.name === "upsert_odds"));
    assert.ok(tools.every((t) => t.inputSchema.type === "object"));
  });

  test("upsert_odds → run_analysis → get_analysis_results（応答は要約だけ）", async () => {
    const { s } = await seeded();
    const up = await call(ctx(s), "POST", "/mcp", {
      bearer: TOKEN,
      csrf: false,
      body: rpc("tools/call", { name: "upsert_odds", arguments: { observedAt: "2026-11-28T06:28:00Z", raceId: "202611280511", win: [3.1, 4.6, 6.8, 11.5, 24, 41].map((o, i) => ({ umaban: i + 1, odds: o, popularity: i + 1 })), wide: [{ a: 1, b: 4, low: 8.7, high: 13.9 }] } }),
    });
    const sc = (up.body as { result: { structuredContent: { applied: number }; isError: boolean } }).result;
    assert.equal(sc.isError, false);
    assert.equal(sc.structuredContent.applied, 2);
    const run = await call(ctx(s), "POST", "/mcp", { bearer: TOKEN, csrf: false, body: rpc("tools/call", { name: "run_analysis", arguments: { date: "2026-11-28" } }) });
    assert.equal((run.body as { result: { isError: boolean } }).result.isError, false);
    const res = await call(ctx(s), "POST", "/mcp", { bearer: TOKEN, csrf: false, body: rpc("tools/call", { name: "get_analysis_results", arguments: { date: "2026-11-28" } }) });
    assert.ok((res.body as { result: { structuredContent: { total: number } } }).result.structuredContent.total >= 1);
  });

  test("不正な引数はツールのエラーとして理由を返す・認証なしは 401・未知のツールは JSON-RPC エラー", async () => {
    const { s } = await seeded();
    const bad = await call(ctx(s), "POST", "/mcp", { bearer: TOKEN, csrf: false, body: rpc("tools/call", { name: "upsert_odds", arguments: { raceId: "x", observedAt: "now" } }) });
    const result = (bad.body as { result: { isError: boolean; content: { text: string }[] } }).result;
    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? "", /invalid arguments/);
    assert.equal((await call(ctx(s), "POST", "/mcp", { body: rpc("tools/list"), csrf: false })).status, 401);
    const unk = await call(ctx(s), "POST", "/mcp", { bearer: TOKEN, csrf: false, body: rpc("tools/call", { name: "drop_db", arguments: {} }) });
    assert.equal((unk.body as { error: { code: number } }).error.code, -32602);
  });

  test("get_fetch_plan は未取得のものだけを返す", async () => {
    const { s } = await seeded();
    const r = await call(ctx(s), "POST", "/mcp", { bearer: TOKEN, csrf: false, body: rpc("tools/call", { name: "get_fetch_plan", arguments: {} }) });
    const plan = (r.body as { result: { structuredContent: { needOdds: string[]; needResults: string[] } } }).result.structuredContent;
    assert.deepEqual(plan.needOdds, ["202611280512"]);
    assert.deepEqual(plan.needResults, []);
  });
});
