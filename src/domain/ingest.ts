/**
 * 取込の観測・正規化 JSON レコードのパーサ・観測の適用（jra-bot-web@7bcf1c4 の移植）:
 * - domain/ingest/Observations.kt（観測の型）
 * - ingest/agent/NormalizedJsonRecordParser.kt（`NYS`/`NRA`/`NTC`/`NOW`/`NOD`/`NOS`/`NRS`/`NHR`）
 * - domain/ingest/ObservationApplier.kt（取込境界の検査・保留・隔離）
 *
 * Sites 版での変更（docs/MIGRATION.md §4）:
 * - web では「合成データの検証用・本番無効」だった正規化 JSON を、JV-Link を使わない Sites 版の**唯一の取込形式**として有効にする
 *   （書き手は ChatGPT の MCP ツール・CSV/JSON の手動取込。どちらも同じ検査を通る）。
 * - 追加のレコード ID は持たない（出馬表・馬体重などは既存の業務ロジックが使っていないため。必要になったら同じ形で足す）。
 */
import {
  KaiNichimeChangedError,
  kubunOf,
  type ApplyResult,
  type RaceDataKubun,
  type RaceDayRepository,
  type RaceDayStatus,
  type RaceDayUpdater,
  type RaceScheduleUpdater,
} from "./calendar.js";
import { ComboKeys, isMarket, isVenue, parseRaceId, type Market, type RaceId } from "./race.js";

// ---- 観測 ----
export interface OddsEntryObs {
  readonly umaban: number;
  readonly odds: number;
  readonly popularity: number | null;
}
export type Observation =
  | { readonly kind: "ScheduleDay"; readonly date: string; readonly venue: string; readonly kai: number; readonly nichime: number; readonly status: RaceDayStatus; readonly replacedByDate: string | null }
  | {
      readonly kind: "Race";
      readonly raceId: RaceId;
      readonly kubun: RaceDataKubun;
      readonly createdOn: string;
      readonly postTime: string | null;
      readonly raceName: string | null;
      readonly kai: number | null;
      readonly nichime: number | null;
    }
  | { readonly kind: "TimeChange"; readonly raceId: RaceId; readonly postAt: string; readonly revoked: boolean; readonly snapshotKey: string }
  | { readonly kind: "WinOdds"; readonly raceId: RaceId; readonly entries: readonly OddsEntryObs[] }
  | { readonly kind: "WideOdds"; readonly raceId: RaceId; readonly entries: readonly { a: number; b: number; low: number; high: number | null; popularity: number | null }[] }
  | { readonly kind: "SanrenpukuOdds"; readonly raceId: RaceId; readonly entries: readonly { a: number; b: number; c: number; odds: number; popularity: number | null }[] }
  | { readonly kind: "Result"; readonly raceId: RaceId; readonly entries: readonly { umaban: number; finish: number | null }[] }
  | { readonly kind: "Payout"; readonly raceId: RaceId; readonly market: Market; readonly rows: readonly { comboKey: string; payout: number }[]; readonly provisional: boolean };

export type ParseOutcome =
  | { readonly kind: "Parsed"; readonly observations: readonly Observation[] }
  | { readonly kind: "Unsupported"; readonly reason: string }
  | { readonly kind: "Malformed"; readonly reason: string };

export const NORMALIZED_RECORD_IDS = ["NYS", "NRA", "NTC", "NOW", "NOD", "NOS", "NRS", "NHR"] as const;
export type NormalizedRecordId = (typeof NORMALIZED_RECORD_IDS)[number];
export function isNormalizedRecordId(v: string): v is NormalizedRecordId {
  return (NORMALIZED_RECORD_IDS as readonly string[]).includes(v);
}
const YSCH_STATUSES: readonly RaceDayStatus[] = ["PLANNED", "CANCELLED", "POSTPONED"];
export const MAX_ENTRIES = 5000;

