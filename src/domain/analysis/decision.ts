/**
 * 購入判定・シグナル生成（旧 `src/jraev/ev/decision.py` の `evaluate_odds` の移植）。
 * ゴールデン GD03-SNAPSHOT・GD04・GD06・GD07-SIZING・GD08・GD09 で旧実装と一致を確認する。
 *
 * 旧実装との違い（数値は同じ）:
 * - 旧のファイル・DB からの ML 推論は行わない。モデル確率は呼び出し側が `modelProbabilities` で渡す（無ければ市場確率）。
 * - 旧の `bet_strategy`（"kelly"/"fixed"）は旧実装のループ内変数の上書きにより常に None として渡っていた。これを固定で再現する。
 * - 見送り理由のうち旧集計に入らない経路（E3）は `extraRejects` に別に数える（旧の `reject_counts` は不変）。
 */
import { pyClamp, pyFixed, pyMax, pyMin, pyPercent, pyRepr, pySum } from "../pycompat.js";
import { calcEv } from "./ev.js";
import { crExp, crLog } from "./crmath.js";
import { checkOddsDrop, checkPopularitySurge, type OddsPopularitySnapshot } from "./filters.js";
import { estimateProbNormalized, normalizeWithCorrection } from "./probability.js";
import {
  suggestMultipleBetStrategies,
  type BetStrategyBundle,
  type BetTypeLabel,
  type OddsEntry,
  type SanrenpukuOddsMap,
  type StrategyEntry,
  type WideOddsMap,
} from "./betStrategy.js";

export type PriorityMode = "edge" | "hit_rate";

/** 判定の設定。キーは旧 `evaluate_odds` の引数名に対応する（snake_case は旧 YAML の名前）。 */
export interface DecisionConfig {
  evThreshold: number;
  maxSignals: number;
  dropThreshold: number;
  surgeThreshold: number;
  bankroll: number;
  includeBetStrategy: boolean;
  betTypes: readonly BetTypeLabel[] | null;
  topKPartners: number;
  maxTicketsPerType: number;
  boxSize: number;
  wideMinProb: number;
  wideMaxProb: number;
  sanrenpukuMinProb: number;
  sanrenpukuMaxProb: number;
  evShrinkFactor: number | null;
  plackettLuceAlpha: number;
  widePayoutRate: number;
  sanrenpukuPayoutRate: number;
  wideMaxOverMarket: number;
  sanrenpukuMaxOverMarket: number;
  winMaxOverMarket: number | null;
  winPayoutRate: number;
  showAdjustedMkt: boolean;
  /** 市場ブレンド係数（旧 ml.market_blend_alpha。null は 0.25）。 */
  marketBlendAlpha: number | null;
  /** 単勝確率の上限（旧 ml.win_prob_clip_max。null は 0.35）。 */
  winProbClipMax: number | null;
  enableProbClip: boolean;
  notifySkips: boolean;
  kellyFraction: number;
  minBet: number;
  maxBet: number;
  requireRealOddsForCombo: boolean;
  ticketAllocation: string;
  betTypeMode: "multi" | "best_only";
  maxTotalBetPerRace: number | null;
  priorityMode: PriorityMode;
  hitRateMinEv: number | null;
  hitRateBetTypePriority: readonly string[] | null;
  winOddsMax: number | null;
  winProbMin: number | null;
  winRatioMin: number | null;
  /** 旧 ml.ensemble_beta（表示用の beta_eff。ensemble 推論は未移植）。 */
  ensembleBeta: number;
}

/** 旧 `evaluate_odds` の関数既定値（ゴールデン比較用。運用には `RECOMMENDED_DECISION_CONFIG` を使う）。 */
export const LEGACY_DECISION_DEFAULTS: DecisionConfig = {
  evThreshold: 0.08,
  maxSignals: 2,
  dropThreshold: 0.2,
  surgeThreshold: 3,
  bankroll: 100.0,
  includeBetStrategy: true,
  betTypes: null,
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
  winMaxOverMarket: 0.0,
  winPayoutRate: 0.8,
  showAdjustedMkt: false,
  marketBlendAlpha: null,
  winProbClipMax: null,
  enableProbClip: true,
  notifySkips: false,
  kellyFraction: 0.25,
  minBet: 1.0,
  maxBet: 10.0,
  requireRealOddsForCombo: true,
  ticketAllocation: "best_only",
  betTypeMode: "multi",
  maxTotalBetPerRace: null,
  priorityMode: "edge",
  hitRateMinEv: null,
  hitRateBetTypePriority: null,
  winOddsMax: null,
  winProbMin: null,
  winRatioMin: null,
  ensembleBeta: 0.35,
};

