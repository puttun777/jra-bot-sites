/** データ保持: 既定はドライラン・対象外（成績の元・解析待ち・実行中）は消さない・1 回の上限・API は管理者だけ。 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ingestBatch, TENANT_ID } from "../../src/application/services.js";
import { runRetention } from "../../src/application/retention.js";
import { uuid } from "../../src/domain/race.js";
import { call, ctx, ensureAgent, setup, syntheticDay } from "./helpers.js";

describe("データ保持", () => {
  test("古い組オッズ・解析済みの生レコードだけを消し、解析待ち・単勝オッズ・実行中は残す", async () => {
    const { s, db, clock } = setup("2026-11-28T03:00:00.000Z");
    await ensureAgent(s);
    await ingestBatch(s, "test-agent", { batchId: uuid(), source: "test", observedAt: "2026-11-28T00:00:00.000Z", records: syntheticDay("2026-11-28") });
    await ingestBatch(s, "test-agent", {
      batchId: uuid(),
      source: "test",
      observedAt: "2026-11-28T06:20:00.000Z",
      records: [
        { id: "NOW", payload: JSON.stringify({ raceId: "202611280511", entries: [{ umaban: 1, odds: 3, pop: 1 }] }) },
        { id: "NOD", payload: JSON.stringify({ raceId: "202611280511", entries: [{ a: 1, b: 2, low: 3.9, high: 5.8, pop: null }] }) },
        { id: "NOW", payload: JSON.stringify({ raceId: "202612050511", entries: [{ umaban: 1, odds: 3, pop: 1 }] }) },
      ],
    });
    await s.runs.tryStart(TENANT_ID, uuid(), "2026-11-28", "MANUAL", "t", clock.now(), 60_000);
    clock.set("2027-02-01T00:00:00.000Z");
    const dry = await runRetention(s.db, TENANT_ID, clock.now(), false);
    assert.equal(dry.dryRun, true);
    const line = (t: string) => dry.lines.find((l) => l.target === t);
    assert.equal(line("COMBO_ODDS")?.eligible, 1);
    assert.equal(line("INGEST_RAW")?.eligible, 5);
    assert.equal(line("BOT_RUNS")?.eligible, 0);
    assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM combo_odds_snapshots").get()?.["n"], 1);
    const run = await runRetention(s.db, TENANT_ID, clock.now(), true);
    assert.equal(run.lines.find((l) => l.target === "COMBO_ODDS")?.deleted, 1);
    assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM combo_odds_snapshots").get()?.["n"], 0);
    assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM odds_snapshots").get()?.["n"], 1);
    assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM ingest_raw WHERE parse_status = 'PENDING'").get()?.["n"], 1);
    await assert.rejects(runRetention(s.db, TENANT_ID, clock.now(), false, { COMBO_ODDS: 1 }));
  });

  test("API: 閲覧者は 403、管理者のドライランは何も消さない", async () => {
    const { s } = setup();
    assert.equal((await call(ctx(s), "POST", "/api/v1/admin/retention", { user: "viewer@example.invalid", body: { execute: false } })).status, 403);
    const r = await call(ctx(s), "POST", "/api/v1/admin/retention", { user: "owner@example.invalid", body: { execute: false } });
    assert.equal(r.status, 200);
    assert.equal((r.body as { dryRun: boolean }).dryRun, true);
    assert.equal((await call(ctx(s), "POST", "/api/v1/admin/retention", { user: "owner@example.invalid", body: { execute: true, days: { COMBO_ODDS: 3 } } })).status, 400);
  });
});
