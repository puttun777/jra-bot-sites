/**
 * 旧 jra-bot（Python）の SQLite → 取込の封筒（正規化 JSON）への変換。**本人の PC で実行する**（旧 DB は JV-Link 由来の実データ。Git に入れない）。
 * 移植元: jra-bot-web@7bcf1c4 legacy-import/Transform.kt・Convert.kt の規則（race_id の検査・naive な時刻は Asia/Tokyo・
 * 発走時刻の 00:00/範囲外は不明・組み合わせキーの正規化）。保存は Sites 版の取込（ingestBatch）を通すので、検査・冪等・保留は同じ。
 *
 * 変換するもの: races → NRA、odds_snapshots(win) → NOW、combo_odds_snapshots(wide/sanrenpuku) → NOD/NOS、results → NRS、payouts → NHR。
 * 変換しないもの（docs/MIGRATION.md §5）: signals・bets・race_evaluations（旧の判定。Sites で同じオッズから再判定できる）、
 * horses・race_horses・horse_past_runs（ML の特徴量。ML の移植まで保留）、results.payout（単位の疑義: web JVLINK_DESIGN §1.4）。
 */
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { jstDate, parseRaceId } from "../domain/race.js";

export interface LegacyRecord {
  readonly id: "NRA" | "NOW" | "NOD" | "NOS" | "NRS" | "NHR";
  readonly data: Record<string, unknown>;
}
export interface LegacyEnvelope {
  readonly batchId: string;
  readonly source: string;
  readonly observedAt: string;
  readonly records: LegacyRecord[];
}
export interface LegacyReport {
  readonly envelopes: number;
  readonly records: Record<string, number>;
  /** 変換できず除外した行（理由ごとの件数。黙って落とさない）。 */
  readonly rejected: Record<string, number>;
}

const MAX_RECORDS = 200;

/**
 * 旧の時刻 → UTC の ISO（web legacy-import Convert.time と同じ規則）:
 * `T` 区切りの naive（`datetime.now().isoformat()` = PC の時刻 = JST）は Asia/Tokyo、空白区切り（SQLite の CURRENT_TIMESTAMP）は UTC、時差付きはその時差。
 * 読めなければ null。
 */
export function legacyInstant(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const t = s.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})([T ])(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?(Z|[+-]\d{2}:\d{2})?$/.exec(t);
  if (m === null) return null;
  const [, y, mo, d, sep, h, mi, sec, frac, zone] = m;
  if (zone !== undefined) {
    const v = Date.parse(t.replace(" ", "T"));
    return Number.isNaN(v) ? null : new Date(v).toISOString();
  }
  const offsetHours = sep === "T" ? 9 : 0;
  const ms = Math.floor(Number(`0.${frac ?? "0"}`) * 1000);
  const utc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h) - offsetHours, Number(mi), Number(sec ?? "0"), ms);
  const local = new Date(utc + offsetHours * 3_600_000);
  if (local.getUTCDate() !== Number(d) || local.getUTCMonth() !== Number(mo) - 1 || Number(h) > 23 || Number(mi) > 59 || Number(sec ?? "0") > 59) return null;
  return new Date(utc).toISOString();
}

/** 旧の post_time（"HH:MM"。分 ≥ 60 の繰上げ表記を含む: 旧 parse_post_time）→ "HHMM"。00:00・範囲外・形式外は null（不明）。 */
export function legacyPostTime(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(s.trim());
  if (m === null) return null;
  let h = Number(m[1]);
  let mi = Number(m[2]);
  if (mi >= 60) {
    h += Math.floor(mi / 60);
    mi %= 60;
  }
  if (h >= 24 || (h === 0 && mi === 0)) return null;
  return `${String(h).padStart(2, "0")}${String(mi).padStart(2, "0")}`;
}

/** 組み合わせキー（"2-7" / "[BOX]7-2" / "07"）→ 0 埋めの昇順。不正は null。 */
export function legacyComboKey(market: "win" | "wide" | "sanrenpuku", s: unknown): string | null {
  if (typeof s !== "string" && typeof s !== "number") return null;
  const nums = String(s)
    .replace("[BOX]", "")
    .split("-")
    .map((x) => x.trim())
    .filter((x) => x !== "")
    .map(Number);
  const n = market === "win" ? 1 : market === "wide" ? 2 : 3;
  if (nums.length !== n || nums.some((x) => !Number.isInteger(x) || x < 1 || x > 99) || new Set(nums).size !== n) return null;
  return [...nums]
    .sort((a, b) => a - b)
    .map((x) => String(x).padStart(2, "0"))
    .join("-");
}

function canonMarket(s: unknown): "win" | "wide" | "sanrenpuku" | null {
  const t = (typeof s === "string" ? s : "").trim().toLowerCase();
  if (t === "win" || t === "単勝") return "win";
  if (t === "wide" || t === "ワイド") return "wide";
  if (t === "sanrenpuku" || t === "三連複") return "sanrenpuku";
  return null;
}

