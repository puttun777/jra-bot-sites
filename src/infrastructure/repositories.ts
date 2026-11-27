/**
 * SQL のリポジトリ（D1 / node:sqlite 共通。jra-bot-web persistence の Doma DAO の役割を SQL で直接書いたもの）。
 * - 楽観ロックの「更新 + 履歴の追記」は batch で原子的に行う（D1 は BEGIN/COMMIT を使えない）。履歴の追記は
 *   「更新後の version の行がある」ことを条件にした INSERT … SELECT … WHERE EXISTS にして、更新が 0 行なら履歴も入らないようにする。
 * - 時刻は toISOString() の固定長（辞書順 = 時刻順）で保存する。
 */
import type {
  CalendarOverride,
  ChangeResult,
  RaceDay,
  RaceDayRepository,
  RaceDayStatus,
  RaceSchedule,
  RaceScheduleRepository,
  RaceScheduleStatus,
  ScheduleEvent,
  ScheduleEventReader,
  ScheduleEventSource,
  ScheduleEventType,
} from "../domain/calendar.js";
import type { ComboOddsRow, OddsEntryObs, UpsertOutcome } from "../domain/ingest.js";
import type { ResultEntry, StoredPayout } from "../domain/performance.js";
import { parseRaceId, type Market, type RaceId } from "../domain/race.js";
import { int, optInt, optReal, optStr, real, str, type SqlDatabase, type SqlStatement, type SqlValue } from "./db/sql.js";

type Row = Record<string, unknown>;

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Error && /UNIQUE constraint failed|PRIMARY KEY/i.test(e.message);
}

// ---- 履歴 ----
const EVENT_COLS = "tenant_id, race_id, race_date, event_type, old_value, new_value, source, observed_at, received_at, batch_id, dedup_hash";

function eventValues(e: ScheduleEvent): SqlValue[] {
  return [e.tenantId, e.raceId, e.raceDate, e.type, e.oldValue, e.newValue, e.source, e.observedAt, e.receivedAt, e.batchId, e.dedupHash];
}

function toEvent(r: Row): ScheduleEvent {
  return {
    tenantId: int(r, "tenant_id"),
    id: int(r, "id"),
    raceId: optStr(r, "race_id"),
    raceDate: str(r, "race_date"),
    type: str(r, "event_type") as ScheduleEventType,
    oldValue: optStr(r, "old_value"),
    newValue: optStr(r, "new_value"),
    source: str(r, "source") as ScheduleEventSource,
    observedAt: str(r, "observed_at"),
    receivedAt: str(r, "received_at"),
    batchId: optStr(r, "batch_id"),
    dedupHash: str(r, "dedup_hash"),
  };
}

export class ScheduleEventRepo implements ScheduleEventReader {
  constructor(private readonly db: SqlDatabase) {}

  async exists(tenantId: number, dedupHash: string): Promise<boolean> {
    return (await this.db.prepare("SELECT 1 AS x FROM race_schedule_event WHERE tenant_id = ? AND dedup_hash = ?").bind(tenantId, dedupHash).first()) !== null;
  }

  async findByHash(tenantId: number, dedupHash: string): Promise<ScheduleEvent | null> {
    const r = await this.db.prepare("SELECT * FROM race_schedule_event WHERE tenant_id = ? AND dedup_hash = ?").bind(tenantId, dedupHash).first<Row>();
    return r === null ? null : toEvent(r);
  }

  async eventsOfRace(tenantId: number, raceId: string): Promise<ScheduleEvent[]> {
    const r = await this.db.prepare("SELECT * FROM race_schedule_event WHERE tenant_id = ? AND race_id = ? ORDER BY id").bind(tenantId, raceId).all<Row>();
    return r.results.map(toEvent);
  }

  async eventsOfDate(tenantId: number, date: string): Promise<ScheduleEvent[]> {
    const r = await this.db.prepare("SELECT * FROM race_schedule_event WHERE tenant_id = ? AND race_date = ? ORDER BY id").bind(tenantId, date).all<Row>();
    return r.results.map(toEvent);
  }

