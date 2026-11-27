/**
 * JRA 公式サイト（www.jra.go.jp/JRADB）のページの解析（純粋関数。HTML の文字列 → 取込の値）。
 * 構造は 2026-11-27 に実ページで確認（docs/DATA_SOURCES.md §5）。生の HTML は保存しない・Git に入れない（試験は自作の最小 HTML）。
 * 読めない値は null（推測で埋めない）。構造が変わって何も読めなければ空を返し、呼び出し側が「取得失敗」として扱う。
 *
 * ページの識別子（CNAME）の形（末尾の /XX はサイトが付ける検査用の 2 桁。こちらで計算せず、ページ内のリンクから読む）:
 *   出馬表の開催日  pw01drl00{場2}{年4}{回2}{日2}{日付8}/XX
 *   出馬表のレース  pw01dde01{場2}{年4}{回2}{日2}{R2}{日付8}/XX
 *   結果の開催日    pw01srl10{場2}{年4}{回2}{日2}{日付8}/XX
 *   結果のレース    pw01sde10{場2}{年4}{回2}{日2}{R2}{日付8}/XX
 */

export interface JraDayLink {
  readonly cname: string;
  readonly venue: string;
  readonly kai: number;
  readonly nichime: number;
  readonly date: string; // YYYY-MM-DD
}
export interface JraRaceLink {
  readonly cname: string;
  readonly venue: string;
  readonly kai: number;
  readonly nichime: number;
  readonly raceNo: number;
  readonly date: string;
  readonly raceId: string;
}
export interface JraCardRace extends JraRaceLink {
  /** "HH:MM"（読めなければ null）。 */
  readonly postTime: string | null;
  readonly raceName: string | null;
}
export interface JraResult {
  /** 結果ページの発走時刻（"HH:MM"）とレース名。過去日のレースの登録に使う。 */
  readonly postTime: string | null;
  readonly raceName: string | null;
  readonly finishes: readonly { readonly umaban: number; readonly finish: number | null }[];
  readonly payouts: Readonly<Record<"win" | "wide" | "sanrenpuku", readonly { readonly key: string; readonly payout: number }[]>>;
}

