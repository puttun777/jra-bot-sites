/**
 * 旧 Python 実装 → Kotlin 実装（jra-bot-web golden-runner で全一致を確認済み）→ この TypeScript 実装、の比較。
 * フィクスチャは jra-bot-web@7bcf1c4 tools/golden/fixtures（合成データ）を gzip で同梱。比較規則はフィクスチャの comparison_rules。
 * 呼び出しの引数の解釈は jra-bot-web golden-runner/GoldenCalls.kt と同じ（未対応の呼び出しは成功に数えない）。
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { calcEv, calcExpectedProfit, calcExpectedReturn, calcKellyFraction, suggestBetAmount } from "../../src/domain/analysis/ev.js";
import { estimateProb, estimateProbNormalized, estimateProbRaw } from "../../src/domain/analysis/probability.js";
import { checkOddsDrop, checkPopularitySurge } from "../../src/domain/analysis/filters.js";
import {
  calculateTrifectaProb,
  calculateWideProb,
  estimateTrifectaOdds,
  estimateWideOdds,
  LEGACY_COMBO_DEFAULTS,
  suggestMultipleBetStrategies,
  type BetTypeLabel,
  type OddsEntry,
} from "../../src/domain/analysis/betStrategy.js";
import { evaluateOdds, LEGACY_DECISION_DEFAULTS, type DecisionConfig, type DecisionSignal } from "../../src/domain/analysis/decision.js";
import { deduplicateTickets, parseRetryAfterSeconds, splitContent } from "../../src/domain/notify.js";
import { arr, loadFixture, num, obj, optBool, optNum, optStr, runFixture, toJson, type GoldenCall, type Json } from "./harness.js";

function snapshots(v: Json | undefined): { odds: number; popularity: number }[] {
  return arr(v).map((s) => {
    const o = obj(s);
    return { odds: num(o, "odds"), popularity: num(o, "popularity") };
  });
}

function oddsList(v: Json | undefined): OddsEntry[] {
  return arr(v).map((e) => {
    const o = obj(e);
    return { umaban: num(o, "umaban"), odds: num(o, "odds"), popularity: num(o, "popularity") };
  });
}

function wideMap(k: { [key: string]: Json }): Map<string, readonly [number, number]> | null {
  const v = k["wide_odds_map"];
  if (v === undefined || v === null) return null;
  return new Map(arr(v).map((r) => {
    const a = arr(r).map((x) => (typeof x === "number" ? x : Number.NaN));
    return [`${a[0]}-${a[1]}`, [a[2] ?? Number.NaN, a[3] ?? Number.NaN] as const];
  }));
}
function triMap(k: { [key: string]: Json }): Map<string, number> | null {
  const v = k["sanrenpuku_odds_map"];
  if (v === undefined || v === null) return null;
  return new Map(arr(v).map((r) => {
    const a = arr(r).map((x) => (typeof x === "number" ? x : Number.NaN));
    return [`${a[0]}-${a[1]}-${a[2]}`, a[3] ?? Number.NaN];
  }));
}
function labels(v: Json | undefined): BetTypeLabel[] | null {
  if (v === undefined || v === null) return null;
  return arr(v).map((t) => {
    if (t === "単勝" || t === "ワイド" || t === "三連複") return t;
    throw new Error(`unknown bet type ${String(t)}`);
  });
}

function comboOpts(k: { [key: string]: Json }, base: DecisionConfig | null) {
  const d = (name: string, dflt: number): number => optNum(k, name) ?? dflt;
  const b = base ?? LEGACY_DECISION_DEFAULTS;
  return {
    topKPartners: d("top_k_partners", b.topKPartners),
    maxTicketsPerType: d("max_tickets_per_type", b.maxTicketsPerType),
    boxSize: d("box_size", b.boxSize),
    wideMinProb: d("wide_min_prob", b.wideMinProb),
    wideMaxProb: d("wide_max_prob", b.wideMaxProb),
    sanrenpukuMinProb: d("sanrenpuku_min_prob", b.sanrenpukuMinProb),
    sanrenpukuMaxProb: d("sanrenpuku_max_prob", b.sanrenpukuMaxProb),
    plackettLuceAlpha: d("plackett_luce_alpha", b.plackettLuceAlpha),
    wideMaxOverMarket: d("wide_max_over_market", b.wideMaxOverMarket),
    sanrenpukuMaxOverMarket: d("sanrenpuku_max_over_market", b.sanrenpukuMaxOverMarket),
  };
}

function signalJson(s: DecisionSignal): Json {
  const { kind: _kind, ...rest } = s;
  return toJson(rest);
}

const run = (call: GoldenCall): Json => {
  const a = call.args;
  const k = obj(a["kwargs"]);
  switch (call.function) {
    case "calc_ev":
      return calcEv(num(a, "prob"), num(a, "odds"));
    case "calc_expected_return":
      return calcExpectedReturn(num(a, "prob"), num(a, "odds"));
    case "calc_expected_profit":
      return calcExpectedProfit(num(a, "stake"), num(a, "prob"), num(a, "odds"));
    case "calc_kelly_fraction":
      return calcKellyFraction(num(a, "prob"), num(a, "odds"), optNum(k, "max_fraction") ?? 0.25);
    case "suggest_bet_amount":
      return toJson(suggestBetAmount(num(a, "prob"), num(a, "odds"), optNum(k, "bankroll") ?? 100, optNum(k, "max_fraction") ?? 0.25, optNum(k, "min_bet") ?? 1, optNum(k, "max_bet") ?? 10));
    case "estimate_prob_raw":
      return estimateProbRaw(num(a, "odds"));
    case "estimate_prob":
      return estimateProb(num(a, "odds"));
    case "estimate_prob_normalized": {
      const list = arr(a["odds_list"]).map((x) => (typeof x === "number" ? x : Number.NaN));
      const cl = optNum(a, "correction_limit");
      return cl === undefined ? estimateProbNormalized(list) : estimateProbNormalized(list, cl);
    }
    case "check_odds_drop":
      return checkOddsDrop(snapshots(a["recent_snapshots"]), num(a, "current_odds"), optNum(k, "drop_threshold") ?? 0.2);
    case "check_popularity_surge":
      return checkPopularitySurge(snapshots(a["recent_snapshots"]), num(a, "current_popularity"), optNum(k, "surge_threshold") ?? 3);
    case "estimate_wide_odds":
      return estimateWideOdds(num(a, "win_odds"));
    case "estimate_trifecta_odds":
      return estimateTrifectaOdds(num(a, "win_odds"));
    case "calculate_wide_prob":
      return calculateWideProb(num(a, "win_prob"), arr(a["odds_list"]).length === 0);
    case "calculate_trifecta_prob":
      return calculateTrifectaProb(num(a, "win_prob"), arr(a["odds_list"]).length === 0);
    case "suggest_multiple_bet_strategies": {
      const horses = oddsList(a["odds_list"]);
      const pm = obj(k["probs_by_umaban"]);
      const probs = new Map(horses.map((h) => [h.umaban, num(pm, String(h.umaban))]));
      const d = LEGACY_COMBO_DEFAULTS;
      const bundle = suggestMultipleBetStrategies(num(a, "umaban"), num(a, "win_prob"), num(a, "win_odds"), horses, {
        ...comboOpts(k, null),
        bankroll: optNum(k, "bankroll") ?? d.bankroll,
        allowedBetTypes: labels(k["allowed_bet_types"]),
        probsByUmaban: probs,
        wideOddsMap: wideMap(k),
        sanrenpukuOddsMap: triMap(k),
        evShrinkFactor: optNum(k, "ev_shrink_factor") ?? d.evShrinkFactor,
        widePayoutRate: optNum(k, "wide_payout_rate") ?? d.widePayoutRate,
        sanrenpukuPayoutRate: optNum(k, "sanrenpuku_payout_rate") ?? d.sanrenpukuPayoutRate,
        kellyFraction: optNum(k, "kelly_fraction") ?? d.kellyFraction,
        minBet: optNum(k, "min_bet") ?? d.minBet,
        maxBet: optNum(k, "max_bet") ?? d.maxBet,
        requireRealOddsForCombo: optBool(k, "require_real_odds_for_combo") ?? d.requireRealOddsForCombo,
        ticketAllocation: optStr(k, "ticket_allocation") ?? d.ticketAllocation,
        probSource: optStr(k, "prob_source") ?? "unknown",
        betStrategy: null,
      });
      return toJson(bundle);
    }
    case "evaluate_odds": {
      const d = LEGACY_DECISION_DEFAULTS;
      const bm = optStr(k, "bet_type_mode");
      const config: DecisionConfig = {
        ...d,
        ...comboOpts(k, d),
        evThreshold: optNum(k, "ev_threshold") ?? d.evThreshold,
        maxSignals: optNum(k, "max_signals") ?? d.maxSignals,
        dropThreshold: optNum(k, "drop_threshold") ?? d.dropThreshold,
        surgeThreshold: optNum(k, "surge_threshold") ?? d.surgeThreshold,
        bankroll: optNum(k, "bankroll") ?? d.bankroll,
        includeBetStrategy: optBool(k, "include_bet_strategy") ?? d.includeBetStrategy,
        betTypes: labels(k["bet_types"]) ?? d.betTypes,
        evShrinkFactor: optNum(k, "ev_shrink_factor") ?? d.evShrinkFactor,
        winMaxOverMarket: Object.hasOwn(k, "win_max_over_market") ? (optNum(k, "win_max_over_market") ?? null) : d.winMaxOverMarket,
        winPayoutRate: optNum(k, "win_payout_rate") ?? d.winPayoutRate,
        widePayoutRate: optNum(k, "wide_payout_rate") ?? d.widePayoutRate,
        sanrenpukuPayoutRate: optNum(k, "sanrenpuku_payout_rate") ?? d.sanrenpukuPayoutRate,
        showAdjustedMkt: optBool(k, "show_adjusted_mkt") ?? d.showAdjustedMkt,
        marketBlendAlpha: optNum(k, "ml_market_blend_alpha") ?? d.marketBlendAlpha,
        winProbClipMax: optNum(k, "win_prob_clip_max") ?? d.winProbClipMax,
        enableProbClip: optBool(k, "enable_prob_clip") ?? d.enableProbClip,
        notifySkips: optBool(k, "notify_skips") ?? d.notifySkips,
        kellyFraction: optNum(k, "kelly_fraction") ?? d.kellyFraction,
        minBet: optNum(k, "min_bet") ?? d.minBet,
        maxBet: optNum(k, "max_bet") ?? d.maxBet,
        requireRealOddsForCombo: optBool(k, "require_real_odds_for_combo") ?? d.requireRealOddsForCombo,
        ticketAllocation: optStr(k, "ticket_allocation") ?? d.ticketAllocation,
        betTypeMode: bm !== undefined && bm.toLowerCase() === "best_only" ? "best_only" : "multi",
        maxTotalBetPerRace: optNum(k, "max_total_bet_per_race") ?? null,
        priorityMode: optStr(k, "priority_mode") === "hit_rate" ? "hit_rate" : "edge",
        hitRateMinEv: optNum(k, "hit_rate_min_ev") ?? null,
        hitRateBetTypePriority: k["hit_rate_bet_type_priority"] === undefined || k["hit_rate_bet_type_priority"] === null ? null : arr(k["hit_rate_bet_type_priority"]).map(String),
        winOddsMax: optNum(k, "win_odds_max") ?? null,
        winProbMin: optNum(k, "win_prob_min") ?? null,
        winRatioMin: optNum(k, "win_ratio_min") ?? null,
      };
      const snaps = a["snapshots"];
      const recent = snaps === undefined ? null : (u: number) => snapshots(obj(snaps)[String(u)] ?? []);
      const r = evaluateOdds(
        { odds: oddsList(a["odds"]), recentSnapshots: recent, wideOddsMap: wideMap(k), sanrenpukuOddsMap: triMap(k), raceId: optStr(k, "race_id") ?? null },
        config,
      );
      return {
        return_shape: r.empty ? "list" : "tuple",
        signals: r.signals.map(signalJson),
        reject_counts: r.empty ? null : toJson(r.rejectCounts),
      };
    }
    case "split_content": {
      const c = obj(a["content"]);
      const content = arr(c["repeat"])
        .map((p) => {
          const [s, n] = arr(p);
          return String(s).repeat(typeof n === "number" ? n : 0);
        })
        .join("");
      const lim = optNum(k, "limit");
      return lim === undefined ? splitContent(content) : splitContent(content, lim);
    }
    case "parse_retry_after": {
      const h = obj(a["headers"]);
      const headers: Record<string, string> = {};
      for (const [key, v] of Object.entries(h)) if (typeof v === "string") headers[key] = v;
      const body = a["body"];
      return parseRetryAfterSeconds(typeof body === "string" ? body : null, headers);
    }
    case "dedupe_tickets":
      return toJson(deduplicateTickets(arr(a["tickets"]).map((t) => obj(t) as { kumi?: string; ev?: number })));
    case "signature_defaults":
      throw new Error("unsupported");
    default:
      throw new Error(`unsupported function ${call.function}`);
  }
};

/** 対応するフィクスチャ（GD11 = 旧の決済、G1/G2 = ML は未対応。docs/TEST_REPORT.md に件数を記録）。 */
const CASES = [
  "GD01-EV-001",
  "GD01-KELLY-002",
  "GD02-PROB-001",
  "GD02-NORM-002",
  "GD03-FILTER-001",
  "GD03-SNAPSHOT-002",
  "GD04-WIN-HITRATE-003",
  "GD05-COMBO-001",
  "GD05-PL-005",
  "GD05-FLOW-006",
  "GD05-BOX-007",
  "GD05-REAL-008",
  "GD05-FILTER-009",
  "GD06-EVAL-011",
  "GD07-SIZING-004",
  "GD07-COMBO-STAKE-010",
  "GD08-SELECT-003",
  "GD09-EVAL-001",
  "G8-SPLIT-001",
  "G8-DEDUP-003",
  "G8-RETRY-002",
] as const;

