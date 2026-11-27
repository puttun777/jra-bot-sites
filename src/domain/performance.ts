/**
 * 紙上成績（購入していない仮想の損益）の計算と集計（jra-bot-web@7bcf1c4 domain/performance の移植:
 * PaperSettlement.kt・ComboPaperSettlement.kt・PerformanceAggregator.kt）。DB には書かず毎回計算する純粋関数（D-234）。
 * - 単勝: 1 着（同着は全員）が的中。旧互換の paperPayout（stake × 通知時オッズ）と、確定払戻ベースの actualPayout を別に持つ。
 * - ワイド・三連複: 的中は取り込んだ**確定払戻の行の有無**で決める（着順から推測しない。旧実装の E17 は引き継がない）。
 * - 代表集計: 同じ (レース, 馬番 / 組み合わせ) は発走前の最新 1 件だけ。発走後の観測は数えない。
 */
import { ComboKeys, type Market } from "./race.js";

export interface ResultEntry {
  readonly umaban: number;
  readonly finish: number | null;
}
export interface StoredPayout {
  readonly comboKey: string;
  readonly payout: number;
  readonly provisional: boolean;
}

export type UnsettledReason = "NO_RESULT" | "HORSE_NOT_IN_RESULT" | "NO_FINISH" | "NOT_A_BET";
export type PaperOutcome =
  | { readonly kind: "Unsettled"; readonly reason: UnsettledReason }
  | { readonly kind: "Settled"; readonly hit: boolean; readonly stake: number; readonly paperPayout: number; readonly actualPayout: number | null };

export interface WinSignalInput {
  readonly umaban: number;
  readonly odds: number;
  readonly stake: number;
}

export function settleWin(signal: WinSignalInput, results: readonly ResultEntry[], payouts: readonly StoredPayout[]): PaperOutcome {
  if (!(signal.stake > 0) || !(signal.odds > 0)) return { kind: "Unsettled", reason: "NOT_A_BET" };
  if (results.length === 0 || !results.some((r) => (r.finish ?? 0) > 0)) return { kind: "Unsettled", reason: "NO_RESULT" };
  const mine = results.find((r) => r.umaban === signal.umaban);
  if (mine === undefined) return { kind: "Unsettled", reason: "HORSE_NOT_IN_RESULT" };
  const finish = mine.finish !== null && mine.finish > 0 ? mine.finish : null;
  if (finish === null) return { kind: "Unsettled", reason: "NO_FINISH" };
  const hit = finish === 1;
  const paper = hit ? signal.stake * signal.odds : 0.0;
  const confirmed = payouts.filter((p) => !p.provisional);
  const per100 = confirmed.find((p) => p.comboKey === String(signal.umaban).padStart(2, "0"))?.payout;
  const actual = hit ? (per100 === undefined ? null : (signal.stake * per100) / 100.0) : confirmed.length > 0 ? 0.0 : null;
  return { kind: "Settled", hit, stake: signal.stake, paperPayout: paper, actualPayout: actual };
}

export type ComboUnsettledReason = "NOT_A_BET" | "UNSUPPORTED_MARKET" | "UNPARSEABLE_KUMI" | "NO_CONFIRMED_PAYOUT" | "HORSE_WITHOUT_FINISH";
export type ComboOutcome =
  | { readonly kind: "Unsettled"; readonly reason: ComboUnsettledReason }
  | { readonly kind: "Settled"; readonly hit: boolean; readonly stake: number; readonly actualPayout: number };

/** 表示名（`02-03`・`[BOX]02-03-05`）から組み合わせキーへ。 */
export function comboKeyOf(market: Market, kumi: string): string | null {
  const n = [...kumi.matchAll(/\d+/g)].map((m) => Number(m[0]));
  if (n.some((x) => !Number.isSafeInteger(x))) return null;
  if (market === "wide") return n.length === 2 ? ComboKeys.wide(n[0] ?? 0, n[1] ?? 0) : null;
  if (market === "sanrenpuku") return n.length === 3 ? ComboKeys.sanrenpuku(n[0] ?? 0, n[1] ?? 0, n[2] ?? 0) : null;
  return null;
}

