/**
 * 旧 jra-bot の SQLite → 取込の封筒 → Sites 版の DB。旧のスキーマは jra-bot@f7dbf69 src/jraev/storage/schema.sql（tests/fixtures/legacy-schema.sql）。
 * データは合成（実データではない）。
 */
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";
import { ingestBatch, performanceReport, runAnalysis, TENANT_ID } from "../../src/application/services.js";
import { convertLegacy, legacyComboKey, legacyInstant, legacyPostTime, stableUuid } from "../../src/local/legacy.js";
import { ensureAgent, setup } from "./helpers.js";

function legacyDb(): string {
  const path = join(mkdtempSync(join(tmpdir(), "legacy-")), "old.sqlite");
  const db = new DatabaseSync(path);
  db.exec(readFileSync("tests/fixtures/legacy-schema.sql", "utf8"));
  db.exec("ALTER TABLE payouts ADD COLUMN is_provisional INTEGER DEFAULT 0");
  const run = (sql: string, ...v: (string | number | null)[]) => db.prepare(sql).run(...v);
  run("INSERT INTO races (race_id, date, track, track_cd, race_no, post_time, name, created_at) VALUES ('202603010511', '20260301', '東京', '05', 11, '15:40', '合成記念', '2026-02-28 09:00:00')");
  run("INSERT INTO races (race_id, date, track, track_cd, race_no, post_time, name) VALUES ('202603010512', '20260301', '東京', '05', 12, '00:00', '時刻不明')");
  run("INSERT INTO races (race_id, date, track, track_cd, race_no, post_time, name) VALUES ('BAD', '20260301', '東京', '05', 1, '10:00', 'x')");
  // オッズ: naive の T 区切り = JST。発走 15:40 JST の 20 分前と、発走後（判定に使わない）
  for (const [u, o] of [[1, 3.1], [2, 4.6], [3, 6.8], [4, 11.5], [5, 24], [6, 41]] as const) {
    run("INSERT INTO odds_snapshots (race_id, ts, market, umaban, odds, popularity) VALUES ('202603010511', '2026-03-01T15:20:00.123456', 'win', ?, ?, ?)", u, o, u);
    run("INSERT INTO odds_snapshots (race_id, ts, market, umaban, odds, popularity) VALUES ('202603010511', '2026-03-01T15:45:00', 'win', ?, ?, ?)", u, o * 0.5, u);
  }
  run("INSERT INTO combo_odds_snapshots (race_id, collected_at, market, combo_key, odds, source) VALUES ('202603010511', '2026-03-01T15:20:00', 'wide', '4-1', 8.7, '0B33')");
  run("INSERT INTO combo_odds_snapshots (race_id, collected_at, market, combo_key, odds, source) VALUES ('202603010511', '2026-03-01T15:20:00', 'wide', 'x', 8.7, '0B33')");
  for (const [u, f] of [[1, 1], [2, 2], [3, 4], [4, 3], [5, 0], [6, null]] as const) run("INSERT INTO results (race_id, umaban, finish) VALUES ('202603010511', ?, ?)", u, f);
  run("INSERT INTO payouts (race_id, market, key, payout, created_at) VALUES ('202603010511', 'wide', '4-1', 870, '2026-03-01T16:10:00')");
  run("INSERT INTO payouts (race_id, market, key, payout, created_at) VALUES ('202603010511', 'wide', '2-1', 390, '2026-03-01T16:10:00')");
  db.close();
  return path;
}

describe("旧データの変換（規則）", () => {
  test("時刻: T 区切りは JST、空白区切り（CURRENT_TIMESTAMP）は UTC、時差付きはその時差", () => {
    assert.equal(legacyInstant("2026-03-01T15:20:00"), "2026-03-01T06:20:00.000Z");
    assert.equal(legacyInstant("2026-03-01 06:20:00"), "2026-03-01T06:20:00.000Z");
    assert.equal(legacyInstant("2026-03-01T15:20:00+09:00"), "2026-03-01T06:20:00.000Z");
    assert.equal(legacyInstant("2026-02-30T10:00:00"), null);
    assert.equal(legacyInstant("yesterday"), null);
  });
  test("発走時刻（分 ≥ 60 の繰上げ・00:00 は不明）と組み合わせキー", () => {
    assert.equal(legacyPostTime("12:60"), "1300");
    assert.equal(legacyPostTime("00:00"), null);
    assert.equal(legacyPostTime("25:00"), null);
    assert.equal(legacyComboKey("wide", "[BOX]7-2"), "02-07");
    assert.equal(legacyComboKey("win", "7"), "07");
    assert.equal(legacyComboKey("sanrenpuku", "1-1-2"), null);
    assert.equal(stableUuid("a"), stableUuid("a"));
    assert.match(stableUuid("a"), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("旧データの移行（変換 → 取込 → 判定・成績）", () => {
  test("変換の件数と除外理由、取込、発走前オッズだけでの再判定、ワイドの成績、再実行で二重に入らない", async () => {
    const { report, envelopes } = convertLegacy(legacyDb());
    assert.deepEqual(report.records, { NRA: 2, NOW: 2, NOD: 1, NRS: 1, NHR: 1 });
    assert.deepEqual(report.rejected, { "races.race_id": 1, "combo.combo_key": 1 });
    const { s, clock } = setup("2026-03-02T00:00:00.000Z");
    await ensureAgent(s);
    const ingest = async () => {
      let dup = 0;
      for (const e of envelopes) {
        const r = await ingestBatch(s, "test-agent", { batchId: e.batchId, source: e.source, observedAt: e.observedAt, records: e.records.map((x) => ({ id: x.id, payload: JSON.stringify(x.data) })) });
        if (r.status === "DUPLICATE_BATCH") dup++;
      }
      return dup;
    };
    assert.equal(await ingest(), 0);
    assert.equal((await s.schedules.find(TENANT_ID, "202603010511"))?.scheduledPostAt, "2026-03-01T06:40:00.000Z");
    assert.equal((await s.schedules.find(TENANT_ID, "202603010512"))?.postTimeUnknown, true);
    assert.equal((await s.market.listResults(TENANT_ID, "202603010511")).find((r) => r.umaban === 5)?.finish, null);
    // 開催日（race_day）は旧に無いので、通常の実行では対象外（開催を確認できない）
    const normal = await runAnalysis(s, { date: "2026-03-01", trigger: "MANUAL", actor: "test" });
    assert.equal(normal.races.find((x) => x.raceId === "202603010511")?.status, "NOT_IN_WINDOW");
    // 過去日の再判定（BACKFILL）: 発走後（15:45）のオッズは使わず、15:20 の値で判定する
    clock.set("2026-03-02T00:10:00.000Z");
    const r = await runAnalysis(s, { date: "2026-03-01", trigger: "BACKFILL", actor: "test" });
    const r11 = r.races.find((x) => x.raceId === "202603010511");
    assert.equal(r11?.status, "ANALYZED");
    const evalRow = await s.evaluations.latestByRace(TENANT_ID, "202603010511");
    assert.equal(evalRow?.["snapshot_at"], "2026-03-01T06:20:00.123Z");
    const perf = await performanceReport(s, "2026-03-01", "2026-03-01");
    const wide = perf.combos.find((c) => c.market === "wide");
    assert.equal(wide?.hits, 1);
    assert.equal(await ingest(), envelopes.length);
  });
});
