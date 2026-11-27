/**
 * レース識別子・場・賭式・組み合わせキー・時刻（jra-bot-web の domain/race/RaceId.kt・Venue.kt・odds/Market・ComboKeys・time/Zones の移植）。
 * 時刻は UTC の ISO 文字列で持ち、日付の判定は Asia/Tokyo（日本は夏時間なし = UTC+9 固定）で行う。
 */
export const VENUES: Readonly<Record<string, string>> = {
  "01": "札幌",
  "02": "函館",
  "03": "福島",
  "04": "新潟",
  "05": "東京",
  "06": "中山",
  "07": "中京",
  "08": "京都",
  "09": "阪神",
  "10": "小倉",
};

export function isVenue(code: string): boolean {
  return Object.hasOwn(VENUES, code);
}

export type Market = "win" | "wide" | "sanrenpuku";
export const MARKETS: readonly Market[] = ["win", "wide", "sanrenpuku"];
export function isMarket(v: string): v is Market {
  return (MARKETS as readonly string[]).includes(v);
}

/** 実在する暦日か（YYYY-MM-DD）。 */
export function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  if (y === undefined || m === undefined || d === undefined || y < 1900) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** `YYYYMMDD` + 場 2 桁 + レース番号 2 桁。不正は null（補正しない。RaceId.parseOrNull と同じ規則）。 */
export interface RaceId {
  readonly value: string;
  readonly date: string; // YYYY-MM-DD
  readonly venue: string;
  readonly raceNo: number;
}

export function parseRaceId(text: string): RaceId | null {
  if (!/^\d{12}$/.test(text)) return null;
  const date = `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  if (!isIsoDate(date)) return null;
  const venue = text.slice(8, 10);
  if (!isVenue(venue)) return null;
  const raceNo = Number(text.slice(10, 12));
  if (raceNo === 0) return null;
  return { value: text, date, venue, raceNo };
}

export function raceIdOf(date: string, venue: string, raceNo: number): RaceId | null {
  if (!isIsoDate(date) || !isVenue(venue) || !Number.isInteger(raceNo) || raceNo < 1 || raceNo > 99) return null;
  return parseRaceId(`${date.replaceAll("-", "")}${venue}${String(raceNo).padStart(2, "0")}`);
}

/** 組み合わせキー（0 埋め・昇順・重複なし。範囲 1〜99。ComboKeys.kt と同じ）。 */
export const ComboKeys = {
  win(u: number): string | null {
    return Number.isInteger(u) && u >= 1 && u <= 99 ? String(u).padStart(2, "0") : null;
  },
  wide(a: number, b: number): string | null {
    return comboKey([a, b]);
  },
  sanrenpuku(a: number, b: number, c: number): string | null {
    return comboKey([a, b, c]);
  },
};
function comboKey(nums: number[]): string | null {
  if (nums.some((n) => !Number.isInteger(n) || n < 1 || n > 99)) return null;
  if (new Set(nums).size !== nums.length) return null;
  return [...nums]
    .sort((x, y) => x - y)
    .map((n) => String(n).padStart(2, "0"))
    .join("-");
}

// ---- 時刻（Asia/Tokyo）----
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

export interface Clock {
  now(): Date;
}
export const systemClock: Clock = { now: () => new Date() };

/** 瞬間 → JST の日付（YYYY-MM-DD）。 */
export function jstDate(at: Date): string {
  return new Date(at.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/** JST の日付 + 時刻（HH:MM）→ 瞬間（UTC ISO）。 */
export function jstToInstant(date: string, hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const [y, mo, d] = date.split("-").map(Number);
  if (h === undefined || m === undefined || y === undefined || mo === undefined || d === undefined) throw new Error("invalid time");
  return new Date(Date.UTC(y, mo - 1, d, h, m) - JST_OFFSET_MS).toISOString();
}

/** 日付に日数を足す（YYYY-MM-DD）。 */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + days)).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** ISO 8601 の瞬間（Z/オフセット付き）か。 */
export function isInstant(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/.test(s) && !Number.isNaN(Date.parse(s));
}

/** 保存形式（UTC・ミリ秒 3 桁・Z）に揃える。 */
export function toIso(at: Date | string): string {
  return (typeof at === "string" ? new Date(at) : at).toISOString();
}

/** SHA-256（16 進小文字）。Web Crypto（Workers・Node 共通）。 */
export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** UUID v4（小文字）。 */
export function uuid(): string {
  return crypto.randomUUID();
}