export function settleCombo(market: Market, kumi: string, stake: number, payouts: readonly StoredPayout[], results: readonly ResultEntry[]): ComboOutcome {
  if (market !== "wide" && market !== "sanrenpuku") return { kind: "Unsettled", reason: "UNSUPPORTED_MARKET" };
  if (!(stake > 0)) return { kind: "Unsettled", reason: "NOT_A_BET" };
  const key = comboKeyOf(market, kumi);
  if (key === null) return { kind: "Unsettled", reason: "UNPARSEABLE_KUMI" };
  const confirmed = payouts.filter((p) => !p.provisional);
  if (confirmed.length === 0) return { kind: "Unsettled", reason: "NO_CONFIRMED_PAYOUT" };
  const horses = key.split("-").map(Number);
  if (horses.some((h) => (results.find((r) => r.umaban === h)?.finish ?? 0) <= 0)) return { kind: "Unsettled", reason: "HORSE_WITHOUT_FINISH" };
  const per100 = confirmed.find((p) => p.comboKey === key)?.payout;
  return per100 === undefined ? { kind: "Settled", hit: false, stake, actualPayout: 0.0 } : { kind: "Settled", hit: true, stake, actualPayout: (stake * per100) / 100.0 };
}

export interface SettledSignal {
  readonly raceId: string;
  readonly umaban: number;
  readonly observedAt: string;
  readonly postAt: string;
  readonly outcome: Extract<PaperOutcome, { kind: "Settled" }>;
}
export interface PerformanceSummary {
  readonly count: number;
  readonly hits: number;
  readonly totalStake: number;
  readonly paperPayout: number;
  readonly actualPayout: number | null;
  readonly hitRate: number | null;
  readonly actualRoi: number | null;
  readonly paperRoi: number | null;
}

const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

function latestBefore<T extends { observedAt: string; postAt: string }>(items: readonly T[], key: (t: T) => string): T[] {
  const groups = new Map<string, T>();
  for (const it of items) {
    if (Date.parse(it.observedAt) > Date.parse(it.postAt)) continue;
    const k = key(it);
    const prev = groups.get(k);
    if (prev === undefined || Date.parse(it.observedAt) > Date.parse(prev.observedAt)) groups.set(k, it);
  }
  return [...groups.values()];
}

/** PerformanceAggregator.representative。 */
export function summarizeWin(signals: readonly SettledSignal[]): PerformanceSummary {
  const items = latestBefore(signals, (s) => `${s.raceId}|${s.umaban}`);
  const withActual = items.map((i) => i.outcome.actualPayout).filter((v): v is number => v !== null);
  const totalStake = sum(items.map((i) => i.outcome.stake));
  const paperPayout = sum(items.map((i) => i.outcome.paperPayout));
  const actualPayout = items.length > 0 && withActual.length === items.length ? sum(withActual) : null;
  return {
    count: items.length,
    hits: items.filter((i) => i.outcome.hit).length,
    totalStake,
    paperPayout,
    actualPayout,
    hitRate: items.length === 0 ? null : items.filter((i) => i.outcome.hit).length / items.length,
    actualRoi: totalStake <= 0 || actualPayout === null ? null : actualPayout / totalStake,
    paperRoi: totalStake <= 0 ? null : paperPayout / totalStake,
  };
}

export interface SettledCombo {
  readonly raceId: string;
  readonly market: Market;
  readonly comboKey: string;
  readonly observedAt: string;
  readonly postAt: string;
  readonly outcome: Extract<ComboOutcome, { kind: "Settled" }>;
}
export interface ComboSummary {
  readonly market: Market;
  readonly count: number;
  readonly hits: number;
  readonly totalStake: number;
  readonly actualPayout: number;
  readonly hitRate: number | null;
  readonly actualRoi: number | null;
}

/** ComboPerformance.representative（賭式名の昇順。Kotlin の enum 名 SANRENPUKU < WIDE と同じ順）。 */
export function summarizeCombos(items: readonly SettledCombo[]): ComboSummary[] {
  const reps = latestBefore(items, (c) => `${c.raceId}|${c.market}|${c.comboKey}`);
  const byMarket = new Map<Market, SettledCombo[]>();
  for (const r of reps) byMarket.set(r.market, [...(byMarket.get(r.market) ?? []), r]);
  return [...byMarket.entries()]
    .sort(([a], [b]) => (a.toUpperCase() < b.toUpperCase() ? -1 : 1))
    .map(([market, rows]) => {
      const totalStake = sum(rows.map((r) => r.outcome.stake));
      const actualPayout = sum(rows.map((r) => r.outcome.actualPayout));
      const hits = rows.filter((r) => r.outcome.hit).length;
      return { market, count: rows.length, hits, totalStake, actualPayout, hitRate: rows.length === 0 ? null : hits / rows.length, actualRoi: totalStake <= 0 ? null : actualPayout / totalStake };
    });
}