  insertStatement(e: ScheduleEvent): SqlStatement {
    return this.db.prepare(`INSERT INTO race_schedule_event (${EVENT_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(...eventValues(e));
  }

  /** 条件付きの履歴の追記（cond の SQL が真のときだけ）。 */
  conditionalInsert(e: ScheduleEvent, cond: string, condValues: SqlValue[]): SqlStatement {
    return this.db
      .prepare(`INSERT INTO race_schedule_event (${EVENT_COLS}) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (${cond})`)
      .bind(...eventValues(e), ...condValues);
  }
}

// ---- 開催日 ----
function toDay(r: Row): RaceDay {
  return {
    tenantId: int(r, "tenant_id"),
    raceDate: str(r, "race_date"),
    venue: str(r, "venue_code"),
    kai: int(r, "kai"),
    nichime: int(r, "nichime"),
    status: str(r, "status") as RaceDayStatus,
    replacedByDate: optStr(r, "replaced_by_date"),
    firstSeenAt: str(r, "first_seen_at"),
    lastConfirmedAt: optStr(r, "last_confirmed_at"),
    version: int(r, "version"),
  };
}

export class RaceDayRepo implements RaceDayRepository {
  constructor(
    private readonly db: SqlDatabase,
    private readonly events: ScheduleEventRepo,
  ) {}

  async find(tenantId: number, date: string, venue: string): Promise<RaceDay | null> {
    const r = await this.db.prepare("SELECT * FROM race_day WHERE tenant_id = ? AND race_date = ? AND venue_code = ?").bind(tenantId, date, venue).first<Row>();
    return r === null ? null : toDay(r);
  }

  async listByDate(tenantId: number, date: string): Promise<RaceDay[]> {
    const r = await this.db.prepare("SELECT * FROM race_day WHERE tenant_id = ? AND race_date = ? ORDER BY venue_code").bind(tenantId, date).all<Row>();
    return r.results.map(toDay);
  }

  async insertIfAbsent(day: RaceDay, event: ScheduleEvent): Promise<ChangeResult<RaceDay>> {
    if (await this.events.exists(day.tenantId, event.dedupHash)) return { kind: "Duplicate" };
    if ((await this.find(day.tenantId, day.raceDate, day.venue)) !== null) return { kind: "AlreadyExists" };
    try {
      await this.db.batch([
        this.db
          .prepare(
            "INSERT INTO race_day (tenant_id, race_date, venue_code, kai, nichime, status, replaced_by_date, first_seen_at, last_confirmed_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)",
          )
          .bind(day.tenantId, day.raceDate, day.venue, day.kai, day.nichime, day.status, day.replacedByDate, day.firstSeenAt, day.lastConfirmedAt),
        this.events.insertStatement(event),
      ]);
    } catch (e) {
      if (isUniqueViolation(e)) return (await this.events.exists(day.tenantId, event.dedupHash)) ? { kind: "Duplicate" } : { kind: "AlreadyExists" };
      throw e;
    }
    const saved = await this.find(day.tenantId, day.raceDate, day.venue);
    const ev = await this.events.findByHash(day.tenantId, event.dedupHash);
    if (saved === null || ev === null) throw new Error("race_day の保存を確認できない");
    return { kind: "Applied", value: saved, event: ev };
  }

  async update(day: RaceDay, event: ScheduleEvent): Promise<ChangeResult<RaceDay>> {
    if (await this.events.exists(day.tenantId, event.dedupHash)) return { kind: "Duplicate" };
    const key = [day.tenantId, day.raceDate, day.venue] as const;
    const res = await this.db.batch([
      this.db
        .prepare(
          "UPDATE race_day SET status = ?, replaced_by_date = ?, last_confirmed_at = ?, version = version + 1 WHERE tenant_id = ? AND race_date = ? AND venue_code = ? AND version = ?",
        )
        .bind(day.status, day.replacedByDate, day.lastConfirmedAt, ...key, day.version),
      this.events.conditionalInsert(event, "SELECT 1 FROM race_day WHERE tenant_id = ? AND race_date = ? AND venue_code = ? AND version = ? AND status = ?", [...key, day.version + 1, day.status]),
    ]);
    if ((res[0]?.meta.changes ?? 0) !== 1) return (await this.find(...key)) === null ? { kind: "NotFound" } : { kind: "Conflict" };
    const saved = await this.find(...key);
    const ev = await this.events.findByHash(day.tenantId, event.dedupHash);
    if (saved === null || ev === null) throw new Error("race_day の更新を確認できない");
    return { kind: "Applied", value: saved, event: ev };
  }

  async confirm(tenantId: number, date: string, venue: string, observedAt: string): Promise<boolean> {
    await this.db
      .prepare("UPDATE race_day SET last_confirmed_at = ? WHERE tenant_id = ? AND race_date = ? AND venue_code = ? AND (last_confirmed_at IS NULL OR last_confirmed_at < ?)")
      .bind(observedAt, tenantId, date, venue, observedAt)
      .run();
    return (await this.find(tenantId, date, venue)) !== null;
  }
}

// ---- 開催予定 ----
function toSchedule(r: Row): RaceSchedule {
  return {
    tenantId: int(r, "tenant_id"),
    raceId: str(r, "race_id"),
    kai: optInt(r, "kai"),
    nichime: optInt(r, "nichime"),
    scheduledPostAt: optStr(r, "scheduled_post_at"),
    postTimeUnknown: int(r, "post_time_unknown") === 1,
    status: str(r, "status") as RaceScheduleStatus,
    dataKubun: str(r, "data_kubun"),
    sourceVersion: str(r, "source_version"),
    raceName: optStr(r, "race_name"),
    lastChangedAt: str(r, "last_changed_at"),
    version: int(r, "version"),
  };
}

export class RaceScheduleRepo implements RaceScheduleRepository {
  constructor(
    private readonly db: SqlDatabase,
    private readonly events: ScheduleEventRepo,
  ) {}

  async find(tenantId: number, raceId: string): Promise<RaceSchedule | null> {
    const r = await this.db.prepare("SELECT * FROM race_schedule WHERE tenant_id = ? AND race_id = ?").bind(tenantId, raceId).first<Row>();
    return r === null ? null : toSchedule(r);
  }

  async listByDate(tenantId: number, date: string): Promise<RaceSchedule[]> {
    const r = await this.db.prepare("SELECT * FROM race_schedule WHERE tenant_id = ? AND race_date = ? ORDER BY race_id").bind(tenantId, date).all<Row>();
    return r.results.map(toSchedule);
  }

  async insertIfAbsent(s: RaceSchedule, event: ScheduleEvent): Promise<ChangeResult<RaceSchedule>> {
    if (await this.events.exists(s.tenantId, event.dedupHash)) return { kind: "Duplicate" };
    if ((await this.find(s.tenantId, s.raceId)) !== null) return { kind: "AlreadyExists" };
    const id = parseRaceId(s.raceId);
    if (id === null) throw new Error("race_id が不正");
    try {
      await this.db.batch([
        this.db
          .prepare(
            `INSERT INTO race_schedule (tenant_id, race_id, race_date, venue_code, race_no, kai, nichime, scheduled_post_at, post_time_unknown, status, data_kubun, source_version, race_name, last_changed_at, version)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
          )
          .bind(s.tenantId, s.raceId, id.date, id.venue, id.raceNo, s.kai, s.nichime, s.scheduledPostAt, s.postTimeUnknown ? 1 : 0, s.status, s.dataKubun, s.sourceVersion, s.raceName, s.lastChangedAt),
        this.events.insertStatement(event),
      ]);
    } catch (e) {
      if (isUniqueViolation(e)) return (await this.events.exists(s.tenantId, event.dedupHash)) ? { kind: "Duplicate" } : { kind: "AlreadyExists" };
      throw e;
    }
    const saved = await this.find(s.tenantId, s.raceId);
    const ev = await this.events.findByHash(s.tenantId, event.dedupHash);
    if (saved === null || ev === null) throw new Error("race_schedule の保存を確認できない");
    return { kind: "Applied", value: saved, event: ev };
  }

  async update(s: RaceSchedule, event: ScheduleEvent): Promise<ChangeResult<RaceSchedule>> {
    if (await this.events.exists(s.tenantId, event.dedupHash)) return { kind: "Duplicate" };
    const res = await this.db.batch([
      this.db
        .prepare(
          `UPDATE race_schedule SET kai = ?, nichime = ?, scheduled_post_at = ?, post_time_unknown = ?, status = ?, data_kubun = ?, source_version = ?, race_name = ?, last_changed_at = ?, version = version + 1
           WHERE tenant_id = ? AND race_id = ? AND version = ?`,
        )
        .bind(s.kai, s.nichime, s.scheduledPostAt, s.postTimeUnknown ? 1 : 0, s.status, s.dataKubun, s.sourceVersion, s.raceName, s.lastChangedAt, s.tenantId, s.raceId, s.version),
      this.events.conditionalInsert(event, "SELECT 1 FROM race_schedule WHERE tenant_id = ? AND race_id = ? AND version = ? AND last_changed_at = ?", [s.tenantId, s.raceId, s.version + 1, s.lastChangedAt]),
    ]);
    if ((res[0]?.meta.changes ?? 0) !== 1) return (await this.find(s.tenantId, s.raceId)) === null ? { kind: "NotFound" } : { kind: "Conflict" };
    const saved = await this.find(s.tenantId, s.raceId);
    const ev = await this.events.findByHash(s.tenantId, event.dedupHash);
    if (saved === null || ev === null) throw new Error("race_schedule の更新を確認できない");
    return { kind: "Applied", value: saved, event: ev };
  }

  /** 状態だけの進行（MONITORING・OFF など。bot-run が呼ぶ）。履歴は残さない（Kotlin も時刻の遷移はイベントの種類を持たない）。 */
  async advanceStatus(tenantId: number, raceId: string, from: RaceScheduleStatus, to: RaceScheduleStatus, now: string): Promise<boolean> {
    const r = await this.db
      .prepare("UPDATE race_schedule SET status = ?, last_changed_at = ?, version = version + 1 WHERE tenant_id = ? AND race_id = ? AND status = ?")
      .bind(to, now, tenantId, raceId, from)
      .run();
    return r.meta.changes === 1;
  }
}