/**
 * 旧 `config/config.example.yaml`（watch / ml）の推奨値を旧デーモンと同じ規則で判定設定にしたもの。
 * - hit_rate の最低 EV は時間帯別スケジュール（far/mid/near）で、`resolveHitRateMinEv` が決める。
 * - max_total_bet_per_race は設定値 6.0。
 */
export const RECOMMENDED_DECISION_CONFIG: DecisionConfig = {
  ...LEGACY_DECISION_DEFAULTS,
  evThreshold: 0.3,
  maxSignals: 1,
  dropThreshold: 0.25,
  surgeThreshold: 4,
  bankroll: 100.0,
  betTypes: ["ワイド", "三連複"],
  topKPartners: 4,
  maxTicketsPerType: 4,
  boxSize: 3,
  wideMinProb: 0.06,
  wideMaxProb: 0.18,
  sanrenpukuMinProb: 0.02,
  sanrenpukuMaxProb: 0.08,
  evShrinkFactor: 0.55,
  plackettLuceAlpha: 1.0,
  widePayoutRate: 0.775,
  sanrenpukuPayoutRate: 0.75,
  wideMaxOverMarket: 2.5,
  sanrenpukuMaxOverMarket: 4.0,
  winMaxOverMarket: 5.0,
  winPayoutRate: 0.8,
  marketBlendAlpha: 0.25,
  winProbClipMax: 0.35,
  enableProbClip: true,
  kellyFraction: 0.25,
  minBet: 1.0,
  maxBet: 6.0,
  requireRealOddsForCombo: true,
  ticketAllocation: "best_only",
  betTypeMode: "best_only",
  maxTotalBetPerRace: 6.0,
  priorityMode: "hit_rate",
  hitRateMinEv: 0.2,
  hitRateBetTypePriority: ["ワイド", "三連複"],
  ensembleBeta: 0.25,
};

/** 旧 `hit_rate_min_ev_schedule`（発走 30 分以上前 far / 5〜30 分前 mid / 5 分以内 near）。 */
export interface HitRateMinEvSchedule {
  readonly far: number;
  readonly mid: number;
  readonly near: number;
}
export const RECOMMENDED_HIT_RATE_SCHEDULE: HitRateMinEvSchedule = { far: 0.22, mid: 0.2, near: 0.16 };

/** 旧デーモンの時間帯別しきい値の決め方。minutesToPost が null（不明）のときは far を使う。 */
export function resolveHitRateMinEv(schedule: HitRateMinEvSchedule | null, base: number, minutesToPost: number | null): number {
  if (schedule === null) return base;
  if (minutesToPost === null || minutesToPost >= 30) return schedule.far;
  if (minutesToPost >= 5) return schedule.mid;
  return schedule.near;
}

/** 呼び出し側が与えるモデル確率（正規化前の生の値）と確率源ラベル。 */
export interface ModelProbabilities {
  readonly raw: readonly number[];
  readonly source: string;
}

export interface DecisionInput {
  readonly odds: readonly OddsEntry[];
  /** 馬番 → スナップショット（新しい順）。null なら急落フィルタを行わない（旧 `recent_snapshots_func=None`）。 */
  readonly recentSnapshots?: ((umaban: number) => readonly OddsPopularitySnapshot[]) | null;
  readonly wideOddsMap?: WideOddsMap | null;
  readonly sanrenpukuOddsMap?: SanrenpukuOddsMap | null;
  readonly raceId?: string | null;
  readonly modelProbabilities?: ModelProbabilities | null;
}

export interface BetSignal {
  kind: "bet";
  market: "win" | "wide" | "sanrenpuku";
  bet_type: BetTypeLabel;
  umaban: number;
  odds: number;
  popularity: number;
  prob: number;
  ev: number;
  bet_amount: number;
  prob_source: string;
  p_model: number;
  p_market: number;
  p_final: number;
  p_mkt: number;
  ratio: number;
  expected_return: number;
  coverage_score: number;
  beta_eff: number;
  has_horse_master: boolean;
  has_past_runs: boolean;
  past_n: number;
  _calc_expected_return: number;
  _calc_ev: number;
  _calc_p_mkt: number;
  _calc_ratio: number;
  reason: string;
  bet_strategy?: BetStrategyBundle;
}

