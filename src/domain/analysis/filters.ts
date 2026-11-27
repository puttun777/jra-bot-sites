/**
 * 急落・人気急上昇フィルタ（旧 `decision.check_odds_drop` / `check_popularity_surge`。GD03 で一致を確認）。
 * スナップショットは**新しい順**。比較は最古（末尾）の 1 件とだけ行う（E14: 旧仕様のまま）。
 */
export interface OddsPopularitySnapshot {
  readonly odds: number;
  readonly popularity: number;
}

/** 急落: (最古 - 現在) / 最古 > threshold。件数 2 未満・最古が 0 以下は false。 */
export function checkOddsDrop(
  recentSnapshotsNewestFirst: readonly OddsPopularitySnapshot[],
  currentOdds: number,
  dropThreshold = 0.2,
): boolean {
  if (recentSnapshotsNewestFirst.length < 2) return false;
  const oldest = recentSnapshotsNewestFirst[recentSnapshotsNewestFirst.length - 1];
  if (oldest === undefined || oldest.odds <= 0) return false;
  const dropRate = (oldest.odds - currentOdds) / oldest.odds;
  return dropRate > dropThreshold;
}

/** 人気急上昇: 最古の人気 - 現在の人気 >= threshold。件数 2 未満は false。 */
export function checkPopularitySurge(
  recentSnapshotsNewestFirst: readonly OddsPopularitySnapshot[],
  currentPopularity: number,
  surgeThreshold = 3,
): boolean {
  if (recentSnapshotsNewestFirst.length < 2) return false;
  const oldest = recentSnapshotsNewestFirst[recentSnapshotsNewestFirst.length - 1];
  if (oldest === undefined) return false;
  return oldest.popularity - currentPopularity >= surgeThreshold;
}
