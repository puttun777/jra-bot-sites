/**
 * 開催カレンダー（jra-bot-web@7bcf1c4 domain/calendar の移植: Transitions.kt・SourceVersion.kt・ScheduleEvent.kt・
 * ScheduleUpdates.kt・CalendarOverride.kt・EffectiveCalendar.kt・RaceDay.kt）。
 * 規則（遷移表・版の新旧・冪等・手動補正の優先順位）は Kotlin 版と同じ。違いは非同期（D1）と、
 * 楽観ロックの「更新 + 履歴追記」を `batch` で原子的に行う点（infrastructure/repositories.ts）。
 */
import { parseRaceId, sha256Hex, type Clock, type RaceId } from "./race.js";

// ---- 状態 ----
export const RACE_DAY_STATUSES = [
  "UNPLANNED",
  "PLANNED",
  "UNCONFIRMED",
  "CONFIRMED",
  "RUNNING",
  "SETTLING",
  "COMPLETED",
  "INCOMPLETE",
  "CANCELLED",
  "POSTPONED",
] as const;
export type RaceDayStatus = (typeof RACE_DAY_STATUSES)[number];

export const RACE_SCHEDULE_STATUSES = [
  "ANNOUNCED",
  "CARD",
  "MONITORING",
  "OFF",
  "RESULT_PENDING",
  "RESULT_PARTIAL",
  "SETTLED",
  "FINALIZED",
  "CANCELLED",
  "DELETED",
] as const;
export type RaceScheduleStatus = (typeof RACE_SCHEDULE_STATUSES)[number];

const RACE_EDGES: Readonly<Record<RaceScheduleStatus, readonly RaceScheduleStatus[]>> = {
  ANNOUNCED: ["CARD", "CANCELLED", "DELETED"],
  CARD: ["MONITORING", "CANCELLED", "DELETED"],
  MONITORING: ["OFF", "CANCELLED"],
  OFF: ["RESULT_PENDING"],
  RESULT_PENDING: ["RESULT_PARTIAL", "SETTLED"],
  RESULT_PARTIAL: ["SETTLED"],
  SETTLED: ["FINALIZED"],
  FINALIZED: [],
  CANCELLED: [],
  DELETED: [],
};

export const RaceScheduleTransitions = {
  canTransition: (from: RaceScheduleStatus, to: RaceScheduleStatus): boolean => RACE_EDGES[from].includes(to),
  isTerminal: (s: RaceScheduleStatus): boolean => RACE_EDGES[s].length === 0,
  acceptsPostTimeChange: (s: RaceScheduleStatus): boolean => s === "ANNOUNCED" || s === "CARD" || s === "MONITORING",
  isActive: (s: RaceScheduleStatus): boolean => s !== "CANCELLED" && s !== "DELETED",
  hasCard: (s: RaceScheduleStatus): boolean => s !== "CANCELLED" && s !== "DELETED" && s !== "ANNOUNCED",
};

const DAY_EDGES: Readonly<Record<RaceDayStatus, readonly RaceDayStatus[]>> = {
  UNPLANNED: ["PLANNED", "CONFIRMED"],
  PLANNED: ["CONFIRMED", "CANCELLED", "POSTPONED", "UNCONFIRMED"],
  UNCONFIRMED: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["CANCELLED", "POSTPONED", "RUNNING"],
  RUNNING: ["SETTLING"],
  SETTLING: ["COMPLETED", "INCOMPLETE"],
  INCOMPLETE: ["COMPLETED"],
  COMPLETED: [],
  CANCELLED: [],
  POSTPONED: [],
};

export const RaceDayTransitions = {
  initialStatuses: ["PLANNED", "UNPLANNED", "CONFIRMED"] as readonly RaceDayStatus[],
  canTransition: (from: RaceDayStatus, to: RaceDayStatus): boolean => DAY_EDGES[from].includes(to),
  isTerminal: (s: RaceDayStatus): boolean => DAY_EDGES[s].length === 0,
};

// ---- 版（データ作成日 + データ区分）----
export interface RaceDataKubun {
  readonly code: string;
  readonly name: string;
  readonly rank: number;
  readonly strong: boolean;
  readonly handledByCalendar: boolean;
}
export const KUBUN: Readonly<Record<string, RaceDataKubun>> = {
  "1": { code: "1", name: "ANNOUNCEMENT", rank: 1, strong: false, handledByCalendar: true },
  "2": { code: "2", name: "CARD", rank: 2, strong: false, handledByCalendar: true },
  "3": { code: "3", name: "RESULT_FLASH_3", rank: 3, strong: false, handledByCalendar: false },
  "4": { code: "4", name: "RESULT_FLASH_4", rank: 4, strong: false, handledByCalendar: false },
  "5": { code: "5", name: "RESULT_FLASH_5", rank: 5, strong: false, handledByCalendar: false },
  "6": { code: "6", name: "RESULT_6", rank: 6, strong: false, handledByCalendar: false },
  "7": { code: "7", name: "RESULT_7", rank: 7, strong: false, handledByCalendar: false },
  "9": { code: "9", name: "CANCELLED", rank: 9, strong: true, handledByCalendar: true },
  "0": { code: "0", name: "DELETED", rank: 0, strong: true, handledByCalendar: true },
};
export function kubunOf(code: string): RaceDataKubun | null {
  return Object.hasOwn(KUBUN, code) ? (KUBUN[code] ?? null) : null;
}