describe("golden: 旧 Python と同じ結果（分析・判定・通知補助）", () => {
  for (const id of CASES) {
    test(id, () => {
      const fx = loadFixture(id);
      const r = runFixture(fx, run);
      assert.ok(r.checked > 0, "比較した呼び出しが 0 件");
      assert.equal(r.skipped, 0);
      assert.deepEqual(r.failures, [], r.failures.slice(0, 5).join("\n"));
    });
  }

  test("GD10-DEFAULTS-001: 関数の既定値が旧実装と同じ", () => {
    const fx = loadFixture("GD10-DEFAULTS-001");
    const v = (id: string): { [key: string]: Json } => obj(fx.expected.get(id)?.value);
    const ev = v("sd-000");
    const d = LEGACY_DECISION_DEFAULTS;
    assert.equal(ev["ev_threshold"], d.evThreshold);
    assert.equal(ev["max_signals"], d.maxSignals);
    assert.equal(ev["drop_threshold"], d.dropThreshold);
    assert.equal(ev["surge_threshold"], d.surgeThreshold);
    assert.equal(ev["ev_shrink_factor"], d.evShrinkFactor);
    assert.equal(ev["box_size"], d.boxSize);
    assert.equal(ev["top_k_partners"], d.topKPartners);
    assert.equal(ev["max_bet"], d.maxBet);
    assert.equal(ev["bet_type_mode"], d.betTypeMode);
    assert.equal(ev["priority_mode"], d.priorityMode);
    const bs = v("sd-001");
    const c = LEGACY_COMBO_DEFAULTS;
    assert.equal(bs["ev_shrink_factor"], c.evShrinkFactor);
    assert.equal(bs["wide_max_prob"], c.wideMaxProb);
    assert.equal(bs["sanrenpuku_max_prob"], c.sanrenpukuMaxProb);
    assert.equal(bs["max_bet"], c.maxBet);
    assert.equal(bs["prob_source"], c.probSource);
    assert.equal(obj(v("sd-002"))["max_fraction"], 0.25);
    assert.equal(obj(v("sd-004"))["drop_threshold"], 0.2);
    assert.equal(obj(v("sd-005"))["surge_threshold"], 3);
  });
});
