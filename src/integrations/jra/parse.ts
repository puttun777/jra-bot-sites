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

// ---- オッズ（2026-11-28 に発売中の実ページで確認）----
//   オッズの開催日    pw15orl00{場2}{年4}{回2}{日2}{日付8}/XX
//   単勝・複勝        pw151ouS3{場2}{年4}{回2}{日2}{R2}{日付8}Z/XX   table.tanpuku の td.num・td.odds_tan（馬番順。人気の列は無い）
//   ワイド            pw155ouS3…Z/XX                               table.wide（caption = 馬番 a、行 th = 馬番 b、td.odds の min/max）
//   3 連複            pw157ouS3…Z99/XX                             table.fuku3（caption = "a-b"、行 th = c、td = オッズ）
//   オッズの時点      div.cell.time「9時58分現在オッズ」、発走時刻「発走時刻：15時25分」

export interface JraOddsRace extends JraRaceLink {
  readonly postTime: string | null;
  readonly winCname: string;
  readonly wideCname: string | null;
  readonly trioCname: string | null;
}

/** オッズのトップにある開催日へのリンク。 */
export const parseOddsDays = (html: string): JraDayLink[] => dayLinks(html, "pw15orl00");

const ODDS_LINK = (kind: string) => new RegExp(`pw${kind}ouS3(\\d{2})(\\d{4})(\\d{2})(\\d{2})(\\d{2})(\\d{8})Z(?:99)?/[0-9A-F]{2}`);

/** オッズの開催日ページ: レースごとの発走時刻と、単勝・ワイド・3 連複のページ。 */
export function parseOddsRaces(html: string): JraOddsRace[] {
  const out: JraOddsRace[] = [];
  for (const row of html.split(/<tr\b/).slice(1)) {
    const win = ODDS_LINK("151").exec(row);
    if (win === null) continue;
    const [cname, venue = "", , kai = "", nichime = "", r = "", ymd = ""] = win;
    const raceId = `${ymd}${venue}${r}`;
    if (!/^(0[1-9]|10)$/.test(venue) || Number(r) < 1 || out.some((x) => x.raceId === raceId)) continue;
    const t = /<td class="time">\s*(\d{1,2})時(\d{1,2})分\s*<\/td>/.exec(row);
    const postTime = t?.[1] !== undefined && t[2] !== undefined && Number(t[1]) < 24 && Number(t[2]) < 60 ? `${t[1].padStart(2, "0")}:${t[2].padStart(2, "0")}` : null;
    out.push({
      cname,
      venue,
      kai: Number(kai),
      nichime: Number(nichime),
      raceNo: Number(r),
      date: isoOf(ymd),
      raceId,
      postTime,
      winCname: cname,
      wideCname: ODDS_LINK("155").exec(row)?.[0] ?? null,
      trioCname: ODDS_LINK("157").exec(row)?.[0] ?? null,
    });
  }
  return out.sort((a, b) => (a.raceId < b.raceId ? -1 : 1));
}

function hhmm(re: RegExp, html: string): string | null {
  const m = re.exec(html);
  const h = m?.[1];
  const mi = m?.[2];
  return h !== undefined && mi !== undefined && Number(h) < 24 && Number(mi) < 60 ? `${h.padStart(2, "0")}:${mi.padStart(2, "0")}` : null;
}
/** オッズの時点（「9時58分現在オッズ」）。 */
export const parseOddsAsOf = (html: string): string | null => hhmm(/(\d{1,2})時(\d{1,2})分現在オッズ/, html);
/** オッズのページの発走時刻。 */
export const parsePostTime = (html: string): string | null => hhmm(/発走時刻：\s*<strong>\s*(\d{1,2})時(\d{1,2})分/, html);

function decimal(s: string): number | null {
  const t = text(s);
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const v = Number(t);
  return v > 0 ? v : null;
}

/** 単勝オッズ（取消・除外などで数でない馬は含めない）。 */
export function parseWinOdds(html: string): { umaban: number; odds: number }[] {
  const table = /<table class="[^"]*\btanpuku\b[^"]*">([\s\S]*?)<\/table>/.exec(html)?.[1] ?? "";
  const out: { umaban: number; odds: number }[] = [];
  for (const row of table.split(/<tr\b/).slice(1)) {
    const num = /<td class="num">\s*(\d{1,2})\s*<\/td>/.exec(row)?.[1];
    const cell = /<td class="odds_tan">([\s\S]*?)<\/td>/.exec(row)?.[1];
    if (num === undefined || cell === undefined) continue;
    const odds = decimal(cell);
    const u = Number(num);
    if (odds !== null && u >= 1 && u <= 99 && !out.some((x) => x.umaban === u)) out.push({ umaban: u, odds });
  }
  return out;
}

/** ワイドのオッズ（下限・上限）。 */
export function parseWideOdds(html: string): { a: number; b: number; low: number; high: number | null }[] {
  const out: { a: number; b: number; low: number; high: number | null }[] = [];
  for (const t of html.matchAll(/<table class="[^"]*\bwide\b[^"]*">\s*<caption>\s*(\d{1,2})\s*<\/caption>([\s\S]*?)<\/table>/g)) {
    const a = Number(t[1]);
    for (const row of (t[2] ?? "").split(/<tr\b/).slice(1)) {
      const b = /<th scope="row">\s*(\d{1,2})\s*<\/th>/.exec(row)?.[1];
      const min = /<span class="min">([^<]*)<\/span>/.exec(row)?.[1];
      const max = /<span class="max">([^<]*)<\/span>/.exec(row)?.[1];
      if (b === undefined || min === undefined) continue;
      const low = decimal(min);
      const high = max === undefined ? null : decimal(max);
      if (low !== null && a !== Number(b)) out.push({ a, b: Number(b), low, high: high !== null && high >= low ? high : null });
    }
  }
  return out;
}

/** 3 連複のオッズ。 */
export function parseTrioOdds(html: string): { a: number; b: number; c: number; odds: number }[] {
  const out: { a: number; b: number; c: number; odds: number }[] = [];
  for (const t of html.matchAll(/<table class="[^"]*\bfuku3\b[^"]*">\s*<caption>\s*(\d{1,2})-(\d{1,2})\s*<\/caption>([\s\S]*?)<\/table>/g)) {
    const a = Number(t[1]);
    const b = Number(t[2]);
    for (const row of (t[3] ?? "").split(/<tr\b/).slice(1)) {
      const m = /<th scope="row">\s*(\d{1,2})\s*<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/.exec(row);
      if (m === null) continue;
      const odds = decimal(m[2] ?? "");
      const c = Number(m[1]);
      if (odds !== null && new Set([a, b, c]).size === 3) out.push({ a, b, c, odds });
    }
  }
  return out;
}

/** 単勝オッズの順位（domain の規則を再輸出: D-S18）。 */
export { rankByOdds } from "../../domain/analysis/popularity.js";