const DAY_RE = (prefix: string) => new RegExp(`${prefix}(\\d{2})(\\d{4})(\\d{2})(\\d{2})(\\d{8})/[0-9A-F]{2}`, "g");
const RACE_RE = (prefix: string) => new RegExp(`${prefix}(\\d{2})(\\d{4})(\\d{2})(\\d{2})(\\d{2})(\\d{8})/[0-9A-F]{2}`, "g");
const isoOf = (ymd: string): string => `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;

function dayLinks(html: string, prefix: string): JraDayLink[] {
  const out = new Map<string, JraDayLink>();
  for (const m of html.matchAll(DAY_RE(prefix))) {
    const [cname, venue = "", , kai = "", nichime = "", ymd = ""] = m;
    if (!/^(0[1-9]|10)$/.test(venue)) continue;
    out.set(cname, { cname, venue, kai: Number(kai), nichime: Number(nichime), date: isoOf(ymd) });
  }
  return [...out.values()];
}

function raceLinks(html: string, prefix: string): JraRaceLink[] {
  const out = new Map<string, JraRaceLink>();
  for (const m of html.matchAll(RACE_RE(prefix))) {
    const [cname, venue = "", , kai = "", nichime = "", r = "", ymd = ""] = m;
    if (!/^(0[1-9]|10)$/.test(venue) || Number(r) < 1) continue;
    const raceId = `${ymd}${venue}${r}`;
    if (!out.has(raceId)) out.set(raceId, { cname, venue, kai: Number(kai), nichime: Number(nichime), raceNo: Number(r), date: isoOf(ymd), raceId });
  }
  return [...out.values()].sort((a, b) => (a.raceId < b.raceId ? -1 : 1));
}

/** 出馬表トップ・開催日ページにある開催日へのリンク（開催日 = 場・回・日目・日付）。 */
export const parseCardDays = (html: string): JraDayLink[] => dayLinks(html, "pw01drl00");
/** 結果トップにある開催日へのリンク。 */
export const parseResultDays = (html: string): JraDayLink[] => dayLinks(html, "pw01srl10");
/** 結果の開催日ページにあるレースへのリンク。 */
export const parseResultRaces = (html: string): JraRaceLink[] => raceLinks(html, "pw01sde10");

function text(s: string): string {
  return s
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** 出馬表の開催日ページ: レースごとの発走時刻（「9時50分」）とレース名。 */
export function parseCardRaces(html: string): JraCardRace[] {
  const out: JraCardRace[] = [];
  const rows = html.split(/<tr\b/).slice(1);
  for (const row of rows) {
    const link = raceLinks(row, "pw01dde01")[0];
    if (link === undefined || out.some((r) => r.raceId === link.raceId)) continue;
    const t = /<td class="time">\s*(\d{1,2})時(\d{1,2})分\s*<\/td>/.exec(row);
    const h = t?.[1];
    const mi = t?.[2];
    const postTime = h !== undefined && mi !== undefined && Number(h) < 24 && Number(mi) < 60 ? `${h.padStart(2, "0")}:${mi.padStart(2, "0")}` : null;
    const nameCell = /<td class="race_name">([\s\S]*?)<\/td>/.exec(row)?.[1];
    const name = nameCell === undefined ? null : text(nameCell).slice(0, 100) || null;
    out.push({ ...link, postTime, raceName: name });
  }
  return out;
}

function yen(s: string): number | null {
  const v = Number(s.replace(/[,円\s]/g, ""));
  return Number.isFinite(v) && v > 0 ? v : null;
}
function payoutKey(nums: string, n: number): string | null {
  const parts = nums.split("-").map((x) => Number(x.trim()));
  if (parts.length !== n || parts.some((x) => !Number.isInteger(x) || x < 1 || x > 99) || new Set(parts).size !== n) return null;
  return [...parts]
    .sort((a, b) => a - b)
    .map((x) => String(x).padStart(2, "0"))
    .join("-");
}

/** レース結果ページ: 着順（数でない着順 = 取消・除外・中止などは null）と、単勝・ワイド・3 連複の払戻（100 円あたり）。 */
export function parseResult(html: string): JraResult {
  const finishes: { umaban: number; finish: number | null }[] = [];
  const tbody = /<table[^>]*>[\s\S]*?<th scope="col" class="place">着順<\/th>[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/.exec(html)?.[1] ?? "";
  for (const row of tbody.split(/<tr\b/).slice(1)) {
    const place = /<td class="place">\s*([^<]*?)\s*<\/td>/.exec(row)?.[1];
    const num = /<td class="num">\s*(\d{1,2})\s*<\/td>/.exec(row)?.[1];
    if (num === undefined) continue;
    const umaban = Number(num);
    if (finishes.some((f) => f.umaban === umaban)) continue;
    const f = place !== undefined && /^\d{1,2}$/.test(place) ? Number(place) : null;
    finishes.push({ umaban, finish: f !== null && f >= 1 && f <= 99 ? f : null });
  }
  const block = (cls: string, n: number): { key: string; payout: number }[] => {
    const li = new RegExp(`<li class="${cls}">([\\s\\S]*?)</li>`).exec(html)?.[1] ?? "";
    const out: { key: string; payout: number }[] = [];
    for (const m of li.matchAll(/<div class="num">\s*([\d\s-]+?)\s*<\/div>\s*<div class="yen">\s*([\d,]+)/g)) {
      const key = payoutKey(m[1] ?? "", n);
      const p = yen(m[2] ?? "");
      if (key !== null && p !== null && !out.some((x) => x.key === key)) out.push({ key, payout: p });
    }
    return out;
  };
  const t = /発走時刻：\s*<strong>\s*(\d{1,2})時(\d{1,2})分\s*<\/strong>/.exec(html);
  const h = t?.[1];
  const mi = t?.[2];
  const postTime = h !== undefined && mi !== undefined && Number(h) < 24 && Number(mi) < 60 ? `${h.padStart(2, "0")}:${mi.padStart(2, "0")}` : null;
  const nameRaw = /<div class="race_title">[\s\S]*?<span class="race_name">([\s\S]*?)<\/span>/.exec(html)?.[1];
  const raceName = nameRaw === undefined ? null : text(nameRaw).slice(0, 100) || null;
  return { postTime, raceName, finishes, payouts: { win: block("win", 1), wide: block("wide", 2), sanrenpuku: block("trio", 3) } };
}