// ---- races・オッズ・結果・払戻（取込の保存先）----
export class MarketDataRepo {
  constructor(private readonly db: SqlDatabase) {}

  async exists(tenantId: number, raceId: string): Promise<boolean> {
    return (await this.db.prepare("SELECT 1 AS x FROM races WHERE tenant_id = ? AND race_id = ?").bind(tenantId, raceId).first()) !== null;
  }

  async upsertMinimal(tenantId: number, raceId: RaceId, kai: number | null, nichime: number | null, postTime: string | null, name: string | null): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .prepare(
        `INSERT INTO races (tenant_id, race_id, race_date, venue_code, race_no, kai, nichime, post_time, post_time_unknown, name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?) ON CONFLICT (tenant_id, race_id) DO NOTHING`,
      )
      .bind(tenantId, raceId.value, raceId.date, raceId.venue, raceId.raceNo, kai, nichime, postTime === null ? null : `${postTime}:00`, name, now, now)
      .run();
  }

  async upsertWin(tenantId: number, raceId: string, observedAt: string, entries: readonly OddsEntryObs[]): Promise<UpsertOutcome> {
    const existing = await this.db.prepare("SELECT umaban, odds, popularity FROM odds_snapshots WHERE tenant_id = ? AND race_id = ? AND market = 'win' AND observed_at = ?").bind(tenantId, raceId, observedAt).all<Row>();
    const same =
      existing.results.length === entries.length &&
      entries.every((e) => existing.results.some((r) => int(r, "umaban") === e.umaban && real(r, "odds") === e.odds && optInt(r, "popularity") === e.popularity));
    if (same) return "UNCHANGED";
    await this.db.batch([
      this.db.prepare("DELETE FROM odds_snapshots WHERE tenant_id = ? AND race_id = ? AND market = 'win' AND observed_at = ?").bind(tenantId, raceId, observedAt),
      ...entries.map((e) =>
        this.db.prepare("INSERT INTO odds_snapshots (tenant_id, race_id, market, observed_at, umaban, odds, popularity) VALUES (?, ?, 'win', ?, ?, ?, ?)").bind(tenantId, raceId, observedAt, e.umaban, e.odds, e.popularity),
      ),
    ]);
    return existing.results.length === 0 ? "INSERTED" : "UPDATED";
  }

  async upsertCombos(tenantId: number, raceId: string, market: "wide" | "sanrenpuku", collectedAt: string, rows: readonly ComboOddsRow[], source: string): Promise<UpsertOutcome> {
    const existing = await this.db
      .prepare("SELECT combo_key, odds, odds_high, popularity FROM combo_odds_snapshots WHERE tenant_id = ? AND race_id = ? AND market = ? AND collected_at = ?")
      .bind(tenantId, raceId, market, collectedAt)
      .all<Row>();
    const same =
      existing.results.length === rows.length &&
      rows.every((e) => existing.results.some((r) => str(r, "combo_key") === e.comboKey && real(r, "odds") === e.odds && optReal(r, "odds_high") === e.oddsHigh && optInt(r, "popularity") === e.popularity));
    if (same) return "UNCHANGED";
    const now = new Date().toISOString();
    await this.db.batch([
      this.db.prepare("DELETE FROM combo_odds_snapshots WHERE tenant_id = ? AND race_id = ? AND market = ? AND collected_at = ?").bind(tenantId, raceId, market, collectedAt),
      ...rows.map((e) =>
        this.db
          .prepare("INSERT INTO combo_odds_snapshots (tenant_id, race_id, market, collected_at, combo_key, odds, odds_high, popularity, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .bind(tenantId, raceId, market, collectedAt, e.comboKey, e.odds, e.oddsHigh, e.popularity, source.slice(0, 16), now),
      ),
    ]);
    return existing.results.length === 0 ? "INSERTED" : "UPDATED";
  }

  async upsertResults(tenantId: number, raceId: string, entries: readonly { umaban: number; finish: number | null }[]): Promise<UpsertOutcome> {
    const existing = await this.listResults(tenantId, raceId);
    const changed = entries.filter((e) => existing.find((x) => x.umaban === e.umaban)?.finish !== e.finish || !existing.some((x) => x.umaban === e.umaban));
    if (changed.length === 0) return "UNCHANGED";
    const now = new Date().toISOString();
    await this.db.batch(
      changed.map((e) =>
        this.db
          .prepare(
            `INSERT INTO results (tenant_id, race_id, umaban, finish, payout, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?)
             ON CONFLICT (tenant_id, race_id, umaban) DO UPDATE SET finish = excluded.finish, updated_at = excluded.updated_at`,
          )
          .bind(tenantId, raceId, e.umaban, e.finish, now, now),
      ),
    );
    return existing.length === 0 ? "INSERTED" : "UPDATED";
  }

  async listResults(tenantId: number, raceId: string): Promise<ResultEntry[]> {
    const r = await this.db.prepare("SELECT umaban, finish FROM results WHERE tenant_id = ? AND race_id = ? ORDER BY umaban").bind(tenantId, raceId).all<Row>();
    return r.results.map((x) => ({ umaban: int(x, "umaban"), finish: optInt(x, "finish") }));
  }

  /** 払戻。速報（provisional）は確定済みの行を上書きしない。 */
  async upsertPayouts(tenantId: number, raceId: string, market: Market, rows: readonly { comboKey: string; payout: number }[], provisional: boolean): Promise<UpsertOutcome> {
    const existing = await this.listPayouts(tenantId, raceId, market);
    const now = new Date().toISOString();
    const stmts: SqlStatement[] = [];
    for (const r of rows) {
      const prev = existing.find((p) => p.comboKey === r.comboKey);
      if (prev !== undefined && provisional && !prev.provisional) continue;
      if (prev !== undefined && prev.payout === r.payout && prev.provisional === provisional) continue;
      stmts.push(
        this.db
          .prepare(
            `INSERT INTO payouts (tenant_id, race_id, market, combo_key, payout, is_provisional, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (tenant_id, race_id, market, combo_key) DO UPDATE SET payout = excluded.payout, is_provisional = excluded.is_provisional, updated_at = excluded.updated_at`,
          )
          .bind(tenantId, raceId, market, r.comboKey, r.payout, provisional ? 1 : 0, now, now),
      );
    }
    if (stmts.length === 0) return "UNCHANGED";
    await this.db.batch(stmts);
    return existing.length === 0 ? "INSERTED" : "UPDATED";
  }

  async listPayouts(tenantId: number, raceId: string, market: Market): Promise<StoredPayout[]> {
    const r = await this.db.prepare("SELECT combo_key, payout, is_provisional FROM payouts WHERE tenant_id = ? AND race_id = ? AND market = ? ORDER BY combo_key").bind(tenantId, raceId, market).all<Row>();
    return r.results.map((x) => ({ comboKey: str(x, "combo_key"), payout: real(x, "payout"), provisional: int(x, "is_provisional") === 1 }));
  }

  /** 最新の単勝オッズのスナップショット（観測時刻 <= at）。発走後のオッズを判定に混ぜないため、上限の時刻を必ず渡す。 */
  async latestWinOdds(tenantId: number, raceId: string, at: string): Promise<{ observedAt: string; entries: OddsEntryObs[] } | null> {
    const t = await this.db
      .prepare("SELECT MAX(observed_at) AS t FROM odds_snapshots WHERE tenant_id = ? AND race_id = ? AND market = 'win' AND observed_at <= ?")
      .bind(tenantId, raceId, at)
      .first<Row>();
    const observedAt = t === null ? null : optStr(t, "t");
    if (observedAt === null) return null;
    const r = await this.db.prepare("SELECT umaban, odds, popularity FROM odds_snapshots WHERE tenant_id = ? AND race_id = ? AND market = 'win' AND observed_at = ? ORDER BY umaban").bind(tenantId, raceId, observedAt).all<Row>();
    return { observedAt, entries: r.results.map((x) => ({ umaban: int(x, "umaban"), odds: real(x, "odds"), popularity: optInt(x, "popularity") })) };
  }

  /** 馬番ごとの直近スナップショット（新しい順。旧 get_recent_snapshots の limit 既定 3 → 設定 snapshot_history_limit）。 */
  async recentWinSnapshots(tenantId: number, raceId: string, at: string, limit: number): Promise<Map<number, { odds: number; popularity: number }[]>> {
    const times = await this.db
      .prepare("SELECT DISTINCT observed_at FROM odds_snapshots WHERE tenant_id = ? AND race_id = ? AND market = 'win' AND observed_at <= ? ORDER BY observed_at DESC LIMIT ?")
      .bind(tenantId, raceId, at, limit)
      .all<Row>();
    const out = new Map<number, { odds: number; popularity: number }[]>();
    for (const t of times.results) {
      const rows = await this.db.prepare("SELECT umaban, odds, popularity FROM odds_snapshots WHERE tenant_id = ? AND race_id = ? AND market = 'win' AND observed_at = ?").bind(tenantId, raceId, str(t, "observed_at")).all<Row>();
      for (const r of rows.results) {
        const u = int(r, "umaban");
        out.set(u, [...(out.get(u) ?? []), { odds: real(r, "odds"), popularity: optInt(r, "popularity") ?? 0 }]);
      }
    }
    return out;
  }

  /** 最新の組合せオッズ（collected_at <= at）。 */
  async latestCombos(tenantId: number, raceId: string, market: "wide" | "sanrenpuku", at: string): Promise<{ collectedAt: string; rows: ComboOddsRow[] } | null> {
    const t = await this.db
      .prepare("SELECT MAX(collected_at) AS t FROM combo_odds_snapshots WHERE tenant_id = ? AND race_id = ? AND market = ? AND collected_at <= ?")
      .bind(tenantId, raceId, market, at)
      .first<Row>();
    const collectedAt = t === null ? null : optStr(t, "t");
    if (collectedAt === null) return null;
    const r = await this.db
      .prepare("SELECT combo_key, odds, odds_high, popularity FROM combo_odds_snapshots WHERE tenant_id = ? AND race_id = ? AND market = ? AND collected_at = ? ORDER BY combo_key")
      .bind(tenantId, raceId, market, collectedAt)
      .all<Row>();
    return { collectedAt, rows: r.results.map((x) => ({ comboKey: str(x, "combo_key"), odds: real(x, "odds"), oddsHigh: optReal(x, "odds_high"), popularity: optInt(x, "popularity") })) };
  }
}

