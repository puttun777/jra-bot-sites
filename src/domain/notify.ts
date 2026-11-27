/**
 * 通知の補助（旧 `src/jraev/notify/discord.py` の `_split_content`・`_parse_retry_after_seconds`・`_deduplicate_tickets` と、
 * jra-bot-web の notify/ContentSplitter.kt・RateLimitWait.kt・NoticeFormatter.kt `NoticeTickets` の移植）。ゴールデン G8 で旧実装と一致を確認する。
 * Discord への送信そのもの（integrations/discord.ts）は、Sites の外部通信の可否を確認するまで既定で無効。
 */

/** 旧 `_DISCORD_SAFE_CHUNK_LIMIT`（2000 字の上限に余裕を持たせた 1900）。 */
export const DISCORD_SAFE_CHUNK_LIMIT = 1900;

const LINE_BREAKS = new Set(["\n", "\r", "\v", "\f", "\x1c", "\x1d", "\x1e", "\x85", " ", " "]);

/** Python の `str.splitlines(keepends=True)`（コードポイントの配列で）。 */
function splitLinesKeepEnds(cps: readonly string[]): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  for (let i = 0; i < cps.length; i++) {
    const c = cps[i] ?? "";
    cur.push(c);
    if (c === "\r" && cps[i + 1] === "\n") {
      cur.push("\n");
      i++;
      out.push(cur);
      cur = [];
    } else if (LINE_BREAKS.has(c)) {
      out.push(cur);
      cur = [];
    }
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/** 旧 `_split_content`。長さは Python と同じくコードポイント数で数える（絵文字 1 つ = 1）。 */
export function splitContent(content: string | null, limit = DISCORD_SAFE_CHUNK_LIMIT): string[] {
  if (content === null) return [""];
  const s = Array.from(content);
  if (s.length <= limit) return [content];
  const chunks: string[][] = [];
  let buf: string[] = [];
  for (const line of splitLinesKeepEnds(s)) {
    if (line.length > limit) {
      if (buf.length > 0) {
        chunks.push(buf);
        buf = [];
      }
      for (let start = 0; start < line.length; start += limit) chunks.push(line.slice(start, start + limit));
      continue;
    }
    if (buf.length + line.length > limit) {
      if (buf.length > 0) chunks.push(buf);
      buf = line;
    } else {
      buf = [...buf, ...line];
    }
  }
  if (buf.length > 0) chunks.push(buf);
  const safe: string[] = [];
  for (const c of chunks) {
    if (c.length <= limit) safe.push(c.join(""));
    else for (let start = 0; start < c.length; start += limit) safe.push(c.slice(start, start + limit).join(""));
  }
  return safe;
}

/** Python の `float(x)`（文字列・数・真偽）。変換できなければ例外。 */
export function pyFloat(v: unknown): number {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return v;
  if (typeof v !== "string") throw new TypeError("float() argument must be a string or a real number");
  const t = v.trim();
  if (/^[+-]?(inf|infinity)$/i.test(t)) return t.startsWith("-") ? -Infinity : Infinity;
  if (/^[+-]?nan$/i.test(t)) return Number.NaN;
  const digits = "\\d(?:_?\\d)*";
  const re = new RegExp(`^[+-]?(?:${digits}(?:\\.(?:${digits})?)?|\\.${digits})(?:[eE][+-]?${digits})?$`);
  if (!re.test(t)) throw new Error(`could not convert string to float: '${v}'`);
  return Number(t.replaceAll("_", ""));
}

/** 旧 `_parse_retry_after_seconds`: 本文の retry_after → Retry-After → X-RateLimit-Reset-After → 既定 1.0。 */
export function parseRetryAfterSeconds(body: string | null, headers: Readonly<Record<string, string>>): number {
  try {
    const data: unknown = body === null ? null : JSON.parse(body);
    if (typeof data === "object" && data !== null && !Array.isArray(data) && Object.hasOwn(data, "retry_after")) {
      const raw = (data as Record<string, unknown>)["retry_after"];
      const v = pyFloat(raw === null || raw === undefined || raw === 0 || raw === "" || raw === false ? 0.0 : raw);
      if (v > 0) return v;
    }
  } catch {
    // 旧実装どおり無視する
  }
  for (const key of ["Retry-After", "X-RateLimit-Reset-After"]) {
    try {
      // requests の headers は大文字小文字を区別しない
      const name = Object.keys(headers).find((k) => k.toLowerCase() === key.toLowerCase());
      const h = name === undefined ? undefined : headers[name];
      if (h) {
        const v = pyFloat(h);
        if (v > 0) return v;
      }
    } catch {
      continue;
    }
  }
  return 1.0;
}

export interface TicketLike {
  readonly kumi?: string | null;
  readonly ev?: number;
}

/** 旧 `_deduplicate_tickets`: [BOX] の有無と前後の空白を無視して同じ組合せを 1 つに（EV が厳密に大きい方。順序は初出順）。 */
export function deduplicateTickets<T extends TicketLike>(tickets: readonly T[]): T[] {
  const seen = new Map<string, T>();
  for (const t of tickets) {
    const key = (t.kumi ?? "").replaceAll("[BOX]", "").trim();
    const prev = seen.get(key);
    if (prev === undefined || (t.ev ?? 0.0) > (prev.ev ?? 0.0)) seen.set(key, t);
  }
  return [...seen.values()];
}

/** 通知に載せる買い目の上限（賭式ごと。NoticeTickets.MAX_DISPLAYED）。 */
export const MAX_DISPLAYED_TICKETS = 6;

/** 通知に載せる買い目（重複除去 → EV 降順 → 上位 6 点）。成績集計も同じ選び方にそろえる（NoticeTickets.displayed）。 */
export function displayedTickets<T extends TicketLike>(tickets: readonly T[]): T[] {
  return deduplicateTickets(tickets)
    .sort((a, b) => (b.ev ?? 0) - (a.ev ?? 0))
    .slice(0, MAX_DISPLAYED_TICKETS);
}
