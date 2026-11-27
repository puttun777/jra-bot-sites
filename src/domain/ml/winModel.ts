/**
 * 旧 `src/jraev/ml/model.py` の WinProbabilityModel（numpy のロジスティック回帰）の推論と、`features.py` のハッシュ特徴。
 * ゴールデン G1（モデル推論）・G2（ハッシュ）で旧実装と一致を確認する。モデルは JSON（重み・バイアス・Platt・市場ブレンド α）で持つ（pickle は使わない）。
 * 学習（fit）と DB の特徴量（G3〜G7）は未移植（docs/FEATURE_MATRIX #25）。
 */
import { crExp, crLog } from "../analysis/crmath.js";
import { pyMax, pyMin } from "../pycompat.js";
import { md5, utf8Ignore } from "./md5.js";

export interface WinModelDocument {
  /** null は未学習（旧: weights is None → 1/odds を返す）。 */
  readonly weights: readonly number[] | null;
  readonly bias: number;
  readonly calibA?: number | null;
  readonly calibB?: number | null;
  readonly marketBlendAlpha?: number;
}

export const LEGACY_FEATURE_NAMES = ["odds", "popularity", "log_odds", "inv_popularity", "odds_popularity_interaction"] as const;

/** 旧 extract_features（odds<=0 は 100 とみなす）。 */
export function extractFeatures(odds: number, popularity: number): number[] {
  const o = odds <= 0 ? 100.0 : odds;
  return [o, popularity, crLog(pyMax(o, 0.1)), 1.0 / pyMax(popularity, 1), o * popularity];
}

const clip50 = (z: number): number => Math.min(Math.max(z, -50.0), 50.0);
const sigmoid = (z: number): number => 1.0 / (1.0 + crExp(-clip50(z)));

/** 次元を重みに合わせる（多ければ切り詰め・少なければ 0 埋め。旧 _align_feature_matrix）。 */
function logit(m: WinModelDocument, x: readonly number[]): number {
  const w = m.weights ?? [];
  let s = 0;
  for (let i = 0; i < w.length; i++) s += (x[i] ?? 0) * (w[i] ?? 0);
  return s + m.bias;
}

/** 旧 _postprocess_prob（Platt → 市場ブレンド）。 */
function postprocess(m: WinModelDocument, p0: number, odds: number): number {
  let p = pyMin(pyMax(p0, 1e-6), 1.0 - 1e-6);
  if (m.calibA !== undefined && m.calibA !== null && m.calibB !== undefined && m.calibB !== null) {
    const z = crLog(p / (1.0 - p));
    p = sigmoid(m.calibA * z + m.calibB);
    p = pyMin(pyMax(p, 1e-6), 1.0 - 1e-6);
  }
  let pMkt = 1.0 / pyMax(odds, 0.1);
  pMkt = pyMin(pyMax(pMkt, 1e-6), 1.0 - 1e-6);
  const a = pyMin(pyMax(m.marketBlendAlpha ?? 1.0, 0.0), 1.0);
  if (a >= 0.999) return p;
  if (a <= 0.001) return pMkt;
  const z = a * crLog(p / (1.0 - p)) + (1.0 - a) * crLog(pMkt / (1.0 - pMkt));
  return sigmoid(z);
}

/** 旧 predict。 */
export function predictWin(m: WinModelDocument, odds: number, popularity: number): number {
  if (m.weights === null) return 1.0 / pyMax(odds, 0.1);
  const p = sigmoid(logit(m, extractFeatures(odds, popularity)));
  return pyMax(0.0, pyMin(1.0, postprocess(m, p, odds)));
}

/** 旧 predict_batch。 */
export function predictWinBatch(m: WinModelDocument, odds: readonly number[], popularity: readonly number[]): number[] {
  if (m.weights === null) return odds.map((o) => 1.0 / pyMax(o, 0.1));
  return odds.map((o, i) => pyMax(0.0, pyMin(1.0, postprocess(m, sigmoid(logit(m, extractFeatures(o, popularity[i] ?? 0))), o))));
}

/** 旧 _hash_bucket（MD5 の先頭 4 バイトをリトルエンディアンで → dim の剰余）。 */
export function hashBucket(s: string, dim: number): number {
  const h = md5(utf8Ignore(s));
  const v = ((h[0] ?? 0) | ((h[1] ?? 0) << 8) | ((h[2] ?? 0) << 16) | ((h[3] ?? 0) << 24)) >>> 0;
  return v % Math.max(1, Math.trunc(dim));
}

/** 旧 _hash_sign。 */
export function hashSign(s: string): number {
  return (md5(utf8Ignore(`sign:${s}`))[0] ?? 0) % 2 === 0 ? 1.0 : -1.0;
}
