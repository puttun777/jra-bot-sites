/** Python 互換の整形・正しく丸めた log/exp・CSV 取込・時刻の単体試験。 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { pad2, pyFixed, pyPercent, pyRepr, pySum } from "../../src/domain/pycompat.js";
import { crExp, crLog } from "../../src/domain/analysis/crmath.js";
import { csvToRecords, parseCsvLine } from "../../src/integrations/csvImport.js";
import { addDays, jstDate, jstToInstant, parseRaceId, raceIdOf } from "../../src/domain/race.js";
import { parseNormalizedRecord } from "../../src/domain/ingest.js";
import { compareVersion, kubunOf } from "../../src/domain/calendar.js";

describe("pycompat", () => {
  test("format(x, '.2f') は 2 進の正確な値で偶数丸め（0.125 → 0.12、0.375 → 0.38、2.675 → 2.67）", () => {
    assert.equal(pyFixed(0.125, 2), "0.12");
    assert.equal(pyFixed(0.375, 2), "0.38");
    assert.equal(pyFixed(2.675, 2), "2.67");
    assert.equal(pyFixed(2.5, 0), "2");
    assert.equal(pyFixed(-0.001, 2), "-0.00");
    assert.equal(pyPercent(0.1115, 1), "11.2%");
  });
  test("repr(float)", () => {
    assert.equal(pyRepr(20), "20.0");
    assert.equal(pyRepr(1e-7), "1e-07");
    assert.equal(pyRepr(0.0001), "0.0001");
    assert.equal(pyRepr(1e16), "1e+16");
    assert.equal(pyRepr(123456789012345680), "1.2345678901234568e+17");
    assert.equal(pyRepr(-0), "-0.0");
  });
  test("sum は補償加算", () => {
    assert.equal(pySum([0.1, 0.2, 0.3]), 0.6);
    assert.equal(pySum([1e16, 1, -1e16]), 1);
    assert.equal(pad2(7), "07");
  });
});

describe("crmath（正しく丸めた log / exp）", () => {
  test("既知の値と真値への近さ", () => {
    assert.equal(crLog(1), 0);
    assert.equal(crLog(Math.E), 1);
    assert.equal(crExp(0), 1);
    assert.equal(crExp(1), Math.E);
    // Python の decimal（60 桁）で確かめた正しく丸めた値
    assert.equal(crLog(0.5699993338763802), -0.5621200867921534);
    assert.equal(crExp(0.6844006221787566), 1.9825831629641066);
    assert.ok(Number.isNaN(crLog(-1)));
    assert.equal(crLog(0), -Infinity);
  });
});

describe("CSV 取込", () => {
  test("引用符・カンマを含む行と、種類ごとのレコード化", () => {
    assert.deepEqual(parseCsvLine('a,"b,c","d""e"'), ["a", "b,c", 'd"e']);
    const recs = csvToRecords("win-odds", "race_id,umaban,odds,popularity\n202611280511,1,3.1,1\n202611280511,2,4.6,\n");
    assert.equal(recs.length, 1);
    assert.equal(recs[0]?.id, "NOW");
    assert.deepEqual((recs[0]?.data["entries"] as unknown[])[1], { umaban: 2, odds: 4.6, pop: null });
    assert.throws(() => csvToRecords("win-odds", "race_id,umaban,odds\n202611280511,x,3"));
    const pays = csvToRecords("payouts", "race_id,market,key,payout\n202611280511,wide,01-02,390\n202611280511,win,01,310");
    assert.deepEqual(pays.map((p) => p.data["market"]), ["win", "wide"]);
  });
});

describe("レース ID・時刻（Asia/Tokyo）", () => {
  test("RaceId の検証（補正しない）", () => {
    assert.equal(parseRaceId("202611280511")?.date, "2026-11-28");
    assert.equal(parseRaceId("202602300511"), null);
    assert.equal(parseRaceId("202611281111"), null);
    assert.equal(parseRaceId("202611280500"), null);
    assert.equal(raceIdOf("2026-11-28", "05", 1)?.value, "202611280501");
  });
  test("JST の日付境界", () => {
    assert.equal(jstDate(new Date("2026-11-27T14:59:59Z")), "2026-11-27");
    assert.equal(jstDate(new Date("2026-11-27T15:00:00Z")), "2026-11-28");
    assert.equal(jstToInstant("2026-11-28", "15:40"), "2026-11-28T06:40:00.000Z");
    assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  });
});

describe("正規化 JSON パーサ（NormalizedJsonRecordParser と同じ規則）", () => {
  test("余分なキー・欠けたキー・重複馬番・不正な時刻は不正", () => {
    assert.equal(parseNormalizedRecord("NOW", JSON.stringify({ raceId: "202611280511", entries: [{ umaban: 1, odds: 2, pop: 1, x: 1 }] })).kind, "Malformed");
    assert.equal(parseNormalizedRecord("NOW", JSON.stringify({ raceId: "202611280511", entries: [{ umaban: 1, odds: 2, pop: 1 }, { umaban: 1, odds: 3, pop: 2 }] })).kind, "Malformed");
    assert.equal(parseNormalizedRecord("NRA", JSON.stringify({ raceId: "202611280511", kubun: "2", createdOn: "20261128", postTime: "2460", raceName: null, kai: null, nichime: null })).kind, "Malformed");
    assert.equal(parseNormalizedRecord("XYZ", "{}").kind, "Unsupported");
    assert.equal(parseNormalizedRecord("NOW", JSON.stringify({ raceId: "202611280511", entries: [] })).kind, "Malformed");
  });
  test("版の比較（作成日 → 区分。同じ日の 9 と 0 は決めない）", () => {
    const k = (c: string) => kubunOf(c) ?? (() => { throw new Error(c); })();
    assert.equal(compareVersion({ createdOn: "2026-11-28", kubun: k("2") }, { createdOn: "2026-11-27", kubun: k("9") }), "NEWER");
    assert.equal(compareVersion({ createdOn: "2026-11-28", kubun: k("1") }, { createdOn: "2026-11-28", kubun: k("2") }), "OLDER");
    assert.equal(compareVersion({ createdOn: "2026-11-28", kubun: k("9") }, { createdOn: "2026-11-28", kubun: k("0") }), "UNDECIDABLE");
  });
});
