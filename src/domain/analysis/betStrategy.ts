/**
 * 賭式ごとの買い目・確率・投資額（旧 `src/jraev/ev/bet_strategy.py` の移植）。
 * ゴールデン GD05（COMBO/PL/FLOW/BOX/REAL/FILTER）・GD07（COMBO-STAKE）で旧実装と一致を確認する。
 *
 * 旧仕様のまま固定している点（jra-bot-web MIGRATION_MATRIX §7〜8 の E 項目）:
 * - E8: ワイドは実オッズの下限で EV。確率は Plackett–Luce → 0.99 クリップ → 縮小 → *_max_prob → 市場比上限 → *_min_prob → EV>0。
 * - E9: 流し相手は人気>0 を人気順に。BOX 候補は人気上位 max(3, box_size) 頭で、軸が含まれるときだけ BOX を足す。
 * - E11: 実オッズ必須で買い目が空なら、ワイド・三連複とも「見送り」エントリを返す。
 * - E12: 投資額計算の Kelly は max_fraction=1.0 固定（Kelly 分数は確率源で補正）。
 */
import { pad2, pyClamp, pyFixed, pyMax, pyMaxBy, pyMin, pySum } from "../pycompat.js";
import { calcEv, calcExpectedProfit, calcKellyFraction } from "./ev.js";

export type BetTypeLabel = "単勝" | "ワイド" | "三連複";
export const BET_TYPE_LABELS: readonly BetTypeLabel[] = ["単勝", "ワイド", "三連複"];

/** 1 頭分のオッズ（旧 `OddsData`）。人気が無いときは 0。 */
export interface OddsEntry {
  readonly umaban: number;
  readonly odds: number;
  readonly popularity: number;
}

/** ワイドの実オッズ（キー "a-b"。a<b で与える）→ [下限, 上限]。 */
export type WideOddsMap = ReadonlyMap<string, readonly [number, number]>;
/** 三連複の実オッズ（キー "a-b-c"。昇順で与える）→ オッズ。 */
export type SanrenpukuOddsMap = ReadonlyMap<string, number>;

export interface ComboTicket {
  kumi: string;
  odds: number;
  odds_note: string;
  prob: number;
  prob_used: number;
  ev: number;
  source: "実オッズ" | "推定";
  /** 投資額が正のときだけ付く（旧実装どおり、0 のときはキー自体が無い）。 */
  stake?: number;
}

export interface StrategyEntry {
  type: BetTypeLabel;
  umaban: number;
  odds: number;
  prob: number;
  prob_used_for_bet: number;
  ev: number;
  suggested_bet: number;
  expected_profit: number;
  kelly_fraction: number;
  kelly_raw: number;
  kelly_adjusted: number;
  kelly_bet_before_clip: number;
  clipped: boolean;
  skip_reason: string | null;
  strategy: string;
  note?: string;
  tickets?: ComboTicket[];
  kumi?: string;
  combo_key?: string;
}

export interface StrategyMeta {
  require_real_odds_for_combo?: boolean;
  ticket_allocation?: string;
  prob_source?: string;
  kelly_fraction_input?: number;
  kelly_fraction_effective?: number;
  ev_shrink_factor?: number;
  bet_type_mode?: "best_only";
  race_bet_cap_applied?: boolean;
  race_bet_cap?: number;
  race_bet_scale?: number;
}

export interface BetStrategyBundle {
  strategies: Partial<Record<BetTypeLabel, StrategyEntry>>;
  /** 旧実装どおり strategies 内の同じオブジェクトを指す（縮小処理が二重に効く旧挙動 E6 の再現に必要）。 */
  best_strategy: StrategyEntry | null;
  total_suggested_bet: number;
  total_expected_profit: number;
  meta: StrategyMeta;
}