// ---- シグナル ----
export interface SignalRow {
  readonly id: number | null;
  readonly raceId: string;
  readonly market: Market;
  readonly umaban: number;
  readonly observedAt: string;
  readonly odds: number;
  readonly prob: number;
  readonly ev: number;
  readonly stake: number;
  readonly expectedProfit: number | null;
  readonly skipReason: string | null;
  readonly kellyRaw: number | null;
  readonly kellyAdj: number | null;
  readonly betBeforeClip: number | null;
  readonly clipped: boolean;
  readonly mkt: number | null;
  readonly ratio: number | null;
  readonly expectedReturn: number | null;
  readonly suggestedBet: number | null;
  readonly probSource: string | null;
  readonly reason: string | null;
  readonly state: "UNSENT" | "CLAIMED" | "SENT" | "SEND_UNKNOWN";
}

function toSignal(r: Row): SignalRow {
  return {
    id: int(r, "id"),
    raceId: str(r, "race_id"),
    market: str(r, "market") as Market,
    umaban: int(r, "umaban"),
    observedAt: str(r, "observed_at"),
    odds: real(r, "odds"),
    prob: real(r, "prob"),
    ev: real(r, "ev"),
    stake: real(r, "stake"),
    expectedProfit: optReal(r, "expected_profit"),
    skipReason: optStr(r, "skip_reason"),
    kellyRaw: optReal(r, "kelly_raw"),
    kellyAdj: optReal(r, "kelly_adj"),
    betBeforeClip: optReal(r, "bet_before_clip"),
    clipped: int(r, "clipped") === 1,
    mkt: optReal(r, "mkt"),
    ratio: optReal(r, "ratio"),
    expectedReturn: optReal(r, "expected_return"),
    suggestedBet: optReal(r, "suggested_bet"),
    probSource: optStr(r, "prob_source"),
    reason: optStr(r, "reason"),
    state: str(r, "notify_state") as SignalRow["state"],
  };
}

