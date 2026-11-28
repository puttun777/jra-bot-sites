/**
 * 人気の補完（Sites 版の規則 D-S18）。取得元に人気の列が無い（JRA 公式のオッズのページは馬番順で人気を出さない）とき、
 * 単勝オッズの低い順を人気とする（同じオッズは同じ順位）。JRA の発表する人気は票数の順なので、表示のオッズが同じ馬どうしでだけ順位が違い得る。
 * 一部の馬にだけ人気があるときは補完しない（混ぜると順位が矛盾する）。
 */
export function rankByOdds(entries: readonly { readonly umaban: number; readonly odds: number }[]): Map<number, number> {
  const sorted = [...entries].sort((x, y) => x.odds - y.odds);
  const rank = new Map<number, number>();
  sorted.forEach((e, i) => {
    const prev = sorted[i - 1];
    rank.set(e.umaban, prev !== undefined && prev.odds === e.odds ? (rank.get(prev.umaban) ?? i + 1) : i + 1);
  });
  return rank;
}

/** 人気がすべて欠けていれば単勝オッズの順位で補う。補ったかどうかも返す。 */
export function withPopularity(entries: readonly { readonly umaban: number; readonly odds: number; readonly popularity: number | null }[]): { entries: { umaban: number; odds: number; popularity: number }[]; derived: boolean } {
  if (entries.length > 0 && entries.every((e) => e.popularity === null)) {
    const rank = rankByOdds(entries);
    return { entries: entries.map((e) => ({ umaban: e.umaban, odds: e.odds, popularity: rank.get(e.umaban) ?? 0 })), derived: true };
  }
  return { entries: entries.map((e) => ({ umaban: e.umaban, odds: e.odds, popularity: e.popularity ?? 0 })), derived: false };
}