class BadRecord extends Error {}
type Obj = Record<string, unknown>;
function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function bad(what: string): never {
  throw new BadRecord(what);
}
function keys(o: Obj, ...expected: string[]): void {
  const k = Object.keys(o);
  if (k.length !== expected.length || !expected.every((e) => Object.hasOwn(o, e))) bad("KEYS");
}
function str(o: Obj, k: string): string {
  const v = o[k];
  return typeof v === "string" ? v : bad(k.toUpperCase());
}
function optInt(o: Obj, k: string): number | null {
  const v = o[k];
  if (v === null || v === undefined) return null;
  if (typeof v !== "number" || !Number.isInteger(v) || v < -2147483648 || v > 2147483647) bad(k.toUpperCase());
  return v;
}
function int(o: Obj, k: string): number {
  return optInt(o, k) ?? bad(k.toUpperCase());
}
function optDbl(o: Obj, k: string): number | null {
  const v = o[k];
  if (v === null || v === undefined) return null;
  if (typeof v !== "number" || !Number.isFinite(v)) bad(k.toUpperCase());
  return v;
}
function dbl(o: Obj, k: string): number {
  return optDbl(o, k) ?? bad(k.toUpperCase());
}
function optDate(o: Obj, k: string): string | null {
  const v = o[k];
  if (v === null || v === undefined) return null;
  if (typeof v !== "string" || !/^\d{8}$/.test(v)) bad(k.toUpperCase());
  const d = `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
  if (parseRaceId(`${v}0101`) === null) bad(k.toUpperCase());
  return d;
}
function date(o: Obj, k: string): string {
  return optDate(o, k) ?? bad(k.toUpperCase());
}
function raceId(o: Obj): RaceId {
  return parseRaceId(str(o, "raceId")) ?? bad("RACE_ID");
}
function list(o: Obj): Obj[] {
  const l = o["entries"];
  if (!Array.isArray(l) || l.length === 0 || l.length > MAX_ENTRIES) bad("ENTRIES");
  return l.map((e) => (isObj(e) ? e : bad("ENTRY")));
}
function optStrOrNull(o: Obj, k: string): string | null {
  const v = o[k];
  if (v === null || v === undefined) return null;
  return typeof v === "string" ? v : bad(k.toUpperCase());
}

function build(id: NormalizedRecordId, o: Obj): Observation {
  switch (id) {
    case "NYS": {
      keys(o, "date", "venue", "kai", "nichime", "status", "replacedBy");
      const s = str(o, "status");
      const status = YSCH_STATUSES.find((x) => x === s) ?? bad("STATUS");
      const venue = str(o, "venue");
      if (!isVenue(venue)) bad("VENUE");
      return { kind: "ScheduleDay", date: date(o, "date"), venue, kai: int(o, "kai"), nichime: int(o, "nichime"), status, replacedByDate: optDate(o, "replacedBy") };
    }
    case "NRA": {
      keys(o, "raceId", "kubun", "createdOn", "postTime", "raceName", "kai", "nichime");
      const k = str(o, "kubun");
      const kubun = (k.length === 1 ? kubunOf(k) : null) ?? bad("KUBUN");
      const t = optStrOrNull(o, "postTime");
      let postTime: string | null = null;
      if (t !== null) {
        if (!/^\d{4}$/.test(t)) bad("POST_TIME");
        const h = Number(t.slice(0, 2));
        const m = Number(t.slice(2));
        if (h > 23 || m > 59) bad("POST_TIME");
        postTime = `${t.slice(0, 2)}:${t.slice(2)}`;
      }
      return { kind: "Race", raceId: raceId(o), kubun, createdOn: date(o, "createdOn"), postTime, raceName: optStrOrNull(o, "raceName"), kai: optInt(o, "kai"), nichime: optInt(o, "nichime") };
    }
    case "NTC": {
      keys(o, "raceId", "postAt", "revoked", "snapshotKey");
      const at = str(o, "postAt");
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/.test(at) || Number.isNaN(Date.parse(at))) bad("POST_AT");
      const revoked = o["revoked"];
      if (typeof revoked !== "boolean") bad("REVOKED");
      const sk = str(o, "snapshotKey");
      if (sk.trim().length === 0) bad("SNAPSHOT_KEY");
      return { kind: "TimeChange", raceId: raceId(o), postAt: new Date(at).toISOString(), revoked, snapshotKey: sk };
    }
    case "NOW": {
      keys(o, "raceId", "entries");
      const entries = list(o).map((e) => {
        keys(e, "umaban", "odds", "pop");
        const umaban = int(e, "umaban");
        if (umaban < 1 || umaban > 99) bad("UMABAN");
        const odds = dbl(e, "odds");
        if (!(odds > 0)) bad("ODDS");
        const pop = optInt(e, "pop");
        if (pop !== null && pop < 0) bad("POP");
        return { umaban, odds, popularity: pop };
      });
      if (new Set(entries.map((e) => e.umaban)).size !== entries.length) bad("DUPLICATE_UMABAN");
      return { kind: "WinOdds", raceId: raceId(o), entries };
    }
    case "NOD": {
      keys(o, "raceId", "entries");
      const entries = list(o).map((e) => {
        keys(e, "a", "b", "low", "high", "pop");
        return { a: int(e, "a"), b: int(e, "b"), low: dbl(e, "low"), high: optDbl(e, "high"), popularity: optInt(e, "pop") };
      });
      return { kind: "WideOdds", raceId: raceId(o), entries };
    }
    case "NOS": {
      keys(o, "raceId", "entries");
      const entries = list(o).map((e) => {
        keys(e, "a", "b", "c", "odds", "pop");
        return { a: int(e, "a"), b: int(e, "b"), c: int(e, "c"), odds: dbl(e, "odds"), popularity: optInt(e, "pop") };
      });
      return { kind: "SanrenpukuOdds", raceId: raceId(o), entries };
    }
    case "NRS": {
      keys(o, "raceId", "entries");
      const entries = list(o).map((e) => {
        keys(e, "umaban", "finish");
        return { umaban: int(e, "umaban"), finish: optInt(e, "finish") };
      });
      return { kind: "Result", raceId: raceId(o), entries };
    }
    case "NHR": {
      keys(o, "raceId", "market", "provisional", "entries");
      const m = str(o, "market");
      if (!isMarket(m)) bad("MARKET");
      const provisional = o["provisional"];
      if (typeof provisional !== "boolean") bad("PROVISIONAL");
      const rows = list(o).map((e) => {
        keys(e, "key", "payout");
        return { comboKey: str(e, "key"), payout: dbl(e, "payout") };
      });
      return { kind: "Payout", raceId: raceId(o), market: m, rows, provisional };
    }
  }
}

/** 正規化 JSON レコード 1 件の解析（例外を投げない）。 */
export function parseNormalizedRecord(recordId: string, payload: string): ParseOutcome {
  if (!isNormalizedRecordId(recordId)) return { kind: "Unsupported", reason: `NO_PARSER:${recordId}` };
  let tree: unknown;
  try {
    tree = JSON.parse(payload);
  } catch {
    return { kind: "Malformed", reason: "NORMALIZED_JSON_INVALID" };
  }
  if (!isObj(tree)) return { kind: "Malformed", reason: "NORMALIZED_NOT_OBJECT" };
  try {
    return { kind: "Parsed", observations: [build(recordId, tree)] };
  } catch (e) {
    if (e instanceof BadRecord) return { kind: "Malformed", reason: `NORMALIZED_${e.message}` };
    return { kind: "Malformed", reason: "PARSER_ERROR" };
  }
}

// ---- 適用 ----
export type UpsertOutcome = "INSERTED" | "UPDATED" | "UNCHANGED";

export interface IngestStores {
  readonly raceDays: RaceDayRepository;
  readonly dayUpdater: RaceDayUpdater;
  readonly scheduleUpdater: RaceScheduleUpdater;
  races: {
    exists(tenantId: number, raceId: string): Promise<boolean>;
    upsertMinimal(tenantId: number, raceId: RaceId, kai: number | null, nichime: number | null, postTime: string | null, name: string | null): Promise<void>;
  };
  odds: { upsertWin(tenantId: number, raceId: string, observedAt: string, entries: readonly OddsEntryObs[]): Promise<UpsertOutcome> };
  combos: {
    upsert(tenantId: number, raceId: string, market: "wide" | "sanrenpuku", collectedAt: string, rows: readonly ComboOddsRow[], source: string): Promise<UpsertOutcome>;
  };
  results: { upsertAll(tenantId: number, raceId: string, entries: readonly { umaban: number; finish: number | null }[]): Promise<UpsertOutcome> };
  payouts: { upsertAll(tenantId: number, raceId: string, market: Market, rows: readonly { comboKey: string; payout: number }[], provisional: boolean): Promise<UpsertOutcome> };
}

export interface ComboOddsRow {
  readonly comboKey: string;
  readonly odds: number;
  readonly oddsHigh: number | null;
  readonly popularity: number | null;
}

export interface ApplyPolicy {
  /** 0 < オッズ < 1 を隔離する（P-3・D-136 の推奨）。false は旧 Python と同じく弾かない。 */
  readonly quarantineBelowPar: boolean;
  /** ワイド・三連複の保存（web D-043 は既定で保存しない。Sites 版は判定に実オッズが要るので既定で保存する: D-S06）。 */
  readonly storeComboOdds: boolean;
}
export const DEFAULT_APPLY_POLICY: ApplyPolicy = { quarantineBelowPar: true, storeComboOdds: true };

export type ApplyOutcome =
  | { readonly kind: "Applied" }
  | { readonly kind: "NoChange" }
  | { readonly kind: "Rejected"; readonly reason: string }
  | { readonly kind: "Quarantined"; readonly reason: string }
  | { readonly kind: "Deferred"; readonly reason: string };

export const REASON_RACE_NOT_FOUND = "RACE_NOT_FOUND";
export function raceNotFoundReason(raceId: string): string {
  return `${REASON_RACE_NOT_FOUND}:${raceId}`;
}

export class IngestRetryableError extends Error {}

const BEYOND_PLANNED: readonly RaceDayStatus[] = ["UNCONFIRMED", "CONFIRMED", "RUNNING", "SETTLING", "COMPLETED", "INCOMPLETE"];

function mapResult<T>(r: ApplyResult<T>): ApplyOutcome {
  switch (r.kind) {
    case "Applied":
      return { kind: "Applied" };
    case "NoChange":
      return { kind: "NoChange" };
    case "Rejected":
      return { kind: "Rejected", reason: r.reason };
    case "Conflict":
      throw new IngestRetryableError("楽観ロックの競合が続いた");
  }
}
const upserted = (o: UpsertOutcome): ApplyOutcome => (o === "UNCHANGED" ? { kind: "NoChange" } : { kind: "Applied" });

function validPayoutKey(market: Market, key: string): boolean {
  const parts = key.split("-");
  if (!parts.every((p) => /^\d{2}$/.test(p))) return false;
  const nums = parts.map(Number);
  const expected = market === "win" ? 1 : market === "wide" ? 2 : 3;
  const sorted = [...nums].sort((a, b) => a - b);
  return nums.length === expected && nums.every((n) => n >= 1 && n <= 99) && nums.every((n, i) => n === sorted[i]) && new Set(nums).size === nums.length;
}

/** ObservationApplier の移植。 */
export class ObservationApplier {
  constructor(
    private readonly s: IngestStores,
    private readonly policy: ApplyPolicy = DEFAULT_APPLY_POLICY,
  ) {}

  async apply(tenantId: number, obs: Observation, ctx: { observedAt: string; batchId: string; dataspec: string }): Promise<ApplyOutcome> {
    switch (obs.kind) {
      case "ScheduleDay":
        return this.applyDay(tenantId, obs, ctx.observedAt);
      case "Race":
        return this.applyRace(tenantId, obs, ctx);
      case "TimeChange": {
        const r = obs.revoked
          ? await this.s.scheduleUpdater.revokeTimeChange(tenantId, obs.raceId, obs.postAt, ctx.observedAt, obs.snapshotKey, ctx.batchId)
          : await this.s.scheduleUpdater.applyTimeChange(tenantId, obs.raceId, obs.postAt, ctx.observedAt, obs.snapshotKey, ctx.batchId);
        return mapResult(r);
      }
      case "WinOdds": {
        if (this.belowPar(obs.entries.map((e) => e.odds))) return { kind: "Quarantined", reason: "ODDS_BELOW_PAR" };
        if (!(await this.s.races.exists(tenantId, obs.raceId.value))) return { kind: "Deferred", reason: raceNotFoundReason(obs.raceId.value) };
        return upserted(await this.s.odds.upsertWin(tenantId, obs.raceId.value, ctx.observedAt, obs.entries));
      }
      case "WideOdds": {
        const rows = new Map<string, ComboOddsRow>();
        for (const e of obs.entries) {
          const key = ComboKeys.wide(e.a, e.b);
          if (key === null) return { kind: "Quarantined", reason: "INVALID_COMBO_KEY" };
          if (this.belowPar([e.low, ...(e.high === null ? [] : [e.high])])) return { kind: "Quarantined", reason: "ODDS_BELOW_PAR" };
          if (!(e.low > 0) || (e.high !== null && !(e.high > 0))) return { kind: "Quarantined", reason: "INVALID_ODDS" };
          if (e.high !== null && e.high < e.low) return { kind: "Quarantined", reason: "INVALID_ODDS_RANGE" };
          const row: ComboOddsRow = { comboKey: key, odds: e.low, oddsHigh: e.high, popularity: e.popularity };
          const prev = rows.get(key);
          if (prev !== undefined && JSON.stringify(prev) !== JSON.stringify(row)) return { kind: "Quarantined", reason: "DUPLICATE_COMBO_KEY" };
          rows.set(key, row);
        }
        return this.storeCombos(tenantId, obs.raceId.value, "wide", [...rows.values()], ctx);
      }
      case "SanrenpukuOdds": {
        const rows = new Map<string, ComboOddsRow>();
        for (const e of obs.entries) {
          const key = ComboKeys.sanrenpuku(e.a, e.b, e.c);
          if (key === null) return { kind: "Quarantined", reason: "INVALID_COMBO_KEY" };
          if (this.belowPar([e.odds])) return { kind: "Quarantined", reason: "ODDS_BELOW_PAR" };
          if (!(e.odds > 0)) return { kind: "Quarantined", reason: "INVALID_ODDS" };
          const row: ComboOddsRow = { comboKey: key, odds: e.odds, oddsHigh: null, popularity: e.popularity };
          const prev = rows.get(key);
          if (prev !== undefined && JSON.stringify(prev) !== JSON.stringify(row)) return { kind: "Quarantined", reason: "DUPLICATE_COMBO_KEY" };
          rows.set(key, row);
        }
        return this.storeCombos(tenantId, obs.raceId.value, "sanrenpuku", [...rows.values()], ctx);
      }
      case "Result": {
        if (obs.entries.length === 0) return { kind: "Quarantined", reason: "EMPTY_RESULT" };
        if (obs.entries.some((e) => e.umaban < 1 || e.umaban > 99)) return { kind: "Quarantined", reason: "INVALID_UMABAN" };
        if (new Set(obs.entries.map((e) => e.umaban)).size !== obs.entries.length) return { kind: "Quarantined", reason: "DUPLICATE_UMABAN" };
        if (obs.entries.some((e) => e.finish !== null && (e.finish < 1 || e.finish > 99))) return { kind: "Quarantined", reason: "INVALID_FINISH" };
        if (!(await this.s.races.exists(tenantId, obs.raceId.value))) return { kind: "Deferred", reason: raceNotFoundReason(obs.raceId.value) };
        return upserted(await this.s.results.upsertAll(tenantId, obs.raceId.value, obs.entries));
      }
      case "Payout": {
        if (obs.rows.length === 0) return { kind: "Quarantined", reason: "EMPTY_PAYOUT" };
        const seen = new Map<string, number>();
        for (const r of obs.rows) {
          if (!Number.isFinite(r.payout) || r.payout <= 0) return { kind: "Quarantined", reason: "INVALID_PAYOUT" };
          if (!validPayoutKey(obs.market, r.comboKey)) return { kind: "Quarantined", reason: "INVALID_COMBO_KEY" };
          const prev = seen.get(r.comboKey);
          if (prev !== undefined && prev !== r.payout) return { kind: "Quarantined", reason: "DUPLICATE_COMBO_KEY" };
          seen.set(r.comboKey, r.payout);
        }
        if (!(await this.s.races.exists(tenantId, obs.raceId.value))) return { kind: "Deferred", reason: raceNotFoundReason(obs.raceId.value) };
        const rows = [...seen].map(([comboKey, payout]) => ({ comboKey, payout })).sort((a, b) => (a.comboKey < b.comboKey ? -1 : 1));
        return upserted(await this.s.payouts.upsertAll(tenantId, obs.raceId.value, obs.market, rows, obs.provisional));
      }
    }
  }

  private async applyDay(tenantId: number, o: Extract<Observation, { kind: "ScheduleDay" }>, observedAt: string): Promise<ApplyOutcome> {
    const existing = await this.s.raceDays.find(tenantId, o.date, o.venue);
    if (o.status === "PLANNED" && existing !== null && BEYOND_PLANNED.includes(existing.status)) {
      await this.s.dayUpdater.confirm(tenantId, o.date, o.venue, observedAt);
      return { kind: "NoChange" };
    }
    try {
      return mapResult(
        await this.s.dayUpdater.apply({
          tenantId,
          date: o.date,
          venue: o.venue,
          kai: o.kai,
          nichime: o.nichime,
          target: o.status,
          replacedByDate: o.replacedByDate,
          observedAt,
          source: "YSCH",
          dedupGroup: `${o.status}:${o.replacedByDate ?? "-"}`,
        }),
      );
    } catch (e) {
      if (e instanceof KaiNichimeChangedError) return { kind: "Rejected", reason: "KAI_NICHIME_CHANGED" };
      throw e;
    }
  }

  private async applyRace(tenantId: number, o: Extract<Observation, { kind: "Race" }>, ctx: { observedAt: string; batchId: string }): Promise<ApplyOutcome> {
    const result = await this.s.scheduleUpdater.apply({
      tenantId,
      raceId: o.raceId,
      kubun: o.kubun,
      createdOn: o.createdOn,
      postTime: o.postTime,
      raceName: o.raceName,
      kai: o.kai,
      nichime: o.nichime,
      observedAt: ctx.observedAt,
      source: "RACE",
      batchId: ctx.batchId,
    });
    const deleted = o.kubun.name === "DELETED";
    const usable = result.kind === "Applied" || (result.kind === "NoChange" && !deleted);
    if (usable && !deleted && o.kubun.name !== "CANCELLED" && !(await this.s.races.exists(tenantId, o.raceId.value))) {
      const post = o.postTime !== null && o.postTime !== "00:00" && o.kubun.name === "CARD" ? o.postTime : null;
      await this.s.races.upsertMinimal(tenantId, o.raceId, o.kai, o.nichime, post, o.raceName?.slice(0, 100) ?? null);
    }
    if (usable && (o.kubun.name === "ANNOUNCEMENT" || o.kubun.name === "CARD") && o.kai !== null && o.nichime !== null) {
      try {
        await this.s.dayUpdater.apply({
          tenantId,
          date: o.raceId.date,
          venue: o.raceId.venue,
          kai: o.kai,
          nichime: o.nichime,
          target: "CONFIRMED",
          replacedByDate: null,
          observedAt: ctx.observedAt,
          source: "RACE",
          dedupGroup: "CONFIRMED:-",
        });
      } catch (e) {
        if (!(e instanceof KaiNichimeChangedError)) throw e;
      }
    }
    return mapResult(result);
  }

  private async storeCombos(tenantId: number, raceId: string, market: "wide" | "sanrenpuku", rows: ComboOddsRow[], ctx: { observedAt: string; dataspec: string }): Promise<ApplyOutcome> {
    if (rows.length === 0) return { kind: "Quarantined", reason: "EMPTY_SNAPSHOT" };
    if (!this.policy.storeComboOdds) return { kind: "Rejected", reason: "COMBO_ODDS_STORAGE_DISABLED" };
    if (!(await this.s.races.exists(tenantId, raceId))) return { kind: "Deferred", reason: raceNotFoundReason(raceId) };
    return upserted(await this.s.combos.upsert(tenantId, raceId, market, ctx.observedAt, rows, ctx.dataspec));
  }

  private belowPar(values: readonly number[]): boolean {
    return this.policy.quarantineBelowPar && values.some((v) => v > 0 && v < 1);
  }
}
