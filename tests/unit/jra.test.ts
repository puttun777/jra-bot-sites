/**
 * JRA 公式サイトのアダプター。HTML は**自作の最小の見本**（実ページの構造: 2026-11-27 確認。実ページの HTML は保存しない）。
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseCardDays, parseCardRaces, parseResult, parseResultRaces } from "../../src/integrations/jra/parse.js";
import { JraClient, MIN_INTERVAL_MS } from "../../src/integrations/jra/client.js";
import { fetchCard, fetchResults } from "../../src/integrations/jra/fetch.js";

const CARD_TOP = `<a onclick="return doAction('/JRADB/accessD.html', 'pw01drl00052026050720261128/9F')">5回東京7日</a>
<a onclick="return doAction('/JRADB/accessD.html', 'pw01drl00082026050720261128/7D')">5回京都7日</a>
<a onclick="return doAction('/JRADB/accessD.html', 'pw01drl00052026050820261129/8D')">5回東京8日</a>`;
const CARD_DAY = `<table><tbody>
<tr><th class="race_num"><a href="/JRADB/accessD.html?CNAME=pw01dde0105202605070120261128/06"><img alt="1レース"></a></th>
<td class="time">9時50分</td><td class="race_name"><div><div>
  2歳未勝利</div><div></div></div></td></tr>
<tr><th class="race_num"><a href="/JRADB/accessD.html?CNAME=pw01dde0105202605071120261128/AA"><img alt="11レース"></a></th>
<td class="time">未定</td><td class="race_name"><div>キャピタルS &amp; 記念</div></td></tr>
</tbody></table>`;
const RESULT_DAY = `<a href="/JRADB/accessS.html?CNAME=pw01sde1005202605050120261122/4D">1</a><a href="/JRADB/accessS.html?CNAME=pw01sde1005202605051120261122/9F">11</a>`;
const RESULT_TOP = `doAction('/JRADB/accessS.html', 'pw01srl10052026050520261122/7A')`;
const RESULT = `<div class="cell time">発走時刻：<strong>15時20分</strong></div>
<div class="race_title"><span class="race_name">合成ステークス</span></div>
<table class="basic"><thead><tr><th scope="col" class="place">着順</th></tr></thead><tbody>
<tr><td class="place">1</td><td class="num">9</td></tr>
<tr><td class="place">2</td><td class="num">5</td></tr>
<tr><td class="place">3</td><td class="num">6</td></tr>
<tr><td class="place">取消</td><td class="num">2</td></tr>
</tbody></table>
<ul><li class="win"><dl><dd><div class="line"><div class="num">9</div><div class="yen">2,580<span>円</span></div></div></dd></dl></li>
<li class="wide"><dl><dd><div class="line"><div class="num">5-9</div><div class="yen">1,850<span>円</span></div></div>
<div class="line"><div class="num">6-9</div><div class="yen">1,710<span>円</span></div></div>
<div class="line"><div class="num">5-6</div><div class="yen">370<span>円</span></div></div></dd></dl></li>
<li class="trio"><dl><dd><div class="line"><div class="num">5-6-9</div><div class="yen">8,250<span>円</span></div></div></dd></dl></li></ul>`;

function sjis(s: string): ArrayBuffer {
  // 見本は UTF-8 で返し、クライアントの文字コードを utf-8 にして読む（実ページは Shift_JIS。実ページでの確認は docs/TEST_REPORT.md）
  return new TextEncoder().encode(s).buffer;
}

describe("JRA の解析", () => {
  test("開催日・レース・発走時刻（未定は null）・名前の実体参照", () => {
    const days = parseCardDays(CARD_TOP);
    assert.deepEqual(days.map((d) => [d.venue, d.date, d.kai, d.nichime]), [["05", "2026-11-28", 5, 7], ["08", "2026-11-28", 5, 7], ["05", "2026-11-29", 5, 8]]);
    const races = parseCardRaces(CARD_DAY);
    assert.deepEqual(races.map((r) => [r.raceId, r.postTime, r.raceName]), [["202611280501", "09:50", "2歳未勝利"], ["202611280511", null, "キャピタルS & 記念"]]);
  });
  test("結果: 数でない着順は null、払戻のキーは 0 埋めの昇順、発走時刻・レース名", () => {
    const r = parseResult(RESULT);
    assert.equal(r.postTime, "15:20");
    assert.equal(r.raceName, "合成ステークス");
    assert.deepEqual(r.finishes, [{ umaban: 9, finish: 1 }, { umaban: 5, finish: 2 }, { umaban: 6, finish: 3 }, { umaban: 2, finish: null }]);
    assert.deepEqual(r.payouts.win, [{ key: "09", payout: 2580 }]);
    assert.deepEqual(r.payouts.wide.map((x) => x.key), ["05-09", "06-09", "05-06"]);
    assert.deepEqual(r.payouts.sanrenpuku, [{ key: "05-06-09", payout: 8250 }]);
    assert.equal(parseResultRaces(RESULT_DAY).length, 2);
  });
  test("構造が変わって読めないときは空（推測で埋めない）", () => {
    const r = parseResult("<html><body>メンテナンス中</body></html>");
    assert.deepEqual(r.finishes, []);
    assert.deepEqual(r.payouts.win, []);
    assert.equal(r.postTime, null);
  });
});

describe("JRA のアクセス", () => {
  test("2 秒以上の間隔・不正な指定は送らない・HTTP エラーは例外", async () => {
    const waits: number[] = [];
    let t = 0;
    const sent: string[] = [];
    const c = new JraClient(
      (url, init) => {
        sent.push(`${url} ${String(init.body)}`);
        return Promise.resolve(new Response(sjis("ok"), { status: sent.length === 3 ? 503 : 200 }));
      },
      (ms) => {
        waits.push(ms);
        t += ms;
        return Promise.resolve();
      },
      () => t,
      "utf-8",
    );
    await c.page("accessD.html", "pw01dli00/F3");
    await c.page("accessS.html", "pw01sli00/AF");
    assert.deepEqual(waits, [MIN_INTERVAL_MS]);
    await assert.rejects(c.page("accessS.html", "pw01sli00/AF"), /HTTP 503/);
    await assert.rejects(c.page("../etc", "pw01sli00/AF"), /不正/);
    assert.equal(sent[0], "https://www.jra.go.jp/JRADB/accessD.html cname=pw01dli00%2FF3");
  });

  test("出馬表・結果の取得 → 封筒（開催日・レース・着順・払戻）", async () => {
    const pages: Record<string, string> = {
      "pw01dli00/F3": CARD_TOP,
      "pw01drl00052026050720261128/9F": CARD_DAY,
      "pw01drl00082026050720261128/7D": "<table></table>",
      "pw01sli00/AF": RESULT_TOP,
      "pw01srl10052026050520261122/7A": RESULT_DAY,
      "pw01sde1005202605050120261122/4D": RESULT,
      "pw01sde1005202605051120261122/9F": RESULT,
    };
    const c = new JraClient(
      (_u, init) => Promise.resolve(new Response(sjis(pages[decodeURIComponent(String(init.body).slice(6))] ?? ""))),
      () => Promise.resolve(),
      () => 0,
      "utf-8",
    );
    const now = new Date("2026-11-27T09:00:00Z");
    const card = await fetchCard(c, "2026-11-28", now);
    assert.deepEqual(card.records.map((r) => r.id), ["NYS", "NRA", "NRA", "NYS"]);
    assert.deepEqual(card.records[1]?.data, { raceId: "202611280501", kubun: "2", createdOn: "20261127", postTime: "0950", raceName: "2歳未勝利", kai: 5, nichime: 7 });
    assert.equal(card.records[2]?.data["kubun"], "1");
    assert.match(card.notes.join(), /08 のレース一覧を読めない/);
    const res = await fetchResults(c, "2026-11-22", now);
    assert.deepEqual(res.records.map((r) => r.id), ["NYS", "NRA", "NRS", "NHR", "NHR", "NHR", "NRA", "NRS", "NHR", "NHR", "NHR"]);
  });
});