/** 内容から決まる UUID（同じ旧 DB から何度作っても同じ batchId → 再送しても二重に入らない）。 */
export function stableUuid(seed: string): string {
  const h = createHash("sha256").update(seed).digest("hex");
  const variant = ((parseInt(h.charAt(16), 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function hasTable(db: DatabaseSync, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}
function hasColumn(db: DatabaseSync, table: string, col: string): boolean {
  return db
    .prepare(`PRAGMA table_info("${table.replaceAll('"', "")}")`)
    .all()
    .some((r) => r["name"] === col);
}
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "bigint" ? Number(v) : null);

/** 旧 DB を読み取り専用で開いて封筒を作る。from/to（YYYY-MM-DD）で期間を絞れる。 */
export function convertLegacy(path: string, opts: { from?: string; to?: string } = {}): { envelopes: LegacyEnvelope[]; report: LegacyReport } {
  const db = new DatabaseSync(path, { readOnly: true });
  const rejected: Record<string, number> = {};
  const counts: Record<string, number> = {};
  const reject = (why: string): void => {
    rejected[why] = (rejected[why] ?? 0) + 1;
  };
  const inRange = (raceId: string): boolean => {
    const d = `${raceId.slice(0, 4)}-${raceId.slice(4, 6)}-${raceId.slice(6, 8)}`;
    return (opts.from === undefined || d >= opts.from) && (opts.to === undefined || d <= opts.to);
  };
  // 観測時刻ごとにレコードを集める（封筒は 1 つの観測時刻を持つ）
  const byTime = new Map<string, LegacyRecord[]>();
  const push = (at: string, r: LegacyRecord): void => {
    byTime.set(at, [...(byTime.get(at) ?? []), r]);
    counts[r.id] = (counts[r.id] ?? 0) + 1;
  };
  const known = new Set<string>();

  // races → NRA（kubun 2 = 発走時刻あり、1 = 不明。作成日はレース日の前日〈出馬表の発表〉ではなく、旧の created_at の日付。無ければレース日）
  if (hasTable(db, "races")) {
    for (const r of db.prepare("SELECT race_id, date, race_no, post_time, name, created_at FROM races ORDER BY race_id").all()) {
      const id = typeof r["race_id"] === "string" ? parseRaceId(r["race_id"]) : null;
      if (id === null) {
        reject("races.race_id");
        continue;
      }
      if (!inRange(id.value)) continue;
      const date = String(r["date"] ?? "").replaceAll("-", "");
      if (date !== id.value.slice(0, 8)) {
        reject("races.date_mismatch");
        continue;
      }
      if (num(r["race_no"]) !== id.raceNo) {
        reject("races.race_no_mismatch");
        continue;
      }
      const post = legacyPostTime(r["post_time"]);
      const created = legacyInstant(r["created_at"]);
      const createdJst = created === null ? null : jstDate(new Date(created));
      const createdOn = (createdJst !== null && createdJst <= id.date ? createdJst : id.date).replaceAll("-", "");
      known.add(id.value);
      push(created ?? `${id.date}T00:00:00.000Z`, {
        id: "NRA",
        data: { raceId: id.value, kubun: post === null ? "1" : "2", createdOn, postTime: post, raceName: typeof r["name"] === "string" ? r["name"].slice(0, 100) : null, kai: null, nichime: null },
      });
    }
  }

  // odds_snapshots(win) → NOW（同じ時刻・同じレースを 1 レコードに）
  if (hasTable(db, "odds_snapshots")) {
    const groups = new Map<string, { at: string; raceId: string; entries: { umaban: number; odds: number; pop: number | null }[] }>();
    for (const r of db.prepare("SELECT race_id, ts, market, umaban, odds, popularity FROM odds_snapshots ORDER BY race_id, ts, umaban").all()) {
      const raceId = String(r["race_id"]);
      if (!known.has(raceId) && parseRaceId(raceId) === null) {
        reject("odds.race_id");
        continue;
      }
      if (!inRange(raceId)) continue;
      if (canonMarket(r["market"] ?? "win") !== "win") {
        reject("odds.market");
        continue;
      }
      const at = legacyInstant(r["ts"]);
      const u = num(r["umaban"]);
      const o = num(r["odds"]);
      if (at === null || u === null || o === null || !(o > 0) || u < 1 || u > 99) {
        reject("odds.value");
        continue;
      }
      const key = `${raceId}|${at}`;
      const g = groups.get(key) ?? { at, raceId, entries: [] };
      const pop = num(r["popularity"]);
      if (!g.entries.some((e) => e.umaban === u)) g.entries.push({ umaban: u, odds: o, pop: pop !== null && pop >= 0 ? pop : null });
      groups.set(key, g);
    }
    for (const g of groups.values()) push(g.at, { id: "NOW", data: { raceId: g.raceId, entries: g.entries } });
  }

  // combo_odds_snapshots → NOD / NOS（旧は 1 つのオッズ。ワイドは下限として扱い、上限は null）
  if (hasTable(db, "combo_odds_snapshots")) {
    const groups = new Map<string, { at: string; raceId: string; market: "wide" | "sanrenpuku"; entries: Record<string, unknown>[] }>();
    for (const r of db.prepare("SELECT race_id, collected_at, market, combo_key, odds, popularity FROM combo_odds_snapshots ORDER BY race_id, collected_at").all()) {
      const raceId = String(r["race_id"]);
      if (parseRaceId(raceId) === null) {
        reject("combo.race_id");
        continue;
      }
      if (!inRange(raceId)) continue;
      const m = canonMarket(r["market"]);
      const at = legacyInstant(r["collected_at"]);
      const o = num(r["odds"]);
      if ((m !== "wide" && m !== "sanrenpuku") || at === null || o === null || !(o > 0)) {
        reject("combo.value");
        continue;
      }
      const key = legacyComboKey(m, r["combo_key"]);
      if (key === null) {
        reject("combo.combo_key");
        continue;
      }
      const nums = key.split("-").map(Number);
      const gk = `${raceId}|${m}|${at}`;
      const g = groups.get(gk) ?? { at, raceId, market: m, entries: [] };
      const pop = num(r["popularity"]);
      g.entries.push(m === "wide" ? { a: nums[0], b: nums[1], low: o, high: null, pop: pop !== null && pop >= 0 ? pop : null } : { a: nums[0], b: nums[1], c: nums[2], odds: o, pop: pop !== null && pop >= 0 ? pop : null });
      groups.set(gk, g);
    }
    for (const g of groups.values()) push(g.at, { id: g.market === "wide" ? "NOD" : "NOS", data: { raceId: g.raceId, entries: g.entries } });
  }

  // results → NRS（着順 0・NULL は着順なし）。観測時刻は旧の created_at（無ければ発走日の 23:59 JST）
  if (hasTable(db, "results")) {
    const groups = new Map<string, { at: string; entries: { umaban: number; finish: number | null }[] }>();
    for (const r of db.prepare("SELECT race_id, umaban, finish, created_at FROM results ORDER BY race_id, umaban").all()) {
      const raceId = String(r["race_id"]);
      const id = parseRaceId(raceId);
      const u = num(r["umaban"]);
      if (id === null || u === null || u < 1 || u > 99) {
        reject("results.value");
        continue;
      }
      if (!inRange(raceId)) continue;
      const f = num(r["finish"]);
      const g = groups.get(raceId) ?? { at: legacyInstant(r["created_at"]) ?? `${id.date}T14:59:00.000Z`, entries: [] };
      g.entries.push({ umaban: u, finish: f !== null && f >= 1 && f <= 99 ? f : null });
      groups.set(raceId, g);
    }
    for (const [raceId, g] of groups) push(g.at, { id: "NRS", data: { raceId, entries: g.entries } });
  }

  // payouts → NHR（100 円あたり。旧の is_provisional があれば使う）
  if (hasTable(db, "payouts")) {
    const prov = hasColumn(db, "payouts", "is_provisional");
    const groups = new Map<string, { at: string; raceId: string; market: string; provisional: boolean; entries: { key: string; payout: number }[] }>();
    for (const r of db.prepare(`SELECT race_id, market, key, payout, created_at${prov ? ", is_provisional" : ""} FROM payouts ORDER BY race_id, market, key`).all()) {
      const raceId = String(r["race_id"]);
      const id = parseRaceId(raceId);
      const m = canonMarket(r["market"]);
      const p = num(r["payout"]);
      if (id === null || m === null || p === null || !(p > 0)) {
        reject("payouts.value");
        continue;
      }
      if (!inRange(raceId)) continue;
      const key = legacyComboKey(m, r["key"]);
      if (key === null) {
        reject("payouts.key");
        continue;
      }
      const provisional = prov && num(r["is_provisional"]) === 1;
      const gk = `${raceId}|${m}|${provisional ? 1 : 0}`;
      const g = groups.get(gk) ?? { at: legacyInstant(r["created_at"]) ?? `${id.date}T14:59:00.000Z`, raceId, market: m, provisional, entries: [] };
      if (!g.entries.some((e) => e.key === key)) g.entries.push({ key, payout: p });
      groups.set(gk, g);
    }
    for (const g of groups.values()) push(g.at, { id: "NHR", data: { raceId: g.raceId, market: g.market, provisional: g.provisional, entries: g.entries } });
  }
  db.close();

  // 封筒: 観測時刻の昇順。レース（NRA）を含む時刻が先に来るので、オッズ等の保留は後で再適用される
  const envelopes: LegacyEnvelope[] = [];
  for (const at of [...byTime.keys()].sort()) {
    const recs = byTime.get(at) ?? [];
    for (let i = 0; i < recs.length; i += MAX_RECORDS) {
      const chunk = recs.slice(i, i + MAX_RECORDS);
      envelopes.push({ batchId: stableUuid(`legacy|${at}|${i}|${JSON.stringify(chunk)}`), source: "legacy-import", observedAt: at, records: chunk });
    }
  }
  return { envelopes, report: { envelopes: envelopes.length, records: counts, rejected } };
}
