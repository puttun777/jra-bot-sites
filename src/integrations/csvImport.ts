/**
 * CSV の手動取込（第 3 優先の取得方式: docs/DATA_SOURCES.md §2）。CSV → 正規化 JSON レコード（取込の検査はサーバ側で同じものを通る）。
 * 列: win-odds = race_id,umaban,odds,popularity / results = race_id,umaban,finish / payouts = race_id,market,key,payout
 */
/** CSV の 1 行（引用符・カンマ入りの値に対応した最小の実装）。 */
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line.charAt(i);
    if (q) {
      if (c === '"' && line.charAt(i + 1) === '"') {
        cur += '"';
        i++;
      } else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim());
}

/** CSV → 正規化レコード（列名で読む。数でない値は null にせず失敗させる）。 */
export function csvToRecords(kind: string, csv: string): { id: "NOW" | "NRS" | "NHR"; data: Record<string, unknown> }[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim() !== "" && !l.startsWith("#"));
  const header = parseCsvLine(lines[0] ?? "");
  const rows = lines.slice(1).map((l) => {
    const v = parseCsvLine(l);
    return Object.fromEntries(header.map((h, i) => [h, v[i] ?? ""]));
  });
  const num = (s: string | undefined, name: string): number => {
    if (s === undefined || s === "" || Number.isNaN(Number(s))) throw new Error(`${name} が数ではない: ${String(s)}`);
    return Number(s);
  };
  const byRace = new Map<string, Record<string, string>[]>();
  for (const r of rows) byRace.set(r["race_id"] ?? "", [...(byRace.get(r["race_id"] ?? "") ?? []), r]);
  const out: { id: "NOW" | "NRS" | "NHR"; data: Record<string, unknown> }[] = [];
  for (const [raceId, rs] of byRace) {
    if (kind === "win-odds") out.push({ id: "NOW", data: { raceId, entries: rs.map((r) => ({ umaban: num(r["umaban"], "umaban"), odds: num(r["odds"], "odds"), pop: r["popularity"] ? num(r["popularity"], "popularity") : null })) } });
    else if (kind === "results") out.push({ id: "NRS", data: { raceId, entries: rs.map((r) => ({ umaban: num(r["umaban"], "umaban"), finish: r["finish"] ? num(r["finish"], "finish") : null })) } });
    else if (kind === "payouts") {
      for (const market of ["win", "wide", "sanrenpuku"]) {
        const m = rs.filter((r) => r["market"] === market);
        if (m.length > 0) out.push({ id: "NHR", data: { raceId, market, provisional: false, entries: m.map((r) => ({ key: r["key"] ?? "", payout: num(r["payout"], "payout") })) } });
      }
    } else throw new Error(`未知の kind: ${kind}`);
  }
  return out;
}