export type VersionOrder = "NEWER" | "SAME" | "OLDER" | "UNDECIDABLE";

export interface SourceVersion {
  readonly createdOn: string; // YYYY-MM-DD
  readonly kubun: RaceDataKubun;
}
export function encodeVersion(v: SourceVersion): string {
  return v.createdOn.replaceAll("-", "") + v.kubun.code;
}
export function parseVersion(text: string): SourceVersion | null {
  if (!/^\d{9}$/.test(text)) return null;
  const d = `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  const probe = parseRaceId(`${text.slice(0, 8)}0101`);
  if (probe === null) return null;
  const kubun = kubunOf(text.charAt(8));
  return kubun === null ? null : { createdOn: d, kubun };
}
/** 受信した版 `v` が保存済み `existing` に対して新しいか（文字列の辞書順では決めない）。 */
export function compareVersion(v: SourceVersion, existing: SourceVersion): VersionOrder {
  if (v.createdOn > existing.createdOn) return "NEWER";
  if (v.createdOn < existing.createdOn) return "OLDER";
  if (v.kubun.code === existing.kubun.code) return "SAME";
  if (v.kubun.strong && existing.kubun.strong) return "UNDECIDABLE";
  if (v.kubun.strong) return "NEWER";
  if (existing.kubun.strong) return "OLDER";
  return v.kubun.rank > existing.kubun.rank ? "NEWER" : "OLDER";
}

// ---- 履歴 ----
export type ScheduleEventType =
  | "ADDED"
  | "DELETED"
  | "CANCELLED"
  | "TIME_CHANGE"
  | "SCRATCH"
  | "JOCKEY_CHANGE"
  | "COURSE_CHANGE"
  | "WEATHER"
  | "DAY_STATUS"
  | "POSTPONED"
  | "REVOKED"
  | "MANUAL_OVERRIDE"
  | "MANUAL_REVOKE"
  | "FETCH_FAILURE"
  | "STALE";
export type ScheduleEventSource = "YSCH" | "RACE" | "0B15" | "0B14" | "MANUAL" | "SYSTEM";

export interface ScheduleEvent {
  readonly tenantId: number;
  readonly id: number | null;
  readonly raceId: string | null;
  readonly raceDate: string;
  readonly type: ScheduleEventType;
  readonly oldValue: string | null;
  readonly newValue: string | null;
  readonly source: ScheduleEventSource;
  readonly observedAt: string;
  readonly receivedAt: string;
  readonly batchId: string | null;
  readonly dedupHash: string;
}

/** EventJson.obj（キーを辞書順にした決定的な JSON。値は文字列・数・真偽・null だけ）。 */
export function eventJson(entries: Record<string, string | number | boolean | null>): string {
  const keys = Object.keys(entries).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${JSON.stringify(entries[k] ?? null)}`).join(",")}}`;
}

export async function createEvent(e: {
  tenantId: number;
  raceId: string | null;
  raceDate: string;
  type: ScheduleEventType;
  oldValue: string | null;
  newValue: string | null;
  source: ScheduleEventSource;
  observedAt: string;
  receivedAt: string;
  dedupGroup: string;
  batchId?: string | null;
}): Promise<ScheduleEvent> {
  if (e.dedupGroup.length === 0) throw new Error("dedupGroup は空にできない");
  const parts = [String(e.tenantId), e.raceId ?? "-", e.raceDate, e.type, e.source, e.oldValue ?? "-", e.newValue ?? "-", e.dedupGroup];
  const dedupHash = await sha256Hex(parts.join("\u001f"));
  return { ...e, id: null, batchId: e.batchId ?? null, dedupHash };
}

// ---- 行 ----
export interface RaceDay {
  readonly tenantId: number;
  readonly raceDate: string;
  readonly venue: string;
  readonly kai: number;
  readonly nichime: number;
  readonly status: RaceDayStatus;
  readonly replacedByDate: string | null;
  readonly firstSeenAt: string;
  readonly lastConfirmedAt: string | null;
  readonly version: number;
}

export interface RaceSchedule {
  readonly tenantId: number;
  readonly raceId: string;
  readonly kai: number | null;
  readonly nichime: number | null;
  readonly scheduledPostAt: string | null;
  readonly postTimeUnknown: boolean;
  readonly status: RaceScheduleStatus;
  readonly dataKubun: string;
  readonly sourceVersion: string;
  readonly raceName: string | null;
  readonly lastChangedAt: string;
  readonly version: number;
}

export type ChangeResult<T> =
  | { readonly kind: "Applied"; readonly value: T; readonly event: ScheduleEvent }
  | { readonly kind: "Duplicate" }
  | { readonly kind: "Conflict" }
  | { readonly kind: "NotFound" }
  | { readonly kind: "AlreadyExists" };

export interface RaceDayRepository {
  find(tenantId: number, date: string, venue: string): Promise<RaceDay | null>;
  listByDate(tenantId: number, date: string): Promise<RaceDay[]>;
  insertIfAbsent(day: RaceDay, event: ScheduleEvent): Promise<ChangeResult<RaceDay>>;
  update(day: RaceDay, event: ScheduleEvent): Promise<ChangeResult<RaceDay>>;
  confirm(tenantId: number, date: string, venue: string, observedAt: string): Promise<boolean>;
}

export interface RaceScheduleRepository {
  find(tenantId: number, raceId: string): Promise<RaceSchedule | null>;
  listByDate(tenantId: number, date: string): Promise<RaceSchedule[]>;
  insertIfAbsent(s: RaceSchedule, event: ScheduleEvent): Promise<ChangeResult<RaceSchedule>>;
  update(s: RaceSchedule, event: ScheduleEvent): Promise<ChangeResult<RaceSchedule>>;
}

export interface ScheduleEventReader {
  eventsOfRace(tenantId: number, raceId: string): Promise<ScheduleEvent[]>;
}

// ---- 反映の結果 ----
export type RejectReason =
  | "OLDER_SOURCE_VERSION"
  | "SAME_VERSION_DIFFERENT_CONTENT"
  | "UNDECIDABLE_SOURCE_VERSION"
  | "UNPARSEABLE_STORED_VERSION"
  | "INVALID_TRANSITION"
  | "UNSUPPORTED_KUBUN"
  | "RACE_NOT_FOUND"
  | "TIME_CHANGE_NOT_ACCEPTED"
  | "POST_TIME_DATE_MISMATCH"
  | "OLDER_OBSERVATION"
  | "UNRECORDABLE_CHANGE"
  | "INVALID_INITIAL_STATUS";
export type NoChangeReason = "DUPLICATE_VERSION" | "NO_EFFECTIVE_CHANGE" | "DUPLICATE_EVENT" | "NOTHING_TO_DELETE" | "CONFIRMED_ONLY";

export type ApplyResult<T> =
  | { readonly kind: "Applied"; readonly value: T; readonly event: ScheduleEvent }
  | { readonly kind: "NoChange"; readonly reason: NoChangeReason }
  | { readonly kind: "Rejected"; readonly reason: RejectReason }
  | { readonly kind: "Conflict" };

const MAX_ATTEMPTS = 3;

/** レース詳細の観測（RaceScheduleObservation）。postTime は JST の "HH:MM"（"00:00"・null は不明）。 */
export interface RaceScheduleObservation {
  readonly tenantId: number;
  readonly raceId: RaceId;
  readonly kubun: RaceDataKubun;
  readonly createdOn: string;
  readonly postTime: string | null;
  readonly raceName: string | null;
  readonly kai: number | null;
  readonly nichime: number | null;
  readonly observedAt: string;
  readonly source: ScheduleEventSource;
  readonly batchId: string | null;
}

function postAtOf(o: RaceScheduleObservation): string | null {
  if (o.postTime === null || o.postTime === "00:00") return null;
  const [h, m] = o.postTime.split(":").map(Number);
  const [y, mo, d] = o.raceId.date.split("-").map(Number);
  return new Date(Date.UTC(y ?? 0, (mo ?? 1) - 1, d ?? 1, (h ?? 0) - 9, m ?? 0)).toISOString();
}

function jstDateOf(iso: string): string {
  return new Date(Date.parse(iso) + 9 * 3_600_000).toISOString().slice(0, 10);
}

/** RaceScheduleUpdater の移植。 */
export class RaceScheduleUpdater {
  constructor(
    private readonly schedules: RaceScheduleRepository,
    private readonly events: ScheduleEventReader,
    private readonly clock: Clock,
  ) {}

  async apply(obs: RaceScheduleObservation): Promise<ApplyResult<RaceSchedule>> {
    if (!obs.kubun.handledByCalendar) return { kind: "Rejected", reason: "UNSUPPORTED_KUBUN" };
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const existing = await this.schedules.find(obs.tenantId, obs.raceId.value);
      const outcome = existing === null ? await this.insertNew(obs) : await this.updateExisting(existing, obs);
      if (outcome !== null) return outcome;
    }
    return { kind: "Conflict" };
  }

  applyTimeChange(tenantId: number, raceId: RaceId, newPostAt: string, observedAt: string, snapshotKey: string, batchId: string | null): Promise<ApplyResult<RaceSchedule>> {
    return this.changePostTime(tenantId, raceId, newPostAt, observedAt, snapshotKey, batchId, "TIME_CHANGE");
  }

  revokeTimeChange(tenantId: number, raceId: RaceId, restoredPostAt: string, observedAt: string, snapshotKey: string, batchId: string | null): Promise<ApplyResult<RaceSchedule>> {
    return this.changePostTime(tenantId, raceId, restoredPostAt, observedAt, snapshotKey, batchId, "REVOKED");
  }

  private async changePostTime(
    tenantId: number,
    raceId: RaceId,
    newPostAt: string,
    observedAt: string,
    snapshotKey: string,
    batchId: string | null,
    type: ScheduleEventType,
  ): Promise<ApplyResult<RaceSchedule>> {
    if (jstDateOf(newPostAt) !== raceId.date) return { kind: "Rejected", reason: "POST_TIME_DATE_MISMATCH" };
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const existing = await this.schedules.find(tenantId, raceId.value);
      if (existing === null) return { kind: "Rejected", reason: "RACE_NOT_FOUND" };
      if (!RaceScheduleTransitions.acceptsPostTimeChange(existing.status)) return { kind: "Rejected", reason: "TIME_CHANGE_NOT_ACCEPTED" };
      if (existing.scheduledPostAt === newPostAt && !existing.postTimeUnknown) return { kind: "NoChange", reason: "NO_EFFECTIVE_CHANGE" };
      const observed = (await this.events.eventsOfRace(tenantId, raceId.value))
        .filter((e) => e.type === "ADDED" || e.type === "TIME_CHANGE" || e.type === "REVOKED")
        .map((e) => e.observedAt)
        .sort();
      const lastObserved = observed[observed.length - 1];
      if (lastObserved !== undefined && Date.parse(observedAt) < Date.parse(lastObserved)) return { kind: "Rejected", reason: "OLDER_OBSERVATION" };
      const now = this.clock.now().toISOString();
      const updated: RaceSchedule = { ...existing, scheduledPostAt: newPostAt, postTimeUnknown: false, lastChangedAt: now };
      const event = await createEvent({
        tenantId,
        raceId: raceId.value,
        raceDate: raceId.date,
        type,
        oldValue: eventJson({ post_at: existing.scheduledPostAt }),
        newValue: eventJson({ post_at: newPostAt }),
        source: "0B14",
        observedAt,
        receivedAt: now,
        dedupGroup: snapshotKey,
        batchId,
      });
      const r = await this.schedules.update(updated, event);
      if (r.kind === "Applied") return { kind: "Applied", value: r.value, event: r.event };
      if (r.kind === "Duplicate") return { kind: "NoChange", reason: "DUPLICATE_EVENT" };
      if (r.kind === "NotFound") return { kind: "Rejected", reason: "RACE_NOT_FOUND" };
    }
    return { kind: "Conflict" };
  }

  private async insertNew(obs: RaceScheduleObservation): Promise<ApplyResult<RaceSchedule> | null> {
    if (obs.kubun.name === "DELETED") return { kind: "NoChange", reason: "NOTHING_TO_DELETE" };
    const postAt = obs.kubun.name === "CARD" ? postAtOf(obs) : null;
    const status: RaceScheduleStatus = obs.kubun.name === "CANCELLED" ? "CANCELLED" : obs.kubun.name === "CARD" && postAt !== null ? "CARD" : "ANNOUNCED";
    const now = this.clock.now().toISOString();
    const version = encodeVersion({ createdOn: obs.createdOn, kubun: obs.kubun });
    const schedule: RaceSchedule = {
      tenantId: obs.tenantId,
      raceId: obs.raceId.value,
      kai: obs.kai,
      nichime: obs.nichime,
      scheduledPostAt: postAt,
      postTimeUnknown: postAt === null,
      status,
      dataKubun: obs.kubun.code,
      sourceVersion: version,
      raceName: obs.raceName?.slice(0, 100) ?? null,
      lastChangedAt: now,
      version: 0,
    };
    const event = await createEvent({
      tenantId: obs.tenantId,
      raceId: obs.raceId.value,
      raceDate: obs.raceId.date,
      type: status === "CANCELLED" ? "CANCELLED" : "ADDED",
      oldValue: null,
      newValue: eventJson({ status, post_at: postAt, source_version: version }),
      source: obs.source,
      observedAt: obs.observedAt,
      receivedAt: now,
      dedupGroup: version,
      batchId: obs.batchId,
    });
    const r = await this.schedules.insertIfAbsent(schedule, event);
    if (r.kind === "Applied") return { kind: "Applied", value: r.value, event: r.event };
    if (r.kind === "Duplicate") return { kind: "NoChange", reason: "DUPLICATE_EVENT" };
    if (r.kind === "AlreadyExists") return null;
    throw new Error(`insertIfAbsent returned ${r.kind}`);
  }

  private async updateExisting(existing: RaceSchedule, obs: RaceScheduleObservation): Promise<ApplyResult<RaceSchedule> | null> {
    const stored = parseVersion(existing.sourceVersion);
    if (stored === null) return { kind: "Rejected", reason: "UNPARSEABLE_STORED_VERSION" };
    const incoming: SourceVersion = { createdOn: obs.createdOn, kubun: obs.kubun };
    const order = compareVersion(incoming, stored);
    if (order === "OLDER") return { kind: "Rejected", reason: "OLDER_SOURCE_VERSION" };
    if (order === "UNDECIDABLE") return { kind: "Rejected", reason: "UNDECIDABLE_SOURCE_VERSION" };
    if (order === "SAME") {
      const expectsTime = obs.kubun.name === "CARD";
      const same = !expectsTime || existing.scheduledPostAt === postAtOf(obs);
      return same ? { kind: "NoChange", reason: "DUPLICATE_VERSION" } : { kind: "Rejected", reason: "SAME_VERSION_DIFFERENT_CONTENT" };
    }
    const observedPostAt = obs.kubun.name === "CARD" ? postAtOf(obs) : null;
    let targetStatus: RaceScheduleStatus;
    if (obs.kubun.name === "CANCELLED") targetStatus = "CANCELLED";
    else if (obs.kubun.name === "DELETED") targetStatus = "DELETED";
    else if (obs.kubun.name === "CARD") targetStatus = existing.status === "ANNOUNCED" && observedPostAt !== null ? "CARD" : existing.status;
    else targetStatus = existing.status;
    if (targetStatus !== existing.status && !RaceScheduleTransitions.canTransition(existing.status, targetStatus)) {
      return { kind: "Rejected", reason: "INVALID_TRANSITION" };
    }
    if (targetStatus === existing.status && RaceScheduleTransitions.isTerminal(existing.status) && (obs.kubun.name === "ANNOUNCEMENT" || obs.kubun.name === "CARD")) {
      return { kind: "Rejected", reason: "INVALID_TRANSITION" };
    }
    const timeAccepted = obs.kubun.name === "CARD" && RaceScheduleTransitions.acceptsPostTimeChange(existing.status);
    const newPostAt = timeAccepted ? observedPostAt : existing.scheduledPostAt;
    const newUnknown = timeAccepted ? observedPostAt === null : existing.postTimeUnknown;
    const timeChanged = newPostAt !== existing.scheduledPostAt || newUnknown !== existing.postTimeUnknown;
    let type: ScheduleEventType | null = null;
    if (targetStatus === "CANCELLED" && existing.status !== "CANCELLED") type = "CANCELLED";
    else if (targetStatus === "DELETED" && existing.status !== "DELETED") type = "DELETED";
    else if (timeChanged) type = "TIME_CHANGE";
    if (type === null) {
      return targetStatus !== existing.status ? { kind: "Rejected", reason: "UNRECORDABLE_CHANGE" } : { kind: "NoChange", reason: "NO_EFFECTIVE_CHANGE" };
    }
    const now = this.clock.now().toISOString();
    const version = encodeVersion(incoming);
    const updated: RaceSchedule = {
      ...existing,
      scheduledPostAt: newPostAt,
      postTimeUnknown: newUnknown,
      status: targetStatus,
      dataKubun: obs.kubun.code,
      sourceVersion: version,
      raceName: obs.raceName?.slice(0, 100) ?? existing.raceName,
      kai: existing.kai ?? obs.kai,
      nichime: existing.nichime ?? obs.nichime,
      lastChangedAt: now,
    };
    const event = await createEvent({
      tenantId: obs.tenantId,
      raceId: obs.raceId.value,
      raceDate: obs.raceId.date,
      type,
      oldValue: eventJson({ status: existing.status, post_at: existing.scheduledPostAt, source_version: existing.sourceVersion }),
      newValue: eventJson({ status: targetStatus, post_at: newPostAt, source_version: version }),
      source: obs.source,
      observedAt: obs.observedAt,
      receivedAt: now,
      dedupGroup: version,
      batchId: obs.batchId,
    });
    const r = await this.schedules.update(updated, event);
    if (r.kind === "Applied") return { kind: "Applied", value: r.value, event: r.event };
    if (r.kind === "Duplicate") return { kind: "NoChange", reason: "DUPLICATE_EVENT" };
    if (r.kind === "Conflict" || r.kind === "NotFound") return null;
    throw new Error("update returned AlreadyExists");
  }
}

const PROGRESSED: readonly RaceDayStatus[] = ["RUNNING", "SETTLING", "COMPLETED", "INCOMPLETE"];

/** RaceDayUpdater の移植。 */
export class RaceDayUpdater {
  constructor(
    private readonly days: RaceDayRepository,
    private readonly clock: Clock,
  ) {}

  async apply(p: {
    tenantId: number;
    date: string;
    venue: string;
    kai: number;
    nichime: number;
    target: RaceDayStatus;
    replacedByDate: string | null;
    observedAt: string;
    source: ScheduleEventSource;
    dedupGroup: string;
  }): Promise<ApplyResult<RaceDay>> {
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const existing = await this.days.find(p.tenantId, p.date, p.venue);
      const now = this.clock.now().toISOString();
      let outcome: ApplyResult<RaceDay> | null;
      if (existing === null) {
        if (!RaceDayTransitions.initialStatuses.includes(p.target)) return { kind: "Rejected", reason: "INVALID_INITIAL_STATUS" };
        const day: RaceDay = {
          tenantId: p.tenantId,
          raceDate: p.date,
          venue: p.venue,
          kai: p.kai,
          nichime: p.nichime,
          status: p.target,
          replacedByDate: p.target === "POSTPONED" ? p.replacedByDate : null,
          firstSeenAt: now,
          lastConfirmedAt: p.observedAt,
          version: 0,
        };
        const r = await this.days.insertIfAbsent(day, await this.event(p.tenantId, p.date, p.venue, null, p.target, p.observedAt, now, p.source, p.dedupGroup, p.replacedByDate));
        if (r.kind === "Applied") outcome = { kind: "Applied", value: r.value, event: r.event };
        else if (r.kind === "Duplicate") outcome = { kind: "NoChange", reason: "DUPLICATE_EVENT" };
        else if (r.kind === "AlreadyExists") outcome = null;
        else throw new Error(`insertIfAbsent returned ${r.kind}`);
      } else {
        if (p.kai !== existing.kai || p.nichime !== existing.nichime) throw new KaiNichimeChangedError();
        outcome = await this.updateExisting(existing, p.target, p.replacedByDate, p.observedAt, now, p.source, p.dedupGroup);
      }
      if (outcome !== null) return outcome;
    }
    return { kind: "Conflict" };
  }

  /** 開催日の進行（RUNNING → SETTLING → COMPLETED / INCOMPLETE）。last_confirmed_at は変えない。 */
  async advance(tenantId: number, date: string, venue: string, target: RaceDayStatus, dedupGroup: string): Promise<ApplyResult<RaceDay>> {
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const existing = await this.days.find(tenantId, date, venue);
      if (existing === null || existing.status === target) return { kind: "NoChange", reason: "NO_EFFECTIVE_CHANGE" };
      if (!RaceDayTransitions.canTransition(existing.status, target)) return { kind: "Rejected", reason: "INVALID_TRANSITION" };
      const now = this.clock.now().toISOString();
      const r = await this.days.update({ ...existing, status: target }, await this.event(tenantId, date, venue, existing.status, target, now, now, "SYSTEM", dedupGroup, null));
      if (r.kind === "Applied") return { kind: "Applied", value: r.value, event: r.event };
      if (r.kind === "Duplicate") return { kind: "NoChange", reason: "DUPLICATE_EVENT" };
    }
    return { kind: "Conflict" };
  }

  confirm(tenantId: number, date: string, venue: string, observedAt: string): Promise<boolean> {
    return this.days.confirm(tenantId, date, venue, observedAt);
  }

  private async updateExisting(
    existing: RaceDay,
    target: RaceDayStatus,
    replacedByDate: string | null,
    observedAt: string,
    now: string,
    source: ScheduleEventSource,
    dedupGroup: string,
  ): Promise<ApplyResult<RaceDay> | null> {
    if (target === "CONFIRMED" && PROGRESSED.includes(existing.status)) {
      await this.days.confirm(existing.tenantId, existing.raceDate, existing.venue, observedAt);
      return { kind: "NoChange", reason: "CONFIRMED_ONLY" };
    }
    const statusChanged = target !== existing.status;
    const refines = !statusChanged && target === "POSTPONED" && existing.replacedByDate === null && replacedByDate !== null;
    if (!statusChanged && !refines) {
      await this.days.confirm(existing.tenantId, existing.raceDate, existing.venue, observedAt);
      return { kind: "NoChange", reason: "CONFIRMED_ONLY" };
    }
    if (statusChanged && !RaceDayTransitions.canTransition(existing.status, target)) return { kind: "Rejected", reason: "INVALID_TRANSITION" };
    if (existing.lastConfirmedAt !== null && Date.parse(observedAt) < Date.parse(existing.lastConfirmedAt)) return { kind: "Rejected", reason: "OLDER_OBSERVATION" };
    const updated: RaceDay = { ...existing, status: target, replacedByDate: target === "POSTPONED" ? replacedByDate : null, lastConfirmedAt: observedAt };
    const r = await this.days.update(updated, await this.event(existing.tenantId, existing.raceDate, existing.venue, existing.status, target, observedAt, now, source, dedupGroup, replacedByDate));
    if (r.kind === "Applied") return { kind: "Applied", value: r.value, event: r.event };
    if (r.kind === "Duplicate") return { kind: "NoChange", reason: "DUPLICATE_EVENT" };
    if (r.kind === "Conflict" || r.kind === "NotFound") return null;
    throw new Error("update returned AlreadyExists");
  }

  private event(
    tenantId: number,
    date: string,
    venue: string,
    from: RaceDayStatus | null,
    to: RaceDayStatus,
    observedAt: string,
    now: string,
    source: ScheduleEventSource,
    dedupGroup: string,
    replacedByDate: string | null,
  ): Promise<ScheduleEvent> {
    return createEvent({
      tenantId,
      raceId: null,
      raceDate: date,
      type: to === "POSTPONED" ? "POSTPONED" : "DAY_STATUS",
      oldValue: from === null ? null : eventJson({ status: from, venue }),
      newValue: eventJson({ status: to, venue, replaced_by: replacedByDate }),
      source,
      observedAt,
      receivedAt: now,
      dedupGroup,
    });
  }
}

/** 開催回・日目が既存の行と違う（Kotlin の require 違反 = IllegalArgumentException）。 */
export class KaiNichimeChangedError extends Error {
  constructor() {
    super("開催回・日目は変更できない（別の開催日の行）");
    this.name = "KaiNichimeChangedError";
  }
}

// ---- 手動補正 ----
export type OverrideScope = "DAY" | "RACE";
export type OverrideAction = "MARK_RACE_DAY" | "MARK_NO_RACE" | "CANCEL" | "SET_POST_TIME" | "POSTPONE_TO" | "ALLOW_RUN" | "DENY_RUN";
export const OVERRIDE_SCOPES: Readonly<Record<OverrideAction, readonly OverrideScope[]>> = {
  MARK_RACE_DAY: ["DAY"],
  MARK_NO_RACE: ["DAY"],
  CANCEL: ["DAY", "RACE"],
  SET_POST_TIME: ["RACE"],
  POSTPONE_TO: ["DAY"],
  ALLOW_RUN: ["DAY"],
  DENY_RUN: ["DAY"],
};
export function isOverrideAction(v: string): v is OverrideAction {
  return Object.hasOwn(OVERRIDE_SCOPES, v);
}

export interface CalendarOverride {
  readonly tenantId: number;
  readonly id: number | null;
  readonly scope: OverrideScope;
  readonly raceDate: string;
  readonly raceId: string | null;
  readonly action: OverrideAction;
  /** SET_POST_TIME は {"post_at": ISO}、POSTPONE_TO は {"to": YYYY-MM-DD}、それ以外は null。 */
  readonly value: string | null;
  readonly reason: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly validUntil: string | null;
  readonly revokedAt: string | null;
  readonly revokedBy: string | null;
}

/** CalendarOverride の init の検査（不正なら理由を返す）。 */
export function validateOverride(o: CalendarOverride): string | null {
  if ((o.scope === "RACE") !== (o.raceId !== null)) return "RACE の補正だけが raceId を持つ";
  if (o.raceId !== null && parseRaceId(o.raceId)?.date !== o.raceDate) return "raceDate が raceId の日付と一致しない";
  if (!OVERRIDE_SCOPES[o.action].includes(o.scope)) return `${o.action} は ${o.scope} には使えない`;
  if (o.action === "SET_POST_TIME") {
    const at = overridePostAt(o);
    if (at === null) return "SET_POST_TIME は post_at が必須";
    if (jstDateOf(at) !== o.raceDate) return "発走時刻の日付（JST）が開催日と違う";
  } else if (o.action === "POSTPONE_TO") {
    const to = overridePostponedTo(o);
    if (to === null) return "POSTPONE_TO は延期先の日付が必須";
    if (!(to > o.raceDate)) return "延期先は開催日より後";
  } else if (o.value !== null) {
    return `${o.action} は value を持たない`;
  }
  const r = o.reason;
  if (r.trim().length === 0 || r.length > 500) return "reason は 1〜500 文字（空白のみは不可）";
  if (!validActor(o.createdBy)) return "createdBy が不正";
  return null;
}

export function validActor(s: string): boolean {
  // eslint-disable-next-line no-control-regex
  return s.trim().length > 0 && s.length <= 254 && !/[\u0000-\u001f\u007f-\u009f]/.test(s);
}

export function overridePostAt(o: CalendarOverride): string | null {
  if (o.value === null) return null;
  const m = /^\{\s*"post_at"\s*:\s*"([^"\\]+)"\s*}$/.exec(o.value.trim());
  const v = m?.[1];
  return v !== undefined && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null;
}
export function overridePostponedTo(o: CalendarOverride): string | null {
  if (o.value === null) return null;
  const m = /^\{\s*"to"\s*:\s*"([^"\\]+)"\s*}$/.exec(o.value.trim());
  const v = m?.[1];
  return v !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}
export function isOverrideActiveAt(o: CalendarOverride, now: Date): boolean {
  return o.revokedAt === null && (o.validUntil === null || now.getTime() < Date.parse(o.validUntil));
}

// ---- 有効な予定（EffectiveCalendar）----
export type DayVerdict = "CONFIRMED" | "NO_RACE_CONFIRMED" | "UNKNOWN" | "STALE" | "UNCONFIRMED" | "CANCELLED" | "POSTPONED";
export type DayProgress = "NOT_STARTED" | "RUNNING" | "SETTLING" | "COMPLETED" | "INCOMPLETE";

export interface EffectiveRace {
  readonly raceId: string;
  readonly status: RaceScheduleStatus;
  readonly postAt: string | null;
  readonly cancelledByManual: boolean;
  readonly postTimeByManual: boolean;
  readonly inWindow: boolean;
}

export interface EffectiveDay {
  readonly date: string;
  readonly verdict: DayVerdict;
  readonly basis: "SOURCE" | "MANUAL";
  readonly progress: DayProgress;
  readonly races: readonly EffectiveRace[];
  readonly firstPost: string | null;
  readonly lastPost: string | null;
  readonly denyRun: boolean;
  readonly allowRun: boolean;
  readonly postponedTo: string | null;
  readonly conflicts: readonly { readonly kind: string; readonly overrideId: number | null }[];
  readonly staleVenues: readonly string[];
}

/** 予定が古いとみなすまでの時間（ReadApi.STALE_AFTER_MINUTES と同じ 120 分）。 */
export const STALE_AFTER_MS = 120 * 60_000;

function isFresh(confirmedAt: string | null, now: Date, staleAfterMs: number): boolean {
  if (confirmedAt === null) return false;
  const age = now.getTime() - Date.parse(confirmedAt);
  return age < 0 || age <= staleAfterMs;
}

/** EffectiveCalendar.derive の移植（fetchFact = その日の予定の取得を最後に確認した時刻。無ければ null）。 */
export function deriveEffectiveDay(
  date: string,
  now: Date,
  days: readonly RaceDay[],
  races: readonly RaceSchedule[],
  overrides: readonly CalendarOverride[],
  fetchFactAt: string | null,
  staleAfterMs = STALE_AFTER_MS,
): EffectiveDay {
  const active = overrides
    .filter((o) => isOverrideActiveAt(o, now))
    .sort((a, b) => (a.createdAt === b.createdAt ? (a.id ?? Number.MAX_SAFE_INTEGER) - (b.id ?? Number.MAX_SAFE_INTEGER) : a.createdAt < b.createdAt ? -1 : 1));
  // 場ごとの判定
  const venues = [...new Set([...days.map((d) => d.venue), ...races.map((r) => r.raceId.slice(8, 10))])].sort();
  const verdicts = new Map<string, "CONFIRMED" | "STALE" | "UNCONFIRMED" | "CANCELLED" | "POSTPONED">();
  for (const venue of venues) {
    const day = days.find((d) => d.venue === venue);
    const mine = races.filter((r) => r.raceId.slice(8, 10) === venue && r.status !== "DELETED");
    const activeRaces = mine.filter((r) => RaceScheduleTransitions.isActive(r.status));
    const finished = day?.status === "COMPLETED" || day?.status === "INCOMPLETE";
    const fresh = finished || isFresh(day?.lastConfirmedAt ?? null, now, staleAfterMs);
    let v: "CONFIRMED" | "STALE" | "UNCONFIRMED" | "CANCELLED" | "POSTPONED";
    if (day?.status === "POSTPONED") v = "POSTPONED";
    else if (day?.status === "CANCELLED") v = "CANCELLED";
    else if (activeRaces.length === 0 && mine.length > 0) v = "CANCELLED";
    else if (!fresh) v = "STALE";
    else if (activeRaces.some((r) => RaceScheduleTransitions.hasCard(r.status) && !r.postTimeUnknown && r.scheduledPostAt !== null)) v = "CONFIRMED";
    else v = "UNCONFIRMED";
    verdicts.set(venue, v);
  }
  const confirmed = [...verdicts].filter(([, v]) => v === "CONFIRMED").map(([k]) => k);
  const stale = [...verdicts].filter(([, v]) => v === "STALE").map(([k]) => k);
  const vals = [...verdicts.values()];
  let sourceVerdict: DayVerdict;
  if (confirmed.length > 0) sourceVerdict = "CONFIRMED";
  else if (stale.length > 0) sourceVerdict = "STALE";
  else if (vals.includes("UNCONFIRMED")) sourceVerdict = "UNCONFIRMED";
  else if (vals.includes("CANCELLED")) sourceVerdict = "CANCELLED";
  else if (vals.includes("POSTPONED")) sourceVerdict = "POSTPONED";
  else if (fetchFactAt === null) sourceVerdict = "UNKNOWN";
  else if (isFresh(fetchFactAt, now, staleAfterMs)) sourceVerdict = "NO_RACE_CONFIRMED";
  else sourceVerdict = "STALE";
  let postponedTo: string | null =
    sourceVerdict === "POSTPONED"
      ? (days
          .filter((d) => d.status === "POSTPONED")
          .map((d) => d.replacedByDate)
          .filter((d): d is string => d !== null)
          .sort()[0] ?? null)
      : null;
  const racing = days.filter((d) => confirmed.includes(d.venue)).map((d) => d.status);
  let progress: DayProgress = "NOT_STARTED";
  if (racing.includes("RUNNING")) progress = "RUNNING";
  else if (racing.includes("SETTLING")) progress = "SETTLING";
  else if (racing.length > 0 && racing.every((s) => s === "COMPLETED" || s === "INCOMPLETE")) progress = racing.includes("INCOMPLETE") ? "INCOMPLETE" : "COMPLETED";

  const denyRun = active.some((o) => o.action === "DENY_RUN");
  const allowRun = active.some((o) => o.action === "ALLOW_RUN");
  const dayOverrides = active.filter((o) => o.scope === "DAY");
  const last = <T>(xs: readonly T[], p: (x: T) => boolean): T | undefined => [...xs].reverse().find(p);
  const tierA = last(dayOverrides, (o) => o.action === "CANCEL" || o.action === "MARK_NO_RACE");
  const tierB = last(dayOverrides, (o) => o.action === "MARK_RACE_DAY" || o.action === "POSTPONE_TO");
  const manual = tierA ?? tierB;
  let verdict = sourceVerdict;
  let basis: "SOURCE" | "MANUAL" = "SOURCE";
  const conflicts: { kind: string; overrideId: number | null }[] = [];
  if (manual !== undefined) {
    basis = "MANUAL";
    const hasRaces = sourceVerdict === "CONFIRMED";
    const hasNoRace = sourceVerdict === "NO_RACE_CONFIRMED" || sourceVerdict === "CANCELLED" || sourceVerdict === "POSTPONED";
    if (manual.action === "CANCEL") verdict = "CANCELLED";
    else if (manual.action === "MARK_NO_RACE") verdict = "NO_RACE_CONFIRMED";
    else if (manual.action === "POSTPONE_TO") {
      verdict = "POSTPONED";
      postponedTo = overridePostponedTo(manual);
    } else verdict = "CONFIRMED";
    if (manual.action === "MARK_RACE_DAY") {
      if (hasNoRace) conflicts.push({ kind: "MANUAL_RACE_DAY_BUT_SOURCE_HAS_NO_RACE", overrideId: manual.id });
    } else if (hasRaces) {
      conflicts.push({ kind: "MANUAL_NO_RACE_BUT_SOURCE_HAS_RACES", overrideId: manual.id });
    }
  }
  const raceOverrides = active.filter((o) => o.scope === "RACE");
  const trustAll = manual?.action === "MARK_RACE_DAY" || allowRun;
  const effectiveRaces: EffectiveRace[] = races
    .filter((r) => r.status !== "DELETED")
    .sort((a, b) => (a.raceId < b.raceId ? -1 : a.raceId > b.raceId ? 1 : 0))
    .map((race) => {
      const mine = raceOverrides.filter((o) => o.raceId === race.raceId);
      const cancelledByManual = mine.some((o) => o.action === "CANCEL");
      const manualOverride = last(mine, (o) => o.action === "SET_POST_TIME");
      const manualTime = manualOverride === undefined ? null : overridePostAt(manualOverride);
      const status: RaceScheduleStatus = cancelledByManual ? "CANCELLED" : race.status;
      const sourceTime = RaceScheduleTransitions.hasCard(race.status) && !race.postTimeUnknown ? race.scheduledPostAt : null;
      const postAt = cancelledByManual ? null : (manualTime ?? sourceTime);
      const usableVenue = trustAll || confirmed.includes(race.raceId.slice(8, 10));
      return {
        raceId: race.raceId,
        status,
        postAt,
        cancelledByManual,
        postTimeByManual: !cancelledByManual && manualTime !== null,
        inWindow: RaceScheduleTransitions.isActive(status) && postAt !== null && usableVenue,
      };
    });
  const windowTimes = effectiveRaces
    .filter((r) => r.inWindow)
    .map((r) => r.postAt)
    .filter((t): t is string => t !== null)
    .sort();
  return {
    date,
    verdict,
    basis,
    progress,
    races: effectiveRaces,
    firstPost: windowTimes[0] ?? null,
    lastPost: windowTimes[windowTimes.length - 1] ?? null,
    denyRun,
    allowRun,
    postponedTo,
    conflicts,
    staleVenues: stale,
  };
}