export class SignalRepo {
  constructor(private readonly db: SqlDatabase) {}

  insertStatement(tenantId: number, s: SignalRow, now: string): SqlStatement {
    return this.db
      .prepare(
        `INSERT INTO signals (tenant_id, race_id, market, umaban, observed_at, odds, prob, ev, is_paper, stake, expected_profit, skip_reason, kelly_raw, kelly_adj, bet_before_clip, clipped, mkt, ratio, expected_return, suggested_bet, prob_source, reason, notify_state, notify_updated_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (tenant_id, race_id, market, umaban, observed_at) DO NOTHING`,
      )
      .bind(
        tenantId,
        s.raceId,
        s.market,
        s.umaban,
        s.observedAt,
        s.odds,
        s.prob,
        s.ev,
        s.stake,
        s.expectedProfit,
        s.skipReason?.slice(0, 200) ?? null,
        s.kellyRaw,
        s.kellyAdj,
        s.betBeforeClip,
        s.clipped ? 1 : 0,
        s.mkt,
        s.ratio,
        s.expectedReturn,
        s.suggestedBet,
        s.probSource?.slice(0, 100) ?? null,
        s.reason?.slice(0, 500) ?? null,
        s.state,
        now,
        now,
      );
  }

  async listByRace(tenantId: number, raceId: string): Promise<SignalRow[]> {
    const r = await this.db.prepare("SELECT * FROM signals WHERE tenant_id = ? AND race_id = ? ORDER BY observed_at DESC, umaban").bind(tenantId, raceId).all<Row>();
    return r.results.map(toSignal);
  }

  /** 日付（race_date）単位の一覧。ページング（観測の新しい順 → レース → 馬番。ReadApi と同じ並び）。 */
  async pageByDate(tenantId: number, date: string, page: number, size: number): Promise<{ items: SignalRow[]; total: number }> {
    const like = `${date.replaceAll("-", "")}%`;
    const total = await this.db.prepare("SELECT COUNT(*) AS n FROM signals WHERE tenant_id = ? AND race_id LIKE ?").bind(tenantId, like).first<Row>();
    const r = await this.db
      .prepare("SELECT * FROM signals WHERE tenant_id = ? AND race_id LIKE ? ORDER BY observed_at DESC, race_id, umaban LIMIT ? OFFSET ?")
      .bind(tenantId, like, size, page * size)
      .all<Row>();
    return { items: r.results.map(toSignal), total: total === null ? 0 : int(total, "n") };
  }

  async markState(tenantId: number, id: number, state: SignalRow["state"], now: string): Promise<void> {
    await this.db.prepare("UPDATE signals SET notify_state = ?, notify_updated_at = ? WHERE tenant_id = ? AND id = ?").bind(state, now, tenantId, id).run();
  }
}

// ---- 評価・通知のスナップショット ----
export class EvaluationRepo {
  constructor(private readonly db: SqlDatabase) {}

