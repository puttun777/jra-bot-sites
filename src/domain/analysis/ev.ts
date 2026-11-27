/**
 * 期待値・Kelly 基準（旧 `src/jraev/ev/ev_calc.py` の移植。ゴールデン GD01 で旧実装と一致を確認）。
 * 数値は IEEE754 倍精度のまま。丸めは表示層だけで行う。
 */
import { LegacyZeroDivisionError, pyMax, pyMin } from "../pycompat.js";

/** EV = prob * odds - 1。prob<=0 または odds<=0 は -1。 */
export function calcEv(prob: number, odds: number): number {
  if (prob <= 0 || odds <= 0) return -1.0;
  return prob * odds - 1.0;
}

/** 期待回収倍率 = prob * odds。prob<=0 または odds<=0 は 0。 */
export function calcExpectedReturn(prob: number, odds: number): number {
  if (prob <= 0 || odds <= 0) return 0.0;
  return prob * odds;
}

/** 期待利益 = stake * EV。 */
export function calcExpectedProfit(stake: number, prob: number, odds: number): number {
  return stake * calcEv(prob, odds);
}

/**
 * Kelly 基準 f* = (p*b - q) / b（b = odds - 1）。負なら 0、`maxFraction` で上限。
 * 旧実装どおり odds == 1.0 は b = 0 の除算で例外（E5）。呼び出し側は例外を候補除外として扱う。
 */
export function calcKellyFraction(prob: number, odds: number, maxFraction = 0.25): number {
  if (prob <= 0 || odds <= 0) return 0.0;
  const b = odds - 1.0;
  const q = 1.0 - prob;
  if (b === 0) throw new LegacyZeroDivisionError();
  const kelly = (prob * b - q) / b;
  if (kelly <= 0) return 0.0;
  return pyMin(kelly, maxFraction);
}

export interface BetAmountSuggestion {
  readonly kelly_fraction: number;
  readonly suggested_bet: number;
  readonly expected_profit: number;
  readonly strategy: string;
  readonly ev: number;
}

/** 投資額の提案（旧 `suggest_bet_amount`）。 */
export function suggestBetAmount(
  prob: number,
  odds: number,
  bankroll = 100.0,
  maxFraction = 0.25,
  minBet = 1.0,
  maxBet = 10.0,
): BetAmountSuggestion {
  const ev = calcEv(prob, odds);
  const kellyFraction = calcKellyFraction(prob, odds, maxFraction);
  let suggestedBet = bankroll * kellyFraction;
  if (ev <= 0 || kellyFraction <= 0) suggestedBet = 0.0;
  else suggestedBet = pyMax(minBet, pyMin(suggestedBet, maxBet));
  const expectedProfit = suggestedBet > 0 ? calcExpectedProfit(suggestedBet, prob, odds) : 0.0;
  let strategy: string;
  if (ev <= 0) strategy = "投資推奨なし（EVが負）";
  else if (kellyFraction <= 0) strategy = "投資推奨なし（ケリー基準が負）";
  else if (kellyFraction < 0.05) strategy = "小額投資推奨（ケリー基準が低い）";
  else if (kellyFraction < 0.15) strategy = "中額投資推奨";
  else strategy = "高額投資推奨（ケリー基準が高い）";
  return { kelly_fraction: kellyFraction, suggested_bet: suggestedBet, expected_profit: expectedProfit, strategy, ev };
}