export interface SkipSignal {
  kind: "skip";
  race_id: string | null;
  umaban: number;
  bet_type: BetTypeLabel;
  ev: number;
  odds: number;
  prob: number;
  prob_source: string;
  bet_strategy: BetStrategyBundle;
  skip_reason: string | null;
  payout_rate: number | null;
  show_adjusted_mkt: boolean;
  bet_amount?: number;
}

export type DecisionSignal = BetSignal | SkipSignal;

/** 旧 `reject_counts`（旧の集計規則のまま）。 */
export interface LegacyRejectCounts {
  ev_below: number;
  odds_cap: number;
  prob_below: number;
  ratio_below: number;
  drop_filtered: number;
  kelly_below_minbet: number;
  other: number;
}

/** 旧集計に入らない除外（E3）。 */
export interface ExtraRejectCounts {
  win_over_market: number;
  no_strategy: number;
  strategy_error: number;
}

export interface BestCandidate {
  umaban: number;
  odds: number;
  prob_final: number;
  p_mkt: number;
  ratio: number;
  ev: number;
  expected_return: number;
  bet_type: string;
}

export interface DecisionResult {
  /** 出走表が空のとき旧実装は `[]` を返す（集計なし）。 */
  readonly empty: boolean;
  readonly signals: DecisionSignal[];
  readonly rejectCounts: LegacyRejectCounts;
  readonly extraRejects: ExtraRejectCounts;
  readonly bestCandidate: BestCandidate | null;
  readonly bestCandidateStrategy: BetStrategyBundle | null;
  readonly probSource: string;
  /** 判定に使った最終確率（馬番順ではなく出走表の順）。 */
  readonly finalProbabilities: readonly number[];
}

const DEFAULT_BT_PRIORITY: readonly string[] = ["ワイド", "三連複"];

function marketOf(type: BetTypeLabel): "win" | "wide" | "sanrenpuku" {
  if (type === "ワイド") return "wide";
  if (type === "三連複") return "sanrenpuku";
  return "win";
}

/** 旧 `_prune_bet_strategy_to_best`（best_only のとき最推奨の賭式だけを残す）。 */
function pruneToBest(bs: BetStrategyBundle): BetStrategyBundle {
  const best = bs.best_strategy;
  if (best === null) return bs;
  const kept = bs.strategies[best.type];
  if (kept !== undefined) {
    bs.strategies = { [best.type]: kept };
    bs.total_suggested_bet = kept.suggested_bet;
    bs.total_expected_profit = kept.expected_profit;
  }
  bs.meta.bet_type_mode = "best_only";
  return bs;
}