  /** race_evaluations の追記（同じレース・同じ時刻は 1 件: uq_race_evaluations_native）。既存なら null。 */
  async insert(tenantId: number, e: { raceId: string; snapshotAt: string; betTypes: string; priorityMode: string; evThreshold: number; bestCandidateJson: string | null; bestEv: number | null; rejectionJson: string; signalSent: boolean; fallbackReason: string | null; modelType: string }, now: string): Promise<number | null> {
    try {
      const r = await this.db
        .prepare(
          `INSERT INTO race_evaluations (tenant_id, race_id, snapshot_at, model_type_used, fallback_reason, bet_types, priority_mode, ev_threshold, best_candidate_json, best_ev, rejection_summary_json, signal_sent, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(tenantId, e.raceId, e.snapshotAt, e.modelType, e.fallbackReason, e.betTypes, e.priorityMode, e.evThreshold, e.bestCandidateJson, e.bestEv, e.rejectionJson, e.signalSent ? 1 : 0, now)
        .run();
      return r.meta.last_row_id;
    } catch (err) {
      if (isUniqueViolation(err)) return null;
      throw err;
    }
  }

  async insertNotice(tenantId: number, n: { raceId: string; timingCenti: number; runId: string; evaluationId: number; oddsObservedAt: string; schema: number; json: string; sha256: string }, now: string): Promise<boolean> {
    const r = await this.db
      .prepare(
        `INSERT INTO race_timing_notice (tenant_id, race_id, timing_centi, run_id, evaluation_id, odds_observed_at, notice_schema, notice_json, notice_sha256, fired_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (tenant_id, race_id, timing_centi) DO NOTHING`,
      )
      .bind(tenantId, n.raceId, n.timingCenti, n.runId, n.evaluationId, n.oddsObservedAt, n.schema, n.json, n.sha256, now)
      .run();
    return r.meta.changes === 1;
  }

  async listNotices(tenantId: number, raceId: string): Promise<{ timingCenti: number; oddsObservedAt: string; schema: number; json: string; sha256: string }[]> {
    const r = await this.db.prepare("SELECT * FROM race_timing_notice WHERE tenant_id = ? AND race_id = ? ORDER BY timing_centi DESC").bind(tenantId, raceId).all<Row>();
    return r.results.map((x) => ({ timingCenti: int(x, "timing_centi"), oddsObservedAt: str(x, "odds_observed_at"), schema: int(x, "notice_schema"), json: str(x, "notice_json"), sha256: str(x, "notice_sha256") }));
  }

  async latestByRace(tenantId: number, raceId: string): Promise<Row | null> {
    return this.db.prepare("SELECT * FROM race_evaluations WHERE tenant_id = ? AND race_id = ? ORDER BY snapshot_at DESC, id DESC LIMIT 1").bind(tenantId, raceId).first<Row>();
  }
}

// ---- 手動補正 ----
function toOverride(r: Row): CalendarOverride {
  return {
    tenantId: int(r, "tenant_id"),
    id: int(r, "id"),
    scope: str(r, "scope") as CalendarOverride["scope"],
    raceDate: str(r, "race_date"),
    raceId: optStr(r, "race_id"),
    action: str(r, "action") as CalendarOverride["action"],
    value: optStr(r, "value"),
    reason: str(r, "reason"),
    createdBy: str(r, "created_by"),
    createdAt: str(r, "created_at"),
    validUntil: optStr(r, "valid_until"),
    revokedAt: optStr(r, "revoked_at"),
    revokedBy: optStr(r, "revoked_by"),
  };
}

export class OverrideRepo {
  constructor(
    private readonly db: SqlDatabase,
    private readonly events: ScheduleEventRepo,
  ) {}

  async find(tenantId: number, id: number): Promise<CalendarOverride | null> {
    const r = await this.db.prepare("SELECT * FROM calendar_override WHERE tenant_id = ? AND id = ?").bind(tenantId, id).first<Row>();
    return r === null ? null : toOverride(r);
  }

  async listByDate(tenantId: number, date: string): Promise<CalendarOverride[]> {
    const r = await this.db.prepare("SELECT * FROM calendar_override WHERE tenant_id = ? AND race_date = ? ORDER BY created_at, id").bind(tenantId, date).all<Row>();
    return r.results.map(toOverride);
  }

  async create(o: CalendarOverride, event: ScheduleEvent): Promise<CalendarOverride | "Duplicate"> {
    if (await this.events.exists(o.tenantId, event.dedupHash)) return "Duplicate";
    const res = await this.db.batch([
      this.db
        .prepare("INSERT INTO calendar_override (tenant_id, scope, race_date, race_id, action, value, reason, created_by, created_at, valid_until) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(o.tenantId, o.scope, o.raceDate, o.raceId, o.action, o.value, o.reason, o.createdBy, o.createdAt, o.validUntil),
      this.events.insertStatement(event),
    ]);
    const id = res[0]?.meta.last_row_id ?? 0;
    const saved = await this.find(o.tenantId, id);
    if (saved === null) throw new Error("calendar_override の保存を確認できない");
    return saved;
  }

  async revoke(tenantId: number, id: number, revokedBy: string, revokedAt: string, event: ScheduleEvent): Promise<"Revoked" | "AlreadyRevoked" | "NotFound"> {
    const res = await this.db.batch([
      this.db.prepare("UPDATE calendar_override SET revoked_at = ?, revoked_by = ? WHERE tenant_id = ? AND id = ? AND revoked_at IS NULL").bind(revokedAt, revokedBy, tenantId, id),
      this.events.conditionalInsert(event, "SELECT 1 FROM calendar_override WHERE tenant_id = ? AND id = ? AND revoked_at = ? AND revoked_by = ?", [tenantId, id, revokedAt, revokedBy]),
    ]);
    if ((res[0]?.meta.changes ?? 0) === 1) return "Revoked";
    return (await this.find(tenantId, id)) === null ? "NotFound" : "AlreadyRevoked";
  }
}

// ---- 実行履歴（bot_run）とリース ----
export interface BotRun {
  readonly runId: string;
  readonly runDate: string;
  readonly trigger: "SCHEDULER" | "MANUAL" | "RECONCILE" | "BACKFILL";
  readonly state: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly exitReason: string | null;
  readonly leaseExpiresAt: string | null;
  readonly checkpoint: string | null;
}

function toRun(r: Row): BotRun {
  return {
    runId: str(r, "run_id"),
    runDate: str(r, "run_date"),
    trigger: str(r, "trigger_type") as BotRun["trigger"],
    state: str(r, "state"),
    startedAt: str(r, "started_at"),
    finishedAt: optStr(r, "finished_at"),
    exitReason: optStr(r, "exit_reason"),
    leaseExpiresAt: optStr(r, "lease_expires_at"),
    checkpoint: optStr(r, "checkpoint"),
  };
}

export class BotRunRepo {
  constructor(private readonly db: SqlDatabase) {}

  async listByDate(tenantId: number, date: string): Promise<BotRun[]> {
    const r = await this.db.prepare("SELECT * FROM bot_run WHERE tenant_id = ? AND run_date = ? ORDER BY started_at DESC").bind(tenantId, date).all<Row>();
    return r.results.map(toRun);
  }

  async latest(tenantId: number, limit: number): Promise<BotRun[]> {
    const r = await this.db.prepare("SELECT * FROM bot_run WHERE tenant_id = ? ORDER BY started_at DESC LIMIT ?").bind(tenantId, limit).all<Row>();
    return r.results.map(toRun);
  }

  async active(tenantId: number, date: string): Promise<BotRun | null> {
    const r = await this.db.prepare("SELECT * FROM bot_run WHERE tenant_id = ? AND run_date = ? AND active_slot = 1").bind(tenantId, date).first<Row>();
    return r === null ? null : toRun(r);
  }

  /**
   * 実行の開始（同じ日の実行中は 1 件: uq_bot_run_active）。期限切れのリースは INTERRUPTED にして取り直す（重複実行の防止と、落ちた実行の回復）。
   * 取れなければ null（他の実行中）。
   */
  async tryStart(tenantId: number, runId: string, date: string, trigger: BotRun["trigger"], owner: string, now: Date, leaseMs: number): Promise<BotRun | null> {
    const nowIso = now.toISOString();
    const current = await this.active(tenantId, date);
    if (current !== null) {
      if (current.leaseExpiresAt !== null && current.leaseExpiresAt > nowIso) return null;
      await this.db
        .prepare("UPDATE bot_run SET state = 'INTERRUPTED', active_slot = NULL, finished_at = ?, exit_reason = 'LEASE_EXPIRED', version = version + 1 WHERE tenant_id = ? AND run_id = ? AND active_slot = 1")
        .bind(nowIso, tenantId, current.runId)
        .run();
    }
    try {
      await this.db
        .prepare(
          `INSERT INTO bot_run (tenant_id, run_id, run_date, trigger_type, state, lease_owner, lease_expires_at, heartbeat_at, active_slot, started_at, version)
           VALUES (?, ?, ?, ?, 'RUNNING', ?, ?, ?, 1, ?, 0)`,
        )
        .bind(tenantId, runId, date, trigger, owner.slice(0, 100), new Date(now.getTime() + leaseMs).toISOString(), nowIso, nowIso)
        .run();
    } catch (e) {
      if (isUniqueViolation(e)) return null;
      throw e;
    }
    return this.active(tenantId, date);
  }

  async finish(tenantId: number, runId: string, state: "SUCCEEDED" | "FAILED" | "ABORTED" | "STOPPED_BY_MODE", exitReason: string | null, checkpoint: string | null, now: Date): Promise<void> {
    await this.db
      .prepare("UPDATE bot_run SET state = ?, active_slot = NULL, finished_at = ?, exit_reason = ?, checkpoint = ?, version = version + 1 WHERE tenant_id = ? AND run_id = ? AND active_slot = 1")
      .bind(state, now.toISOString(), exitReason?.slice(0, 200) ?? null, checkpoint, tenantId, runId)
      .run();
  }

  /** 状態は変えずに記録だけ残す（停止中・対象なしで早期終了した実行）。 */
  async record(tenantId: number, runId: string, date: string, trigger: BotRun["trigger"], state: "SUCCEEDED" | "STOPPED_BY_MODE" | "FAILED", exitReason: string, now: Date): Promise<void> {
    const iso = now.toISOString();
    await this.db
      .prepare("INSERT INTO bot_run (tenant_id, run_id, run_date, trigger_type, state, active_slot, exit_reason, started_at, finished_at, version) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, 0)")
      .bind(tenantId, runId, date, trigger, state, exitReason.slice(0, 200), iso, iso)
      .run();
  }
}

// ---- 取込クライアント（agent 表）・取込バッチ ----
export interface AgentRow {
  readonly agentId: string;
  readonly name: string;
  readonly tokenExpiresAt: string;
  readonly status: "ACTIVE" | "REVOKED";
  readonly createdAt: string;
  readonly createdBy: string | null;
  readonly revokedAt: string | null;
  readonly revokedBy: string | null;
}
function toAgent(r: Row): AgentRow {
  return {
    agentId: str(r, "agent_id"),
    name: str(r, "name"),
    tokenExpiresAt: str(r, "token_expires_at"),
    status: str(r, "status") as AgentRow["status"],
    createdAt: str(r, "created_at"),
    createdBy: optStr(r, "created_by"),
    revokedAt: optStr(r, "revoked_at"),
    revokedBy: optStr(r, "revoked_by"),
  };
}

export class AgentRepo {
  constructor(private readonly db: SqlDatabase) {}

  async list(tenantId: number): Promise<AgentRow[]> {
    const r = await this.db.prepare("SELECT * FROM agent WHERE tenant_id = ? ORDER BY created_at DESC").bind(tenantId).all<Row>();
    return r.results.map(toAgent);
  }

  async findByTokenHash(tokenHash: string): Promise<(AgentRow & { tenantId: number }) | null> {
    const r = await this.db.prepare("SELECT * FROM agent WHERE token_hash = ?").bind(tokenHash).first<Row>();
    return r === null ? null : { ...toAgent(r), tenantId: int(r, "tenant_id") };
  }

  async find(tenantId: number, agentId: string): Promise<AgentRow | null> {
    const r = await this.db.prepare("SELECT * FROM agent WHERE tenant_id = ? AND agent_id = ?").bind(tenantId, agentId).first<Row>();
    return r === null ? null : toAgent(r);
  }

  async create(tenantId: number, a: { agentId: string; name: string; tokenHash: string; expiresAt: string; createdBy: string }, now: string): Promise<void> {
    await this.db
      .prepare("INSERT INTO agent (tenant_id, agent_id, name, token_hash, token_expires_at, status, created_at, created_by) VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?)")
      .bind(tenantId, a.agentId, a.name, a.tokenHash, a.expiresAt, now, a.createdBy)
      .run();
  }

  async revoke(tenantId: number, agentId: string, by: string, now: string): Promise<boolean> {
    const r = await this.db.prepare("UPDATE agent SET status = 'REVOKED', revoked_at = ?, revoked_by = ? WHERE tenant_id = ? AND agent_id = ? AND status = 'ACTIVE'").bind(now, by, tenantId, agentId).run();
    return r.meta.changes === 1;
  }
}

export interface IngestBatchRow {
  readonly batchId: string;
  readonly agentId: string;
  readonly dataspec: string;
  readonly receivedAt: string;
  readonly recordCount: number;
  readonly acceptedCount: number;
  readonly duplicateCount: number;
  readonly status: string;
  readonly failReason: string | null;
}

export class IngestRepo {
  constructor(private readonly db: SqlDatabase) {}

  async findBatch(tenantId: number, batchId: string): Promise<{ payloadSha256: string; status: string } | null> {
    const r = await this.db.prepare("SELECT payload_sha256, status FROM ingest_batch WHERE tenant_id = ? AND batch_id = ?").bind(tenantId, batchId).first<Row>();
    return r === null ? null : { payloadSha256: str(r, "payload_sha256"), status: str(r, "status") };
  }

  async insertBatch(tenantId: number, b: { batchId: string; agentId: string; batchClass: "S" | "R"; dataspec: string; observedAt: string; receivedAt: string; payloadSha256: string; recordCount: number }): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO ingest_batch (tenant_id, batch_id, agent_id, batch_class, dataspec, observed_at, received_at, payload_sha256, record_count, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PROCESSING')",
      )
      .bind(tenantId, b.batchId, b.agentId, b.batchClass, b.dataspec, b.observedAt, b.receivedAt, b.payloadSha256, b.recordCount)
      .run();
  }

  async insertRaw(tenantId: number, r: { recordHash: string; batchId: string; seq: number; dataspec: string; recordId: string; payload: string; receivedAt: string }): Promise<boolean> {
    const res = await this.db
      .prepare(
        "INSERT INTO ingest_raw (tenant_id, record_hash, batch_id, seq, dataspec, record_id, payload, received_at, parse_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING') ON CONFLICT (tenant_id, record_hash) DO NOTHING",
      )
      .bind(tenantId, r.recordHash, r.batchId, r.seq, r.dataspec, r.recordId, r.payload, r.receivedAt)
      .run();
    return res.meta.changes === 1;
  }

  async markRaw(tenantId: number, recordHash: string, status: "PENDING" | "PARSED" | "FAILED", error: string | null): Promise<void> {
    await this.db.prepare("UPDATE ingest_raw SET parse_status = ?, parse_error = ? WHERE tenant_id = ? AND record_hash = ?").bind(status, error?.slice(0, 200) ?? null, tenantId, recordHash).run();
  }

  async completeBatch(tenantId: number, batchId: string, accepted: number, duplicates: number, status: "COMPLETED" | "FAILED", failReason: string | null, now: string): Promise<void> {
    await this.db
      .prepare("UPDATE ingest_batch SET accepted_count = ?, duplicate_count = ?, status = ?, fail_reason = ?, completed_at = ? WHERE tenant_id = ? AND batch_id = ?")
      .bind(accepted, duplicates, status, failReason?.slice(0, 200) ?? null, now, tenantId, batchId)
      .run();
  }

  /** レース待ちの保留（RACE_NOT_FOUND:<race_id>）。 */
  async pendingForRace(tenantId: number, raceId: string, limit: number): Promise<{ recordHash: string; recordId: string; payload: string; batchId: string; dataspec: string; observedAt: string }[]> {
    const r = await this.db
      .prepare(
        `SELECT r.record_hash, r.record_id, r.payload, r.batch_id, r.dataspec, b.observed_at FROM ingest_raw r JOIN ingest_batch b ON b.tenant_id = r.tenant_id AND b.batch_id = r.batch_id
         WHERE r.tenant_id = ? AND r.parse_status = 'PENDING' AND r.parse_error = ? ORDER BY r.received_at, r.seq LIMIT ?`,
      )
      .bind(tenantId, `RACE_NOT_FOUND:${raceId}`, limit)
      .all<Row>();
    return r.results.map((x) => ({ recordHash: str(x, "record_hash"), recordId: str(x, "record_id"), payload: str(x, "payload"), batchId: str(x, "batch_id"), dataspec: str(x, "dataspec"), observedAt: str(x, "observed_at") }));
  }

  async allPending(tenantId: number, limit: number): Promise<{ recordHash: string; recordId: string; payload: string; batchId: string; dataspec: string; observedAt: string; parseError: string | null }[]> {
    const r = await this.db
      .prepare(
        `SELECT r.record_hash, r.record_id, r.payload, r.batch_id, r.dataspec, r.parse_error, b.observed_at FROM ingest_raw r JOIN ingest_batch b ON b.tenant_id = r.tenant_id AND b.batch_id = r.batch_id
         WHERE r.tenant_id = ? AND r.parse_status = 'PENDING' ORDER BY r.received_at, r.seq LIMIT ?`,
      )
      .bind(tenantId, limit)
      .all<Row>();
    return r.results.map((x) => ({ recordHash: str(x, "record_hash"), recordId: str(x, "record_id"), payload: str(x, "payload"), batchId: str(x, "batch_id"), dataspec: str(x, "dataspec"), observedAt: str(x, "observed_at"), parseError: optStr(x, "parse_error") }));
  }

  async recentBatches(tenantId: number, limit: number): Promise<IngestBatchRow[]> {
    const r = await this.db.prepare("SELECT * FROM ingest_batch WHERE tenant_id = ? ORDER BY received_at DESC LIMIT ?").bind(tenantId, limit).all<Row>();
    return r.results.map((x) => ({
      batchId: str(x, "batch_id"),
      agentId: str(x, "agent_id"),
      dataspec: str(x, "dataspec"),
      receivedAt: str(x, "received_at"),
      recordCount: int(x, "record_count"),
      acceptedCount: int(x, "accepted_count"),
      duplicateCount: int(x, "duplicate_count"),
      status: str(x, "status"),
      failReason: optStr(x, "fail_reason"),
    }));
  }

  async counts(tenantId: number): Promise<{ pending: number; failed: number }> {
    const r = await this.db.prepare("SELECT parse_status AS s, COUNT(*) AS n FROM ingest_raw WHERE tenant_id = ? GROUP BY parse_status").bind(tenantId).all<Row>();
    let pending = 0;
    let failed = 0;
    for (const x of r.results) {
      if (str(x, "s") === "PENDING") pending = int(x, "n");
      if (str(x, "s") === "FAILED") failed = int(x, "n");
    }
    return { pending, failed };
  }
}

// ---- 利用者・運用モード・監査 ----
export class AccessRepo {
  constructor(private readonly db: SqlDatabase) {}

  async findUser(email: string): Promise<{ tenantId: number; role: "VIEWER" | "ADMIN"; enabled: boolean } | null> {
    const r = await this.db.prepare("SELECT tenant_id, role, enabled FROM app_user WHERE email = ?").bind(email).first<Row>();
    return r === null ? null : { tenantId: int(r, "tenant_id"), role: str(r, "role") as "VIEWER" | "ADMIN", enabled: int(r, "enabled") === 1 };
  }

  async upsertUser(tenantId: number, email: string, role: "VIEWER" | "ADMIN", now: string): Promise<void> {
    await this.db
      .prepare("INSERT INTO app_user (tenant_id, email, role, enabled, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?) ON CONFLICT (tenant_id, email) DO UPDATE SET role = excluded.role, updated_at = excluded.updated_at")
      .bind(tenantId, email, role, now, now)
      .run();
  }

  async mode(tenantId: number): Promise<"NORMAL" | "STOPPED" | "UNKNOWN"> {
    const r = await this.db.prepare("SELECT mode FROM ops_mode WHERE tenant_id = ?").bind(tenantId).first<Row>();
    const m = r === null ? null : str(r, "mode");
    return m === "NORMAL" || m === "STOPPED" ? m : "UNKNOWN";
  }

  async setMode(tenantId: number, mode: "NORMAL" | "STOPPED", by: string, reason: string | null, now: string): Promise<void> {
    await this.db
      .prepare("INSERT INTO ops_mode (tenant_id, mode, updated_at, updated_by, reason) VALUES (?, ?, ?, ?, ?) ON CONFLICT (tenant_id) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at, updated_by = excluded.updated_by, reason = excluded.reason")
      .bind(tenantId, mode, now, by, reason)
      .run();
  }

  async audit(tenantId: number, a: { actorType: "USER" | "AGENT" | "SYSTEM"; actor: string; action: string; targetType: string; targetId: string | null; after: unknown; reason: string | null }, now: string): Promise<void> {
    await this.db
      .prepare("INSERT INTO audit_log (tenant_id, occurred_at, actor_type, actor, action, target_type, target_id, after_json, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(tenantId, now, a.actorType, a.actor.slice(0, 254), a.action.slice(0, 64), a.targetType.slice(0, 64), a.targetId, a.after === undefined ? null : JSON.stringify(a.after), a.reason?.slice(0, 500) ?? null)
      .run();
  }

  /** DB の使用量の目安（行数）。D1 の容量そのものは Sites の画面で確認する。 */
  async tableCounts(tenantId: number): Promise<Record<string, number>> {
    const tables = ["races", "race_schedule", "odds_snapshots", "combo_odds_snapshots", "results", "payouts", "signals", "race_evaluations", "race_timing_notice", "ingest_raw", "race_schedule_event", "audit_log"];
    const out: Record<string, number> = {};
    for (const t of tables) {
      const r = await this.db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE tenant_id = ?`).bind(tenantId).first<Row>();
      out[t] = r === null ? 0 : int(r, "n");
    }
    return out;
  }
}