export interface ComboStrategyOptions {
  bankroll: number;
  allowedBetTypes: readonly string[] | null;
  probsByUmaban: ReadonlyMap<number, number> | null;
  wideOddsMap: WideOddsMap | null;
  sanrenpukuOddsMap: SanrenpukuOddsMap | null;
  topKPartners: number;
  maxTicketsPerType: number;
  boxSize: number;
  wideMinProb: number;
  wideMaxProb: number;
  sanrenpukuMinProb: number;
  sanrenpukuMaxProb: number;
  /** null は旧 `None`（縮小なし）。 */
  evShrinkFactor: number | null;
  plackettLuceAlpha: number;
  widePayoutRate: number;
  sanrenpukuPayoutRate: number;
  wideMaxOverMarket: number;
  sanrenpukuMaxOverMarket: number;
  /** 旧実装の `bet_strategy`。判定経由では常に null（旧 `None`）で、Kelly を使う。 */
  betStrategy: string | null;
  fixedBetAmount: number;
  kellyFraction: number;
  minBet: number;
  maxBet: number;
  requireRealOddsForCombo: boolean;
  ticketAllocation: string;
  probSource: string;
}

/** 旧 `suggest_multiple_bet_strategies` の関数既定値。 */
export const LEGACY_COMBO_DEFAULTS: ComboStrategyOptions = {
  bankroll: 100.0,
  allowedBetTypes: null,
  probsByUmaban: null,
  wideOddsMap: null,
  sanrenpukuOddsMap: null,
  topKPartners: 6,
  maxTicketsPerType: 6,
  boxSize: 4,
  wideMinProb: 0.0,
  wideMaxProb: 0.35,
  sanrenpukuMinProb: 0.0,
  sanrenpukuMaxProb: 0.2,
  evShrinkFactor: 0.7,
  plackettLuceAlpha: 1.0,
  widePayoutRate: 0.775,
  sanrenpukuPayoutRate: 0.75,
  wideMaxOverMarket: 0.0,
  sanrenpukuMaxOverMarket: 0.0,
  betStrategy: "kelly",
  fixedBetAmount: 1.0,
  kellyFraction: 0.25,
  minBet: 1.0,
  maxBet: 10.0,
  requireRealOddsForCombo: true,
  ticketAllocation: "best_only",
  probSource: "unknown",
};

/** 旧 `estimate_wide_odds`（区分係数による推定）。 */
export function estimateWideOdds(winOdds: number): number {
  if (winOdds <= 0) return 0.0;
  if (winOdds <= 3.0) return winOdds * 0.4;
  if (winOdds <= 10.0) return winOdds * 0.35;
  return winOdds * 0.3;
}

/** 旧 `estimate_trifecta_odds`。 */
export function estimateTrifectaOdds(winOdds: number): number {
  if (winOdds <= 0) return 0.0;
  if (winOdds <= 3.0) return winOdds * 0.03;
  if (winOdds <= 10.0) return winOdds * 0.02;
  return winOdds * 0.01;
}

/** 旧 `calculate_wide_prob`（簡易版。判定では未使用）。 */
export function calculateWideProb(winProb: number, oddsListEmpty: boolean): number {
  if (oddsListEmpty || winProb <= 0) return 0.0;
  return pyMin(winProb + winProb * 0.5, 0.99);
}

/** 旧 `calculate_trifecta_prob`（簡易版。判定では未使用）。 */
export function calculateTrifectaProb(winProb: number, oddsListEmpty: boolean): number {
  if (oddsListEmpty || winProb <= 0) return 0.0;
  return pyMin(winProb + winProb * 0.5 + winProb * 0.3, 0.99);
}

/** 3 頭の全順列（旧 itertools.permutations の順序）。 */
const PERMS3: readonly (readonly [0 | 1 | 2, 0 | 1 | 2, 0 | 1 | 2])[] = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
];

interface BetAmountInfo {
  suggested_bet: number;
  kelly_raw: number;
  kelly_adjusted: number;
  kelly_bet_before_clip: number;
  clipped: boolean;
  skip_reason: string | null;
}

/** 旧 `bool(dict)`（None・空は偽）。 */
function truthyMap(m: ReadonlyMap<string, unknown> | null): boolean {
  return m !== null && m.size > 0;
}

/**
 * 旧 `suggest_multiple_bet_strategies`。
 * 例外: odds == 1.0 の Kelly（旧 ZeroDivisionError）。呼び出し側（判定）はその馬を候補から外す。
 */