/** 旧 `evaluate_odds`（return_debug=True 相当）。 */
export function evaluateOdds(input: DecisionInput, config: DecisionConfig): DecisionResult {
  const c = config;
  const oddsList = input.odds;
  const rejectCounts: LegacyRejectCounts = {
    ev_below: 0,
    odds_cap: 0,
    prob_below: 0,
    ratio_below: 0,
    drop_filtered: 0,
    kelly_below_minbet: 0,
    other: 0,
  };
  const extraRejects: ExtraRejectCounts = { win_over_market: 0, no_strategy: 0, strategy_error: 0 };
  if (oddsList.length === 0) {
    return {
      empty: true,
      signals: [],
      rejectCounts,
      extraRejects,
      bestCandidate: null,
      bestCandidateStrategy: null,
      probSource: "none",
      finalProbabilities: [],
    };
  }
  const raceId = input.raceId ?? null;
  const oddsValues = oddsList.map((o) => o.odds);
  const ensembleBeta = pyClamp(c.ensembleBeta, 0.0, 1.0);

  // ---- 確率（モデル → 無ければ市場）----
  let normalized: number[];
  let probSource: string;
  const mp = input.modelProbabilities ?? null;
  if (mp !== null && mp.raw.length === oddsList.length && pySum(mp.raw) > 0) {
    normalized = normalizeWithCorrection(mp.raw, 0.1);
    probSource = mp.source;
  } else {
    normalized = estimateProbNormalized(oddsValues);
    probSource = "market:fallback(ml_disabled)";
  }

  // ---- 判定側の市場ブレンド・確率クリップ・再正規化 ----
  const alpha = pyClamp(c.marketBlendAlpha ?? 0.25, 0.0, 1.0);
  const probClipMax = c.winProbClipMax ?? 0.35;
  if (alpha < 0.999) {
    const blended = normalized.map((prob, i) => {
      const odds = oddsValues[i] ?? 0;
      const pModel = prob;
      let pMkt = odds > 0 ? 1.0 / pyMax(odds, 0.1) : 0.0;
      pMkt = pyClamp(pMkt, 1e-6, 1.0 - 1e-6);
      let pFinal: number;
      if (alpha > 0.001) {
        const zModel = pModel > 1e-6 && pModel < 1.0 - 1e-6 ? crLog(pModel / (1.0 - pModel)) : 0.0;
        const zMkt = pMkt > 1e-6 && pMkt < 1.0 - 1e-6 ? crLog(pMkt / (1.0 - pMkt)) : 0.0;
        const z = alpha * zModel + (1.0 - alpha) * zMkt;
        pFinal = 1.0 / (1.0 + crExp(-Math.min(Math.max(z, -50.0), 50.0)));
      } else {
        pFinal = pMkt;
      }
      if (c.enableProbClip && probClipMax > 0) pFinal = pyMin(pFinal, probClipMax);
      return pFinal;
    });
    const total = pySum(blended);
    if (total > 0) normalized = blended.map((p) => p / total);
  }

  const signals: DecisionSignal[] = [];
  let bestCandidate: BestCandidate | null = null;
  let bestCandidateStrategy: BetStrategyBundle | null = null;
  const btPriority = c.hitRateBetTypePriority !== null && c.hitRateBetTypePriority.length > 0 ? c.hitRateBetTypePriority : DEFAULT_BT_PRIORITY;
  const bp = (t: string): number => {
    const i = btPriority.indexOf(t);
    return i >= 0 ? i : 999;
  };
  const probsMap = new Map<number, number>();
  oddsList.forEach((o, i) => probsMap.set(o.umaban, normalized[i] ?? 0));

  oddsList.forEach((oddsData, idx) => {
    const prob = normalized[idx] ?? 0;
    const pModelRaw = prob;
    const pMarket = oddsData.odds > 0 ? 1.0 / pyMax(oddsData.odds, 0.1) : 0.0;
    const pFinal = pModelRaw;
    const ratio = pMarket > 0 ? pFinal / pMarket : 0.0;
    const winEv = calcEv(prob, oddsData.odds);

    if (c.priorityMode === "hit_rate") {
      if (c.winOddsMax !== null && oddsData.odds > c.winOddsMax) {
        rejectCounts.odds_cap += 1;
        return;
      }
      if (c.winProbMin !== null && pFinal < c.winProbMin) {
        rejectCounts.prob_below += 1;
        return;
      }
      if (c.winRatioMin !== null && ratio < c.winRatioMin) {
        rejectCounts.ratio_below += 1;
        return;
      }
    }

    if (input.recentSnapshots) {
      try {
        const recent = input.recentSnapshots(oddsData.umaban);
        if (checkOddsDrop(recent, oddsData.odds, c.dropThreshold)) {
          rejectCounts.drop_filtered += 1;
          return;
        }
        if (checkPopularitySurge(recent, oddsData.popularity, c.surgeThreshold)) {
          rejectCounts.drop_filtered += 1;
          return;
        }
      } catch {
        // 旧実装どおり、スナップショット取得の失敗は判定を止めない
      }
    }

    let bs: BetStrategyBundle | null;
    let best: StrategyEntry | null;
    try {
      bs = suggestMultipleBetStrategies(oddsData.umaban, prob, oddsData.odds, oddsList, {
        bankroll: c.bankroll,
        allowedBetTypes: c.betTypes,
        probsByUmaban: probsMap,
        wideOddsMap: input.wideOddsMap ?? null,
        sanrenpukuOddsMap: input.sanrenpukuOddsMap ?? null,
        topKPartners: c.topKPartners,
        maxTicketsPerType: c.maxTicketsPerType,
        boxSize: c.boxSize,
        wideMinProb: c.wideMinProb,
        wideMaxProb: c.wideMaxProb,
        sanrenpukuMinProb: c.sanrenpukuMinProb,
        sanrenpukuMaxProb: c.sanrenpukuMaxProb,
        evShrinkFactor: c.evShrinkFactor,
        plackettLuceAlpha: c.plackettLuceAlpha,
        widePayoutRate: c.widePayoutRate,
        sanrenpukuPayoutRate: c.sanrenpukuPayoutRate,
        wideMaxOverMarket: c.wideMaxOverMarket,
        sanrenpukuMaxOverMarket: c.sanrenpukuMaxOverMarket,
        kellyFraction: c.kellyFraction,
        minBet: c.minBet,
        maxBet: c.maxBet,
        betStrategy: null,
        fixedBetAmount: 1.0,
        requireRealOddsForCombo: c.requireRealOddsForCombo,
        ticketAllocation: c.ticketAllocation,
        probSource,
      });
      if (c.betTypeMode === "best_only") bs = pruneToBest(bs);
      best = bs.best_strategy;
    } catch {
      bs = null;
      best = null;
      extraRejects.strategy_error += 1;
    }
    if (best === null || bs === null) {
      if (bs !== null) extraRejects.no_strategy += 1;
      return;
    }

    let evThresholdToUse = c.evThreshold;
    if (c.priorityMode === "hit_rate" && c.hitRateMinEv !== null) evThresholdToUse = c.hitRateMinEv;
    if (best.ev <= evThresholdToUse) {
      rejectCounts.ev_below += 1;
      return;
    }

    const suggestedBet = best.suggested_bet;
    if (suggestedBet <= 0) {
      rejectCounts.kelly_below_minbet += 1;
      if (c.notifySkips) {
        const betType = best.type;
        const payoutRate = betType === "ワイド" ? c.widePayoutRate : betType === "三連複" ? c.sanrenpukuPayoutRate : c.winPayoutRate;
        signals.push({
          kind: "skip",
          race_id: raceId,
          umaban: oddsData.umaban,
          bet_type: betType,
          ev: best.ev,
          odds: best.odds,
          prob: best.prob,
          prob_source: probSource,
          bet_strategy: bs,
          skip_reason: best.skip_reason,
          payout_rate: payoutRate,
          show_adjusted_mkt: c.showAdjustedMkt,
        });
      }
      return;
    }

    if (best.type === "単勝" && c.winMaxOverMarket !== null && c.winMaxOverMarket > 0) {
      const odds0 = best.odds;
      const p0 = best.prob;
      if (odds0 > 0 && p0 > 0) {
        const pMkt = 1.0 / odds0;
        const ratioCheck = pMkt > 0 ? p0 / pMkt : 0.0;
        if (ratioCheck > c.winMaxOverMarket) {
          extraRejects.win_over_market += 1;
          return;
        }
      }
    }

    // 最良候補（旧 debug_info.best_candidate の途中経過）
    {
      const candEv = best.ev || -1.0;
      const candProb = best.prob || pFinal;
      const candOdds = best.odds || oddsData.odds;
      let update = bestCandidate === null;
      if (bestCandidate !== null) {
        const curEv = bestCandidate.ev || -1.0;
        const curProb = bestCandidate.prob_final || 0.0;
        if (c.priorityMode === "hit_rate") {
          const curBt = bestCandidate.bet_type || "単勝";
          const candBt = best.type || "単勝";
          if (candProb > curProb) update = true;
          else if (candProb === curProb && candEv > curEv) update = true;
          else if (candProb === curProb && candEv === curEv && bp(candBt) < bp(curBt)) update = true;
        } else if (candEv > curEv) {
          update = true;
        }
      }
      if (update) {
        bestCandidate = {
          umaban: oddsData.umaban,
          odds: candOdds,
          prob_final: candProb,
          p_mkt: pMarket,
          ratio,
          ev: candEv,
          expected_return: candOdds > 0 && candProb > 0 ? candOdds * candProb : 0.0,
          bet_type: best.type,
        };
        bestCandidateStrategy = bs;
      }
    }

    const bestOdds = best.odds;
    const bestProb = best.prob;
    const bestEv = best.ev;
    const expectedReturn = bestOdds > 0 && bestProb > 0 ? bestOdds * bestProb : 0.0;
    const evCalc = expectedReturn > 0 ? expectedReturn - 1.0 : 0.0;
    const pMktCalc = bestOdds > 0 ? 1.0 / bestOdds : 0.0;
    const ratioCalc = pMktCalc > 0 ? bestProb / pMktCalc : 0.0;
    const signal: BetSignal = {
      kind: "bet",
      market: marketOf(best.type),
      bet_type: best.type,
      umaban: oddsData.umaban,
      odds: bestOdds,
      popularity: oddsData.popularity,
      prob: bestProb,
      ev: bestEv,
      bet_amount: best.suggested_bet,
      prob_source: probSource,
      p_model: pModelRaw,
      p_market: pMarket,
      p_final: pFinal,
      p_mkt: pMktCalc,
      ratio,
      expected_return: expectedReturn,
      coverage_score: 1.0,
      beta_eff: ensembleBeta,
      has_horse_master: false,
      has_past_runs: false,
      past_n: 0,
      _calc_expected_return: expectedReturn,
      _calc_ev: evCalc,
      _calc_p_mkt: pMktCalc,
      _calc_ratio: ratioCalc,
      reason:
        `最推奨=${best.type}（軸: 馬${oddsData.umaban}） EV=${pyPercent(bestEv, 1)} / ` +
        `参考: 単勝EV=${pyPercent(winEv, 1)}（odds=${pyRepr(oddsData.odds)}, p=${pyPercent(prob, 1)}）`,
    };
    if (c.includeBetStrategy) signal.bet_strategy = bs;
    signals.push(signal);
  });

  // ---- 並べ替え・選別 ----
  const probOf = (s: DecisionSignal): number => (s.kind === "bet" ? s.p_final : s.prob) || 0.0;
  if (c.priorityMode === "hit_rate") {
    signals.sort((a, b) => {
      const pa = probOf(a);
      const pb = probOf(b);
      if (pa !== pb) return pb - pa;
      const ea = a.ev || 0.0;
      const eb = b.ev || 0.0;
      if (ea !== eb) return eb - ea;
      return bp(a.bet_type || "単勝") - bp(b.bet_type || "単勝");
    });
  } else {
    signals.sort((a, b) => b.ev - a.ev);
  }
  const selected = signals.slice(0, c.maxSignals);
  const top = signals[0];
  if (top !== undefined) {
    bestCandidate = {
      umaban: top.umaban,
      odds: top.odds,
      prob_final: top.kind === "bet" ? top.p_final : top.prob,
      p_mkt: top.kind === "bet" ? top.p_mkt : 0,
      ratio: top.kind === "bet" ? top.ratio : 0,
      ev: top.ev,
      expected_return: top.kind === "bet" ? top.expected_return : 0,
      bet_type: top.bet_type,
    };
    bestCandidateStrategy = top.bet_strategy ?? null;
  }

  // ---- レース単位の総投資上限（旧の比例縮小。E6: min_bet 再判定なし・最推奨は二重に縮小される旧挙動のまま）----
  const cap = c.maxTotalBetPerRace;
  if (cap !== null && cap > 0) {
    let total = 0.0;
    for (const s of selected) total += s.bet_amount || 0.0;
    if (total > cap && total > 0) {
      const scale = cap / total;
      for (const s of selected) {
        s.bet_amount = (s.bet_amount || 0.0) * scale;
        const bs = s.bet_strategy;
        if (bs !== undefined) {
          if (bs.best_strategy !== null) {
            bs.best_strategy.suggested_bet = (bs.best_strategy.suggested_bet || 0.0) * scale;
            bs.best_strategy.expected_profit = (bs.best_strategy.expected_profit || 0.0) * scale;
          }
          for (const st of Object.values(bs.strategies)) {
            st.suggested_bet = (st.suggested_bet || 0.0) * scale;
            st.expected_profit = (st.expected_profit || 0.0) * scale;
            for (const t of st.tickets ?? []) if (t.stake !== undefined) t.stake = (t.stake || 0.0) * scale;
          }
          bs.meta.race_bet_cap_applied = true;
          bs.meta.race_bet_cap = cap;
          bs.meta.race_bet_scale = scale;
        }
      }
    }
  }

  return {
    empty: false,
    signals: selected,
    rejectCounts,
    extraRejects,
    bestCandidate,
    bestCandidateStrategy,
    probSource,
    finalProbabilities: normalized,
  };
}

/** 判定結果の 1 行要約（画面・MCP 応答用。旧 reason と別）。 */
export function summarizeSignal(s: DecisionSignal): string {
  if (s.kind === "skip") return `見送り: 馬${s.umaban} ${s.bet_type} EV=${pyPercent(s.ev, 1)}（${s.skip_reason ?? "投資額が0"}）`;
  return `${s.bet_type} 軸${s.umaban} EV=${pyPercent(s.ev, 1)} 推奨${pyFixed(s.bet_amount, 2)}点`;
}
