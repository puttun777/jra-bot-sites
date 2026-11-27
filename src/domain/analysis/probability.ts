/**
 * 市場確率（旧 `src/jraev/ev/probability.py` の ML 無し経路の移植。ゴールデン GD02 で一致を確認）。
 * ML モデルの推論は `ml.ts`。モジュールグローバルのキャッシュ（旧 `_use_ml_model`）は持たない。
 */
import { pyMin, pySum } from "../pycompat.js";

/** 生の暗黙確率 1/odds（odds<=0 は 0）。 */
export function estimateProbRaw(odds: number): number {
  if (odds <= 0) return 0.0;
  return 1.0 / odds;
}

/** 1/odds を 0.99 で上限。 */
export function estimateProb(odds: number): number {
  if (odds <= 0) return 0.0;
  return pyMin(1.0 / odds, 0.99);
}

/**
 * レース内で正規化（合計 1）。±correctionLimit の補正後に再正規化（E13: 補正は再正規化で実質消える）。
 * 合計が 0 以下なら均等配分。
 */
export function estimateProbNormalized(oddsList: readonly number[], correctionLimit = 0.1): number[] {
  if (oddsList.length === 0) return [];
  const raw = oddsList.map(estimateProbRaw);
  const totalRaw = pySum(raw);
  if (totalRaw <= 0) return oddsList.map(() => 1.0 / oddsList.length);
  const normalized = raw.map((p) => p / totalRaw);
  let corrected = normalized.map((norm, i) => {
    const r = raw[i] ?? 0;
    const ratio = r > 0 ? norm / r : 1.0;
    if (ratio > 1.0 + correctionLimit) return r * (1.0 + correctionLimit);
    if (ratio < 1.0 - correctionLimit) return r * (1.0 - correctionLimit);
    return norm;
  });
  const totalCorrected = pySum(corrected);
  if (totalCorrected > 0) corrected = corrected.map((p) => p / totalCorrected);
  return corrected;
}

/** 判定側の正規化（旧 `evaluate_odds` 内 `_normalize_with_correction`）。ML 出力に使う。 */
export function normalizeWithCorrection(rawProbs: readonly number[], correctionLimit = 0.1): number[] {
  const raw = [...rawProbs];
  const s = pySum(raw);
  if (s <= 0) return raw.length > 0 ? raw.map(() => 1.0 / raw.length) : [];
  const normalized = raw.map((p) => p / s);
  const corrected = normalized.map((norm, i) => {
    const r = raw[i] ?? 0;
    if (r > 0) {
      const ratio = norm / r;
      if (ratio > 1.0 + correctionLimit) return r * (1.0 + correctionLimit);
      if (ratio < 1.0 - correctionLimit) return r * (1.0 - correctionLimit);
    }
    return norm;
  });
  const s2 = pySum(corrected);
  return s2 > 0 ? corrected.map((p) => p / s2) : normalized;
}