export function suggestMultipleBetStrategies(
  umaban: number,
  winProb: number,
  winOdds: number,
  oddsList: readonly OddsEntry[],
  options: Partial<ComboStrategyOptions> = {},
): BetStrategyBundle {
  const o: ComboStrategyOptions = { ...LEGACY_COMBO_DEFAULTS, ...options };
  const strategies: Partial<Record<BetTypeLabel, StrategyEntry>> = {};

  const capOverMarket = (p: number, odds: number, payoutRate: number, maxOverMarket: number): number => {
    if (maxOverMarket <= 0) return p;
    const oo = pyMax(odds, 0.1);
    const r = pyClamp(payoutRate, 0.0, 1.0);
    return pyMin(p, maxOverMarket * (r / oo));
  };
  const probUsed = (pRaw: number): number => {
    const f = pyClamp(o.evShrinkFactor ?? 1.0, 0.0, 1.0);
    return pyClamp(pRaw * f, 0.0, 0.99);
  };
  const kellyFracAdjusted = (base: number): number => {
    const s = o.probSource.toLowerCase();
    let m = 0.8;
    if (s === "ml_features") m = 1.0;
    else if (s === "ml_model") m = 0.9;
    else if (s === "market") m = 0.8;
    return pyClamp(base * m, 0.0, 1.0);
  };
  const findEntry = (u: number): OddsEntry | undefined => oddsList.find((x) => x.umaban === u);
  const score = (u: number): number => {
    let p: number | undefined = o.probsByUmaban?.get(u);
    if (p === undefined) {
      const e = findEntry(u);
      p = e !== undefined && e.odds !== 0 ? 1.0 / pyMax(e.odds, 0.1) : 0.0;
    }
    p = pyClamp(p, 1e-12, 0.99);
    const a = pyClamp(o.plackettLuceAlpha || 1.0, 0.1, 5.0);
    return Math.pow(p, a);
  };

  // 重み（旧 dict の挿入順 = 出走表の順。重複馬番は最初の位置に後の値）
  const weights = new Map<number, number>();
  for (const e of oddsList) if (e.umaban > 0) weights.set(e.umaban, score(e.umaban));
  const weightTotal = pySum([...weights.values()]);

  const plOrderProb = (order: readonly number[]): number => {
    let remaining = weightTotal;
    if (remaining <= 0) return 0.0;
    let p = 1.0;
    for (const u of order) {
      const w = weights.get(u) ?? 0.0;
      if (w <= 0 || remaining <= 0) return 0.0;
      p *= w / remaining;
      remaining -= w;
    }
    return pyClamp(p, 0.0, 0.99);
  };
  const top3SetProb = (a: number, b: number, c: number): number => {
    const xs = [a, b, c] as const;
    let s = 0.0;
    for (const [i, j, k] of PERMS3) s += plOrderProb([xs[i], xs[j], xs[k]]);
    return pyClamp(s, 0.0, 0.99);
  };
  const widePairProb = (a: number, b: number): number => {
    let total = 0.0;
    for (const e of oddsList) {
      if (e.umaban === a || e.umaban === b) continue;
      total += top3SetProb(a, b, e.umaban);
    }
    return pyClamp(total, 0.0, 0.99);
  };
  const allowed = (t: BetTypeLabel): boolean => o.allowedBetTypes === null || o.allowedBetTypes.includes(t);

  const boxCandidates = ((): number[] => {
    let base = oddsList.filter((e) => e.popularity > 0);
    if (base.length > 0) base = [...base].sort((x, y) => x.popularity - y.popularity);
    else base = oddsList.filter((e) => e.odds > 0).sort((x, y) => x.odds - y.odds);
    return base.map((e) => e.umaban).slice(0, Math.max(3, Math.trunc(o.boxSize)));
  })();

  const calcBetAmount = (prob: number, odds: number): BetAmountInfo => {
    if (o.betStrategy === "fixed") {
      return {
        suggested_bet: o.fixedBetAmount,
        kelly_raw: 0.0,
        kelly_adjusted: 0.0,
        kelly_bet_before_clip: o.fixedBetAmount,
        clipped: false,
        skip_reason: null,
      };
    }
    const kellyRaw = calcKellyFraction(prob, odds, 1.0);
    const kellyAdjusted = kellyRaw * kellyFracAdjusted(o.kellyFraction);
    const before = o.bankroll * kellyAdjusted;
    if (before < o.minBet) {
      return {
        suggested_bet: 0.0,
        kelly_raw: kellyRaw,
        kelly_adjusted: kellyAdjusted,
        kelly_bet_before_clip: before,
        clipped: false,
        skip_reason: `Kelly推奨額(${pyFixed(before, 2)}点) < min_bet(${pyFixed(o.minBet, 1)}点)`,
      };
    }
    if (before > o.maxBet) {
      return {
        suggested_bet: o.maxBet,
        kelly_raw: kellyRaw,
        kelly_adjusted: kellyAdjusted,
        kelly_bet_before_clip: before,
        clipped: true,
        skip_reason: null,
      };
    }
    return {
      suggested_bet: before,
      kelly_raw: kellyRaw,
      kelly_adjusted: kellyAdjusted,
      kelly_bet_before_clip: before,
      clipped: false,
      skip_reason: null,
    };
  };

  const skipEntry = (type: "ワイド" | "三連複"): StrategyEntry => ({
    type,
    umaban,
    odds: 0.0,
    prob: 0.0,
    prob_used_for_bet: 0.0,
    ev: 0.0,
    suggested_bet: 0.0,
    expected_profit: 0.0,
    kelly_fraction: 0.0,
    kelly_raw: 0.0,
    kelly_adjusted: 0.0,
    kelly_bet_before_clip: 0.0,
    clipped: false,
    skip_reason: "実オッズ未取得のため見送り（推定オッズは使用しない設定）",
    strategy: `${type}: 見送り`,
    note: "※ 実オッズが取れた場合のみ判定/投資します",
    tickets: [],
  });

  /** 買い目の並べ替え・切り詰め・投資額・配分（ワイド・三連複で共通の旧コード）。 */
  const finishCombo = (type: "ワイド" | "三連複", raw: ComboTicket[], strategyText: (n: number) => string, note: string): void => {
    const tickets = [...raw].sort((x, y) => y.ev - x.ev).slice(0, Math.max(1, Math.trunc(o.maxTicketsPerType)));
    const bestT = tickets[0];
    if (bestT === undefined) {
      if (o.requireRealOddsForCombo) strategies[type] = skipEntry(type);
      return;
    }
    const bestProb = bestT.prob_used;
    const bestOdds = bestT.odds;
    const info = calcBetAmount(bestProb, bestOdds);
    const bet = info.suggested_bet;
    if (bet > 0) {
      if (o.ticketAllocation.toLowerCase() === "proportional_ev") {
        let ws = tickets.map((t) => pyMax(t.ev, 0.0));
        let s = pySum(ws);
        if (s <= 0) {
          ws = tickets.map((_, i) => (i === 0 ? 1.0 : 0.0));
          s = 1.0;
        }
        tickets.forEach((t, i) => {
          t.stake = (bet * (ws[i] ?? 0)) / s;
        });
      } else {
        tickets.forEach((t, i) => {
          t.stake = i === 0 ? bet : 0.0;
        });
      }
    }
    let expectedProfit = 0.0;
    for (const t of tickets) {
      const stake = t.stake ?? 0.0;
      if (stake > 0 && t.prob_used > 0 && t.odds > 0) expectedProfit += calcExpectedProfit(stake, t.prob_used, t.odds);
    }
    const kelly = calcKellyFraction(bestProb, bestOdds, 1.0) * kellyFracAdjusted(o.kellyFraction);
    strategies[type] = {
      type,
      umaban,
      odds: bestT.odds,
      prob: bestT.prob,
      prob_used_for_bet: bestT.prob_used,
      ev: bestT.ev,
      suggested_bet: bet,
      expected_profit: expectedProfit,
      kelly_fraction: kelly,
      kelly_raw: info.kelly_raw,
      kelly_adjusted: info.kelly_adjusted,
      kelly_bet_before_clip: info.kelly_bet_before_clip,
      clipped: info.clipped,
      skip_reason: info.skip_reason,
      strategy: strategyText(tickets.length),
      note,
      tickets,
      kumi: bestT.kumi,
      combo_key: bestT.kumi,
    };
  };

  /** 確率の段階（E8 の順）と EV>0 の判定。採用しないときは null。 */
  const comboTicket = (
    kumi: string,
    pRaw: number,
    oddsUsed: number,
    oddsNote: string,
    source: "実オッズ" | "推定",
    maxProb: number,
    payoutRate: number,
    maxOverMarket: number,
    minProb: number,
  ): ComboTicket | null => {
    let p = probUsed(pRaw);
    p = maxProb > 0 ? pyMin(p, maxProb) : p;
    p = capOverMarket(p, oddsUsed, payoutRate, maxOverMarket);
    if (minProb > 0 && p < minProb) return null;
    const ev = calcEv(p, oddsUsed);
    if (ev <= 0) return null;
    return { kumi, odds: oddsUsed, odds_note: oddsNote, prob: pRaw, prob_used: p, ev, source };
  };

  // ---- 単勝 ----
  if (allowed("単勝")) {
    const pUsed = probUsed(winProb);
    const winEv = calcEv(pUsed, winOdds);
    const info = calcBetAmount(pUsed, winOdds);
    const winBet = info.suggested_bet;
    const winExpectedProfit = winBet > 0 ? calcExpectedProfit(winBet, pUsed, winOdds) : 0.0;
    const winKelly = calcKellyFraction(pUsed, winOdds, 1.0) * kellyFracAdjusted(o.kellyFraction);
    strategies["単勝"] = {
      type: "単勝",
      umaban,
      odds: winOdds,
      prob: winProb,
      prob_used_for_bet: pUsed,
      ev: winEv,
      suggested_bet: winBet,
      expected_profit: winExpectedProfit,
      kelly_fraction: winKelly,
      kelly_raw: info.kelly_raw,
      kelly_adjusted: info.kelly_adjusted,
      kelly_bet_before_clip: info.kelly_bet_before_clip,
      clipped: info.clipped,
      skip_reason: info.skip_reason,
      strategy: `投資戦略: ${o.betStrategy ?? "None"} (Kelly分数=${pyFixed(o.kellyFraction, 2)})`,
    };
  }

  const partnersByPopularity = oddsList
    .filter((e) => e.umaban !== umaban && e.popularity > 0)
    .sort((x, y) => x.popularity - y.popularity)
    .map((e) => e.umaban);
  const axisInBox = boxCandidates.length >= 3 && boxCandidates.includes(umaban);

  // ---- ワイド ----
  if (allowed("ワイド")) {
    const partners = partnersByPopularity.slice(0, Math.max(1, Math.trunc(o.topKPartners)));
    const tickets: ComboTicket[] = [];
    const wideOdds = (a: number, b: number, estBase: () => number): { used: number; note: string; source: "実オッズ" | "推定" } | null => {
      const lowHigh = o.wideOddsMap?.get(`${a}-${b}`);
      if (lowHigh !== undefined) {
        const [low, high] = lowHigh;
        return { used: low, note: `${pyFixed(low, 1)}〜${pyFixed(high, 1)}`, source: "実オッズ" };
      }
      const est = estimateWideOdds(estBase());
      if (o.requireRealOddsForCombo) return null;
      return { used: est, note: `${pyFixed(est, 1)}（推定）`, source: "推定" };
    };
    for (const p of partners) {
      const [x, y] = umaban < p ? [umaban, p] : [p, umaban];
      const od = wideOdds(x, y, () => winOdds);
      if (od === null) continue;
      const t = comboTicket(`${pad2(x)}-${pad2(y)}`, widePairProb(umaban, p), od.used, od.note, od.source, o.wideMaxProb, o.widePayoutRate, o.wideMaxOverMarket, o.wideMinProb);
      if (t !== null) tickets.push(t);
    }
    if (axisInBox) {
      for (let i = 0; i < boxCandidates.length; i++) {
        for (let j = i + 1; j < boxCandidates.length; j++) {
          const a = boxCandidates[i] ?? 0;
          const b = boxCandidates[j] ?? 0;
          const [x, y] = a < b ? [a, b] : [b, a];
          const od = wideOdds(x, y, () => pyMin(findEntry(a)?.odds ?? winOdds, findEntry(b)?.odds ?? winOdds));
          if (od === null) continue;
          const t = comboTicket(`[BOX]${pad2(x)}-${pad2(y)}`, widePairProb(a, b), od.used, od.note, od.source, o.wideMaxProb, o.widePayoutRate, o.wideMaxOverMarket, o.wideMinProb);
          if (t !== null) tickets.push(t);
        }
      }
    }
    finishCombo(
      "ワイド",
      tickets,
      (n) => `ワイド：軸${umaban}→流し＋BOX候補（上位${n}点）`,
      truthyMap(o.wideOddsMap) ? "※ 実オッズ優先（低い方でEV計算）" : "※ オッズは推定値",
    );
  }

  // ---- 三連複 ----
  if (allowed("三連複")) {
    const partners = partnersByPopularity.slice(0, Math.max(3, Math.trunc(o.topKPartners)));
    const tickets: ComboTicket[] = [];
    const triOdds = (k: readonly number[], estBase: () => number): { used: number; note: string; source: "実オッズ" | "推定" } | null => {
      const v = o.sanrenpukuOddsMap?.get(k.join("-"));
      if (v !== undefined && v !== 0) return { used: v, note: pyFixed(v, 1), source: "実オッズ" };
      const est = estimateTrifectaOdds(estBase());
      if (o.requireRealOddsForCombo) return null;
      return { used: est, note: `${pyFixed(est, 1)}（推定）`, source: "推定" };
    };
    const sorted3 = (a: number, b: number, c: number): number[] => [a, b, c].sort((x, y) => x - y);
    for (let i = 0; i < partners.length; i++) {
      for (let j = i + 1; j < partners.length; j++) {
        const a = partners[i] ?? 0;
        const b = partners[j] ?? 0;
        const key3 = sorted3(umaban, a, b);
        const od = triOdds(key3, () => winOdds);
        if (od === null) continue;
        const t = comboTicket(key3.map(pad2).join("-"), top3SetProb(umaban, a, b), od.used, od.note, od.source, o.sanrenpukuMaxProb, o.sanrenpukuPayoutRate, o.sanrenpukuMaxOverMarket, o.sanrenpukuMinProb);
        if (t !== null) tickets.push(t);
      }
    }
    if (axisInBox) {
      for (let i = 0; i < boxCandidates.length; i++) {
        for (let j = i + 1; j < boxCandidates.length; j++) {
          for (let k = j + 1; k < boxCandidates.length; k++) {
            const a = boxCandidates[i] ?? 0;
            const b = boxCandidates[j] ?? 0;
            const c = boxCandidates[k] ?? 0;
            const key3 = sorted3(a, b, c);
            const od = triOdds(key3, () =>
              pyMin(pyMin(findEntry(a)?.odds ?? winOdds, findEntry(b)?.odds ?? winOdds), findEntry(c)?.odds ?? winOdds),
            );
            if (od === null) continue;
            const t = comboTicket(`[BOX]${key3.map(pad2).join("-")}`, top3SetProb(a, b, c), od.used, od.note, od.source, o.sanrenpukuMaxProb, o.sanrenpukuPayoutRate, o.sanrenpukuMaxOverMarket, o.sanrenpukuMinProb);
            if (t !== null) tickets.push(t);
          }
        }
      }
    }
    finishCombo(
      "三連複",
      tickets,
      (n) => `三連複：軸${umaban}→流し＋BOX候補（上位${n}点）`,
      truthyMap(o.sanrenpukuOddsMap) ? "※ 実オッズ優先" : "※ オッズは推定値",
    );
  }

  const all = Object.values(strategies);
  const valid = all.filter((s) => s.suggested_bet > 0);
  const best = (valid.length > 0 ? pyMaxBy(valid, (s) => s.ev) : pyMaxBy(all, (s) => s.ev)) ?? null;
  return {
    strategies,
    best_strategy: best,
    total_suggested_bet: pySum(all.map((s) => s.suggested_bet)),
    total_expected_profit: pySum(all.map((s) => s.expected_profit)),
    meta: {
      require_real_odds_for_combo: o.requireRealOddsForCombo,
      ticket_allocation: o.ticketAllocation || "best_only",
      prob_source: o.probSource || "unknown",
      kelly_fraction_input: o.kellyFraction,
      kelly_fraction_effective: kellyFracAdjusted(o.kellyFraction),
      ev_shrink_factor: pyClamp(o.evShrinkFactor || 1.0, 0.0, 1.0),
    },
  };
}
