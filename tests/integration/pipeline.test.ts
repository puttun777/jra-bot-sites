/**
 * DB 連携（node:sqlite。D1 互換の確認ではない）: マイグレーション・取込（保留 → 再適用・隔離・冪等）・開催カレンダーの規則・
 * 手動補正・判定の実行（重複実行防止・停止モード・未来情報の不使用）・成績・バックアップ相当のエクスポート。
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ingestBatch, performanceReport, replayAllPending, runAnalysis, createOverride, revokeOverride, TENANT_ID } from "../../src/application/services.js";
import { deriveEffectiveDay } from "../../src/domain/calendar.js";
import { uuid } from "../../src/domain/race.js";
import { ensureAgent, setup, syntheticDay, winOdds } from "./helpers.js";

const DATE = "2026-11-28";
const R11 = "202611280511";
const R12 = "202611280512";

async function ingest(s: Parameters<typeof ingestBatch>[0], records: { id: string; payload: string }[], observedAt: string, batchId = uuid()) {
  await ensureAgent(s);
  return ingestBatch(s, "test-agent", { batchId, source: "test", observedAt, records });
}

describe("migrations", () => {
  test("全マイグレーションが適用でき、外部キーが有効", () => {
    const { db } = setup();
    const names = db.raw.prepare("SELECT name FROM d1_migrations ORDER BY id").all().map((r) => String(r["name"]));
    assert.deepEqual(names, ["0001_baseline.sql", "0002_ops_calendar_ingest_ml.sql", "0003_sites.sql"]);
    assert.equal(db.raw.prepare("PRAGMA foreign_keys").get()?.["foreign_keys"], 1);
    // race_id と日付・場・番号の整合（CHECK）
    assert.throws(() => db.raw.prepare("INSERT INTO races (tenant_id, race_id, race_date, venue_code, race_no, created_at, updated_at) VALUES (1, '202611280511', '2026-11-29', '05', 11, 'x', 'x')").run());
  });
});

describe("取込", () => {
  test("レースより先に届いたオッズは保留になり、レース到着で再適用される", async () => {
    const { s } = setup();
    const a = await ingest(s, [winOdds(R11, [3, 4.5, 7])], "2026-11-28T06:20:00.000Z");
    assert.equal(a.deferred, 1);
    assert.match(a.issues[0]?.reason ?? "", /^RACE_NOT_FOUND:202611280511$/);
    const b = await ingest(s, syntheticDay(DATE), "2026-11-28T00:00:00.000Z");
    assert.equal(b.applied, 3);
    assert.equal(b.replayed, 1);
    const odds = await s.market.latestWinOdds(TENANT_ID, R11, "2026-11-28T07:00:00.000Z");
    assert.equal(odds?.entries.length, 3);
  });

  test("同じ batchId の再送は何もしない・内容が違えば拒否・同じレコードは重複として数える", async () => {
    const { s } = setup();
    const id = uuid();
    const recs = syntheticDay(DATE);
    await ingest(s, recs, "2026-11-28T00:00:00.000Z", id);
    const again = await ingest(s, recs, "2026-11-28T00:00:00.000Z", id);
    assert.equal(again.status, "DUPLICATE_BATCH");
    await assert.rejects(ingest(s, recs.slice(0, 1), "2026-11-28T00:00:00.000Z", id));
    const dup = await ingest(s, recs, "2026-11-28T00:00:00.000Z");
    assert.equal(dup.duplicates, 3);
    assert.equal((await s.schedules.listByDate(TENANT_ID, DATE)).length, 2);
  });

  test("不正なレコードは隔離（既存の正常なデータを上書きしない）", async () => {
    const { s } = setup();
    await ingest(s, syntheticDay(DATE), "2026-11-28T00:00:00.000Z");
    await ingest(s, [winOdds(R11, [3, 4.5, 7])], "2026-11-28T06:00:00.000Z");
    const bad = await ingest(s, [{ id: "NOW", payload: JSON.stringify({ raceId: R11, entries: [{ umaban: 1, odds: 0.5, pop: 1 }] }) }, { id: "NOW", payload: "{broken" }, { id: "NHR", payload: JSON.stringify({ raceId: R11, market: "wide", provisional: false, entries: [{ key: "2-1", payout: 300 }] }) }], "2026-11-28T06:10:00.000Z");
    assert.equal(bad.quarantined, 3);
    assert.deepEqual(bad.issues.map((i) => i.reason), ["ODDS_BELOW_PAR", "NORMALIZED_JSON_INVALID", "INVALID_COMBO_KEY"]);
    const odds = await s.market.latestWinOdds(TENANT_ID, R11, "2026-11-28T07:00:00.000Z");
    assert.equal(odds?.observedAt, "2026-11-28T06:00:00.000Z");
    assert.equal((await s.ingest.counts(TENANT_ID)).failed, 3);
  });

  test("速報の払戻は確定を上書きしない", async () => {
    const { s } = setup();
    await ingest(s, syntheticDay(DATE), "2026-11-28T00:00:00.000Z");
    const pay = (p: number, provisional: boolean) => ({ id: "NHR", payload: JSON.stringify({ raceId: R11, market: "win", provisional, entries: [{ key: "02", payout: p }] }) });
    await ingest(s, [pay(460, false)], "2026-11-28T07:00:00.000Z");
    await ingest(s, [pay(999, true)], "2026-11-28T07:01:00.000Z");
    assert.deepEqual(await s.market.listPayouts(TENANT_ID, R11, "win"), [{ comboKey: "02", payout: 460, provisional: false }]);
  });
});

describe("開催カレンダー（Kotlin と同じ規則）", () => {
  test("古い版は反映しない・中止は終端（新しい版でも復活しない）・同じ版の再配信は何もしない", async () => {
    const { s } = setup();
    await ingest(s, syntheticDay(DATE), "2026-11-28T00:00:00.000Z");
    const nra = (kubun: string, createdOn: string, postTime: string | null) => ({ id: "NRA", payload: JSON.stringify({ raceId: R11, kubun, createdOn, postTime, raceName: "合成記念", kai: 5, nichime: 8 }) });
    const older = await ingest(s, [nra("2", "20261127", "1500")], "2026-11-28T00:10:00.000Z");
    assert.equal(older.rejected, 1);
    assert.equal(older.issues[0]?.reason, "OLDER_SOURCE_VERSION");
    const timeChange = await ingest(s, [nra("2", "20261129", "1550")], "2026-11-28T00:20:00.000Z");
    assert.equal(timeChange.applied, 1);
    assert.equal((await s.schedules.find(TENANT_ID, R11))?.scheduledPostAt, "2026-11-28T06:50:00.000Z");
    await ingest(s, [nra("9", "20261130", null)], "2026-11-28T00:30:00.000Z");
    assert.equal((await s.schedules.find(TENANT_ID, R11))?.status, "CANCELLED");
    const revive = await ingest(s, [nra("2", "20261201", "1540")], "2026-11-28T00:40:00.000Z");
    assert.equal(revive.issues[0]?.reason, "INVALID_TRANSITION");
    const events = await s.events.eventsOfRace(TENANT_ID, R11);
    assert.deepEqual(events.map((e) => e.type), ["ADDED", "TIME_CHANGE", "CANCELLED"]);
  });

  test("手動補正: 開催日の中止は予定より優先し、取消で元に戻る（監査の履歴が残る）", async () => {
    const { s, clock } = setup();
    await ingest(s, syntheticDay(DATE), "2026-11-28T00:00:00.000Z");
    const created = await createOverride(s, { scope: "DAY", date: DATE, raceId: null, action: "CANCEL", postAt: null, postponedTo: null, reason: "台風", createdBy: "owner@example.invalid" });
    assert.equal(created.kind, "Created");
    const derive = async () => deriveEffectiveDay(DATE, clock.now(), await s.days.listByDate(TENANT_ID, DATE), await s.schedules.listByDate(TENANT_ID, DATE), await s.overrides.listByDate(TENANT_ID, DATE), null);
    assert.equal((await derive()).verdict, "CANCELLED");
    assert.equal((await derive()).conflicts.length, 1);
    if (created.kind !== "Created" || created.override.id === null) throw new Error("unreachable");
    assert.equal(await revokeOverride(s, created.override.id, "owner@example.invalid"), "Revoked");
    assert.equal(await revokeOverride(s, created.override.id, "owner@example.invalid"), "AlreadyRevoked");
    assert.equal((await derive()).verdict, "CONFIRMED");
    const bad = await createOverride(s, { scope: "RACE", date: DATE, raceId: R11, action: "SET_POST_TIME", postAt: "2026-11-29T06:00:00Z", postponedTo: null, reason: "x", createdBy: "o@e.x" });
    assert.equal(bad.kind, "Invalid");
  });
});

describe("判定の実行", () => {
  test("発走前のオッズで判定し、シグナル・評価・通知スナップショットを保存する（同じオッズの再実行は変化なし）", async () => {
    const { s, clock } = setup("2026-11-28T06:30:00.000Z");
    await ingest(s, syntheticDay(DATE), "2026-11-28T00:00:00.000Z");
    await ingest(s, [winOdds(R11, [3.1, 4.6, 6.8, 11.5, 24, 41]), { id: "NOD", payload: JSON.stringify({ raceId: R11, entries: [{ a: 1, b: 2, low: 3.9, high: 5.8, pop: null }, { a: 1, b: 4, low: 8.7, high: 13.9, pop: null }, { a: 2, b: 4, low: 12.6, high: 20.4, pop: null }] }) }], "2026-11-28T06:20:00.000Z");
    const r = await runAnalysis(s, { date: DATE, trigger: "MANUAL", actor: "test" });
    assert.equal(r.state, "SUCCEEDED");
    const r11 = r.races.find((x) => x.raceId === R11);
    assert.equal(r11?.status, "ANALYZED");
    assert.equal(r.races.find((x) => x.raceId === R12)?.status, "NO_ODDS");
    const again = await runAnalysis(s, { date: DATE, trigger: "MANUAL", actor: "test" });
    assert.equal(again.races.find((x) => x.raceId === R11)?.status, "ALREADY_EVALUATED");
    clock.set("2026-11-28T06:31:00.000Z");
    assert.ok((await s.evaluations.latestByRace(TENANT_ID, R11)) !== null);
  });

  test("未来の時刻のオッズ・発走後のオッズは判定に使わない（未来情報の混入防止）", async () => {
    const { s } = setup("2026-11-28T06:00:00.000Z");
    await ingest(s, syntheticDay(DATE), "2026-11-28T00:00:00.000Z");
    // 発走（06:40Z）後に観測したオッズ（確定オッズ相当）だけがある
    await ingest(s, [winOdds(R11, [3, 4, 5])], "2026-11-28T06:45:00.000Z");
    const r = await runAnalysis(s, { raceId: R11, trigger: "MANUAL", actor: "test" });
    assert.equal(r.races[0]?.status, "NO_ODDS");
  });

  test("同じ日の実行中は重複実行しない・期限切れのリースは回収する・停止モードでは実行しない", async () => {
    const { s, clock } = setup();
    const lease = await s.runs.tryStart(TENANT_ID, uuid(), DATE, "SCHEDULER", "other", clock.now(), 60_000);
    assert.ok(lease !== null);
    assert.equal((await runAnalysis(s, { date: DATE, trigger: "MANUAL", actor: "t" })).state, "ALREADY_RUNNING");
    clock.set("2026-11-28T03:02:00.000Z");
    assert.notEqual((await runAnalysis(s, { date: DATE, trigger: "MANUAL", actor: "t" })).state, "ALREADY_RUNNING");
    const runs = await s.runs.listByDate(TENANT_ID, DATE);
    assert.ok(runs.some((x) => x.state === "INTERRUPTED" && x.exitReason === "LEASE_EXPIRED"));
    await s.access.setMode(TENANT_ID, "STOPPED", "t", "test", clock.now().toISOString());
    assert.equal((await runAnalysis(s, { date: DATE, trigger: "SCHEDULER", actor: "t" })).state, "STOPPED_BY_MODE");
  });
});

describe("成績（PerformanceReadService の移植）", () => {
  test("ワイドの的中は確定払戻の行で決める（1・2 着以外の組み合わせも的中）・未確定は数えない", async () => {
    const { s, clock } = setup("2026-11-28T06:30:00.000Z");
    await ingest(s, syntheticDay(DATE), "2026-11-28T00:00:00.000Z");
    await ingest(s, [winOdds(R11, [3.1, 4.6, 6.8, 11.5, 24, 41]), { id: "NOD", payload: JSON.stringify({ raceId: R11, entries: [{ a: 1, b: 4, low: 8.7, high: 13.9, pop: null }] }) }], "2026-11-28T06:20:00.000Z");
    const r = await runAnalysis(s, { date: DATE, trigger: "MANUAL", actor: "test" });
    assert.equal(r.races.find((x) => x.raceId === R11)?.signals, 1);
    const before = await performanceReport(s, DATE, DATE);
    assert.equal(before.comboUnsettled, 1);
    clock.set("2026-11-28T07:30:00.000Z");
    // 1 着 1・2 着 2・3 着 4 → ワイド 01-04 は「1 着と 3 着」の組み合わせで的中（旧実装 E17 では外れ扱い）
    await ingest(s, [
      { id: "NRS", payload: JSON.stringify({ raceId: R11, entries: [1, 2, 3, 4, 5, 6].map((u) => ({ umaban: u, finish: [1, 2, 4, 3, 5, 6][u - 1] })) }) },
      { id: "NHR", payload: JSON.stringify({ raceId: R11, market: "wide", provisional: false, entries: [{ key: "01-02", payout: 390 }, { key: "01-04", payout: 870 }, { key: "02-04", payout: 1260 }] }) },
    ], "2026-11-28T07:20:00.000Z");
    const after = await performanceReport(s, DATE, DATE);
    const wide = after.combos.find((c) => c.market === "wide");
    assert.equal(wide?.count, 1);
    assert.equal(wide?.hits, 1);
    assert.ok(Math.abs((wide?.actualPayout ?? 0) - (wide?.totalStake ?? 0) * 8.7) < 1e-9);
  });

  test("保留の一括再適用", async () => {
    const { s } = setup();
    await ingest(s, [winOdds(R11, [3, 4])], "2026-11-28T06:00:00.000Z");
    await ensureAgent(s);
    // レースを（再適用を起こさない経路で）先に作る
    await s.market.upsertMinimal(TENANT_ID, { value: R11, date: DATE, venue: "05", raceNo: 11 }, 5, 8, "15:40", "x");
    const r = await replayAllPending(s);
    assert.deepEqual(r, { attempted: 1, resolved: 1, stillPending: 0 });
  });
});
