/** JRA のオッズ（自作の最小 HTML。実ページの構造は 2026-11-28 に確認）と、人気の補完（D-S18）。 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseOddsAsOf, parseOddsRaces, parsePostTime, parseTrioOdds, parseWideOdds, parseWinOdds } from "../../src/integrations/jra/parse.js";
import { JraClient } from "../../src/integrations/jra/client.js";
import { fetchOdds } from "../../src/integrations/jra/fetch.js";
import { rankByOdds, withPopularity } from "../../src/domain/analysis/popularity.js";

const row = (r: string, time: string) => `<tr><th class="race_num"><a onclick="return doAction('/JRADB/accessO.html', 'pw151ouS30520260507${r}20261128Z/A9');">${r}</a></th>
<td class="time">${time}</td><td><a onclick="return doAction('/JRADB/accessO.html', 'pw155ouS30520260507${r}20261128Z/B9');">ワイド</a>
<a onclick="return doAction('/JRADB/accessO.html', 'pw157ouS30520260507${r}20261128Z99/23');">3連複</a></td></tr>`;
const DAY = `<table><tbody>${row("01", "9時50分")}${row("02", "10時20分")}${row("11", "15時25分")}</tbody></table>`;
const TOP = `doAction('/JRADB/accessO.html', 'pw15orl00052026050720261128/19')`;
const WIN = (asOf: string) => `<div class="cell time">発走時刻：<strong>10時20分</strong></div><div class="cell time"><strong>${asOf}現在オッズ</strong></div>
<table class="basic narrow-xy tanpuku"><tbody>
<tr><td class="waku"></td><td class="num">1</td><td class="odds_tan">54.4</td></tr>
<tr><td class="num">2</td><td class="odds_tan">16.7</td></tr>
<tr><td class="num">3</td><td class="odds_tan"><strong class="red">7.6</strong></td></tr>
<tr><td class="num">4</td><td class="odds_tan">7.6</td></tr>
<tr><td class="num">5</td><td class="odds_tan">取消</td></tr>
</tbody></table>`;
const WIDE = `<table class="basic narrow-xy wide"><caption>1</caption><tbody>
<tr><th scope="row">2</th><td class="odds"><span class="inner"><span class="min">112.4</span><span class="cap">-</span><span class="max">115.4</span></span></td></tr>
<tr><th scope="row">3</th><td class="odds"><span class="inner"><span class="min">93.7</span><span class="cap">-</span><span class="max">98.7</span></span></td></tr></tbody></table>
<table class="basic narrow-xy wide"><caption>3</caption><tbody><tr><th scope="row">4</th><td class="odds"><span class="inner"><span class="min">5.0</span><span class="cap">-</span><span class="max">6.1</span></span></td></tr></tbody></table>`;
const TRIO = `<table class="basic narrow-xy fuku3"><caption>1-2</caption><tbody><tr><th scope="row">3</th><td>1108.0</td></tr><tr><th scope="row">4</th><td>934.0</td></tr></tbody></table>
<table class="basic narrow-xy fuku3"><caption>2-3</caption><tbody><tr><th scope="row">4</th><td>55.5</td></tr></tbody></table>`;

describe("JRA のオッズの解析", () => {
  test("開催日ページ・単勝（取消は除く）・ワイド（下限/上限）・3 連複・時点・発走時刻", () => {
    const races = parseOddsRaces(DAY);
    assert.deepEqual(races.map((r) => [r.raceId, r.postTime, r.wideCname !== null, r.trioCname?.includes("Z99/")]), [
      ["202611280501", "09:50", true, true],
      ["202611280502", "10:20", true, true],
      ["202611280511", "15:25", true, true],
    ]);
    assert.deepEqual(parseWinOdds(WIN("9時58分")), [{ umaban: 1, odds: 54.4 }, { umaban: 2, odds: 16.7 }, { umaban: 3, odds: 7.6 }, { umaban: 4, odds: 7.6 }]);
    assert.equal(parseOddsAsOf(WIN("9時58分")), "09:58");
    assert.equal(parsePostTime(WIN("9時58分")), "10:20");
    assert.deepEqual(parseWideOdds(WIDE), [{ a: 1, b: 2, low: 112.4, high: 115.4 }, { a: 1, b: 3, low: 93.7, high: 98.7 }, { a: 3, b: 4, low: 5, high: 6.1 }]);
    assert.deepEqual(parseTrioOdds(TRIO), [{ a: 1, b: 2, c: 3, odds: 1108 }, { a: 1, b: 2, c: 4, odds: 934 }, { a: 2, b: 3, c: 4, odds: 55.5 }]);
  });
});

describe("人気の補完（D-S18）", () => {
  test("単勝オッズの低い順。同じオッズは同順位。一部だけ人気があるときは補わない", () => {
    assert.deepEqual([...rankByOdds([{ umaban: 1, odds: 5 }, { umaban: 2, odds: 2 }, { umaban: 3, odds: 5 }, { umaban: 4, odds: 9 }])], [[2, 1], [1, 2], [3, 2], [4, 4]]);
    const all = withPopularity([{ umaban: 1, odds: 5, popularity: null }, { umaban: 2, odds: 2, popularity: null }]);
    assert.equal(all.derived, true);
    assert.deepEqual(all.entries.map((e) => e.popularity), [2, 1]);
    const some = withPopularity([{ umaban: 1, odds: 5, popularity: 1 }, { umaban: 2, odds: 2, popularity: null }]);
    assert.equal(some.derived, false);
    assert.deepEqual(some.entries.map((e) => e.popularity), [1, 0]);
  });
});

describe("JRA のオッズの取得", () => {
  const pages = (asOf: string): Record<string, string> => ({
    "pw15oli00/6D": TOP,
    "pw15orl00052026050720261128/19": DAY,
    "pw151ouS305202605070220261128Z/A9": WIN(asOf),
    "pw155ouS305202605070220261128Z/B9": WIDE,
    "pw157ouS305202605070220261128Z99/23": TRIO,
    "pw151ouS305202605071120261128Z/A9": WIN(asOf),
    "pw155ouS305202605071120261128Z/B9": WIDE,
    "pw157ouS305202605071120261128Z99/23": TRIO,
  });
  const client = (p: Record<string, string>, seen: string[] = []) =>
    new JraClient(
      (_u, init) => {
        const c = decodeURIComponent(String(init.body).slice(6));
        seen.push(c);
        return Promise.resolve(new Response(new TextEncoder().encode(p[c] ?? "")));
      },
      () => Promise.resolve(),
      () => 0,
      "utf-8",
    );

  test("発走後のレースは取得しない・時点がオッズの観測時刻・発走まで N 分以内だけ", async () => {
    const seen: string[] = [];
    // 現在 10:00 JST（01:00Z）: 1R（9:50）は発走後で取得しない。2R・11R は発走前
    const r = await fetchOdds(client(pages("9時58分"), seen), "2026-11-28", new Date("2026-11-28T01:00:00Z"), { withinMinutes: 60 });
    assert.deepEqual(r.envelopes.map((e) => [e.raceId, e.observedAt, e.records.map((x) => x.id)]), [["202611280502", "2026-11-28T00:58:00.000Z", ["NOW", "NOD", "NOS"]]]);
    assert.ok(!seen.some((c) => c.includes("0120261128Z")), "発走後のレースのページを取得しない");
    assert.ok(!seen.some((c) => c.includes("1120261128Z")), "発走まで 60 分を超えるレースは取得しない");
    const now = r.envelopes[0]?.records[0]?.data["entries"] as { pop: unknown }[];
    assert.ok(now.every((e) => e.pop === null), "人気は取得元に無いので null で保存する");
  });

  test("時点が発走以降（最終オッズ）なら登録しない", async () => {
    const r = await fetchOdds(client(pages("10時20分")), "2026-11-28", new Date("2026-11-28T01:00:00Z"), { withinMinutes: 60 });
    assert.equal(r.envelopes.length, 0);
    assert.match(r.notes.join(), /最終オッズ/);
  });
});
