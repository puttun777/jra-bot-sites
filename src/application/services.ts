/**
 * アプリケーション層（業務処理の組み立て）。プラットフォーム（D1 / node:sqlite・Sites / ローカル）に依存しない。
 * 移植元: jra-bot-web の domain/ingest/BatchIngestor.kt・PendingReplayer.kt（取込）、domain/botrun/RaceEvaluator.kt・
 * RaceCycleProcessor.kt（判定の実行）、domain/performance/PerformanceReadService.kt（成績）、dashboard ReadApi（状態）。
 */
import {
  createEvent,
  deriveEffectiveDay,
  STALE_AFTER_MS,
  eventJson,
  RaceDayUpdater,
  RaceScheduleUpdater,
  validActor,
  validateOverride,
  type CalendarOverride,
  type EffectiveDay,
  type OverrideAction,
  type OverrideScope,
} from "../domain/calendar.js";
import {
  evaluateOdds,
  RECOMMENDED_DECISION_CONFIG,
  RECOMMENDED_HIT_RATE_SCHEDULE,
  resolveHitRateMinEv,
  type DecisionConfig,
  type DecisionSignal,
} from "../domain/analysis/decision.js";
import type { OddsEntry } from "../domain/analysis/betStrategy.js";
import { IngestRetryableError, ObservationApplier, parseNormalizedRecord, REASON_RACE_NOT_FOUND, type ApplyOutcome } from "../domain/ingest.js";
import { displayedTickets } from "../domain/notify.js";
import { comboKeyOf, settleCombo, settleWin, summarizeCombos, summarizeWin, type SettledCombo, type SettledSignal } from "../domain/performance.js";
import { addDays, daysBetween, jstDate, parseRaceId, sha256Hex, uuid, type Clock, type Market } from "../domain/race.js";
import type { SqlDatabase } from "../infrastructure/db/sql.js";
import {
  AccessRepo,
  AgentRepo,
  BotRunRepo,
  EvaluationRepo,
  IngestRepo,
  MarketDataRepo,
  OverrideRepo,
  RaceDayRepo,
  RaceScheduleRepo,
  ScheduleEventRepo,
  SignalRepo,
  type BotRun,
} from "../infrastructure/repositories.js";

export const TENANT_ID = 1;

export interface Services {
  readonly db: SqlDatabase;
  readonly clock: Clock;
  readonly events: ScheduleEventRepo;
  readonly days: RaceDayRepo;
  readonly schedules: RaceScheduleRepo;
  readonly market: MarketDataRepo;
  readonly signals: SignalRepo;
  readonly evaluations: EvaluationRepo;
  readonly overrides: OverrideRepo;
  readonly runs: BotRunRepo;
  readonly agents: AgentRepo;
  readonly ingest: IngestRepo;
  readonly access: AccessRepo;
  readonly dayUpdater: RaceDayUpdater;
  readonly scheduleUpdater: RaceScheduleUpdater;
  readonly applier: ObservationApplier;
}

export function createServices(db: SqlDatabase, clock: Clock): Services {
  const events = new ScheduleEventRepo(db);
  const days = new RaceDayRepo(db, events);
  const schedules = new RaceScheduleRepo(db, events);
  const market = new MarketDataRepo(db);
  const dayUpdater = new RaceDayUpdater(days, clock);
  const scheduleUpdater = new RaceScheduleUpdater(schedules, events, clock);
  const applier = new ObservationApplier({
    raceDays: days,
    dayUpdater,
    scheduleUpdater,
    races: { exists: (t, r) => market.exists(t, r), upsertMinimal: (t, r, k, n, p, name) => market.upsertMinimal(t, r, k, n, p, name) },
    odds: { upsertWin: (t, r, at, e) => market.upsertWin(t, r, at, e) },
    combos: { upsert: (t, r, m, at, rows, src) => market.upsertCombos(t, r, m, at, rows, src) },
    results: { upsertAll: (t, r, e) => market.upsertResults(t, r, e) },
    payouts: { upsertAll: (t, r, m, rows, p) => market.upsertPayouts(t, r, m, rows, p) },
  });
  return {
    db,
    clock,
    events,
    days,
    schedules,
    market,
    signals: new SignalRepo(db),
    evaluations: new EvaluationRepo(db),
    overrides: new OverrideRepo(db, events),
    runs: new BotRunRepo(db),
    agents: new AgentRepo(db),
    ingest: new IngestRepo(db),
    access: new AccessRepo(db),
    dayUpdater,
    scheduleUpdater,
    applier,
  };
}

// =====================================================================
// 取込（BatchIngestor の移植）
// =====================================================================
export interface IngestRecordIn {
  readonly id: string;
  /** 正規化 JSON（文字列）。 */
  readonly payload: string;
}
export interface IngestEnvelope {
  readonly batchId: string;
  /** 取得元（例: "chatgpt"・"csv-import"・"jra-web"）。ingest_batch.dataspec に入る（16 文字以内）。 */
  readonly source: string;
  /** データを観測した（取得した）時刻。オッズの時系列の時刻になる。 */
  readonly observedAt: string;
  readonly records: readonly IngestRecordIn[];
}
export interface IngestSummary {
  readonly batchId: string;
  readonly status: "COMPLETED" | "DUPLICATE_BATCH" | "FAILED";
  readonly records: number;
  readonly applied: number;
  readonly unchanged: number;
  readonly duplicates: number;
  readonly deferred: number;
  readonly rejected: number;
  readonly quarantined: number;
  readonly replayed: number;
  /** 不正・保留の理由（先頭 10 件まで。全件は返さない）。 */
  readonly issues: readonly { readonly seq: number; readonly outcome: string; readonly reason: string }[];
}

export const MAX_RECORDS_PER_BATCH = 200;

export class IngestConflictError extends Error {}

export async function ingestBatch(s: Services, agentId: string, env: IngestEnvelope): Promise<IngestSummary> {
  const now = s.clock.now();
  const payloadSha = await sha256Hex(["jra-bot/ingest-batch/v1", env.batchId, env.source, env.observedAt, ...env.records.map((r) => `${r.id}\u001f${r.payload}`)].join("\n"));
  const existing = await s.ingest.findBatch(TENANT_ID, env.batchId);
  if (existing !== null) {
    if (existing.payloadSha256 !== payloadSha) throw new IngestConflictError("同じ batchId で内容が違う");
    return { batchId: env.batchId, status: "DUPLICATE_BATCH", records: env.records.length, applied: 0, unchanged: 0, duplicates: env.records.length, deferred: 0, rejected: 0, quarantined: 0, replayed: 0, issues: [] };
  }
  await s.ingest.insertBatch(TENANT_ID, { batchId: env.batchId, agentId, batchClass: "S", dataspec: env.source.slice(0, 16), observedAt: env.observedAt, receivedAt: now.toISOString(), payloadSha256: payloadSha, recordCount: env.records.length });
  const counts = { applied: 0, unchanged: 0, duplicates: 0, deferred: 0, rejected: 0, quarantined: 0 };
  const issues: { seq: number; outcome: string; reason: string }[] = [];
  const touchedRaces = new Set<string>();
  for (const [seq, rec] of env.records.entries()) {
    // 観測時刻も含める: 同じ値のオッズでも時刻が違えば別の観測（時系列）。同じ時刻・同じ内容の再送だけを重複として数える
    const hash = await sha256Hex(`${env.observedAt}\u001f${rec.id}\u001f${rec.payload}`);
    const isNew = await s.ingest.insertRaw(TENANT_ID, { recordHash: hash, batchId: env.batchId, seq, dataspec: env.source.slice(0, 16), recordId: rec.id, payload: rec.payload, receivedAt: now.toISOString() });
    if (!isNew) {
      counts.duplicates++;
      continue;
    }
    const outcome = await applyRecord(s, hash, rec.id, rec.payload, { observedAt: env.observedAt, batchId: env.batchId, dataspec: env.source });
    tally(counts, outcome);
    if (outcome.kind === "Applied" || outcome.kind === "NoChange") {
      const p = parseNormalizedRecord(rec.id, rec.payload);
      if (p.kind === "Parsed") for (const o of p.observations) if (o.kind === "Race") touchedRaces.add(o.raceId.value);
    }
    if ((outcome.kind === "Deferred" || outcome.kind === "Quarantined" || outcome.kind === "Rejected") && issues.length < 10) issues.push({ seq, outcome: outcome.kind, reason: outcome.reason });
  }
  let replayed = 0;
  for (const raceId of touchedRaces) replayed += await replayPendingForRace(s, raceId);
  await s.ingest.completeBatch(TENANT_ID, env.batchId, env.records.length - counts.duplicates, counts.duplicates, "COMPLETED", null, s.clock.now().toISOString());
  return { batchId: env.batchId, status: "COMPLETED", records: env.records.length, ...counts, replayed, issues };
}

function tally(c: { applied: number; unchanged: number; deferred: number; rejected: number; quarantined: number }, o: ApplyOutcome): void {
  if (o.kind === "Applied") c.applied++;
  else if (o.kind === "NoChange") c.unchanged++;
  else if (o.kind === "Deferred") c.deferred++;
  else if (o.kind === "Rejected") c.rejected++;
  else c.quarantined++;
}

/** 生レコード 1 件を解析して適用し、ingest_raw の状態を更新する。 */
async function applyRecord(s: Services, hash: string, recordId: string, payload: string, ctx: { observedAt: string; batchId: string; dataspec: string }): Promise<ApplyOutcome> {
  const parsed = parseNormalizedRecord(recordId, payload);
  if (parsed.kind === "Unsupported") {
    await s.ingest.markRaw(TENANT_ID, hash, "PENDING", parsed.reason);
    return { kind: "Deferred", reason: parsed.reason };
  }
  if (parsed.kind === "Malformed") {
    await s.ingest.markRaw(TENANT_ID, hash, "FAILED", parsed.reason);
    return { kind: "Quarantined", reason: parsed.reason };
  }
  let last: ApplyOutcome = { kind: "NoChange" };
  for (const obs of parsed.observations) {
    let outcome: ApplyOutcome;
    try {
      outcome = await s.applier.apply(TENANT_ID, obs, ctx);
    } catch (e) {
      if (e instanceof IngestRetryableError) {
        await s.ingest.markRaw(TENANT_ID, hash, "PENDING", "RETRYABLE_CONFLICT");
        return { kind: "Deferred", reason: "RETRYABLE_CONFLICT" };
      }
      throw e;
    }
    if (outcome.kind === "Quarantined") {
      await s.ingest.markRaw(TENANT_ID, hash, "FAILED", outcome.reason);
      return outcome;
    }
    if (outcome.kind === "Deferred") {
      await s.ingest.markRaw(TENANT_ID, hash, "PENDING", outcome.reason);
      return outcome;
    }
    last = outcome;
  }
  await s.ingest.markRaw(TENANT_ID, hash, "PARSED", last.kind === "Rejected" ? last.reason : null);
  return last;
}

/** レース到着で、そのレース待ちの保留を再適用する（PendingReplayer）。 */
export async function replayPendingForRace(s: Services, raceId: string): Promise<number> {
  let n = 0;
  for (const p of await s.ingest.pendingForRace(TENANT_ID, raceId, 500)) {
    const o = await applyRecord(s, p.recordHash, p.recordId, p.payload, { observedAt: p.observedAt, batchId: p.batchId, dataspec: p.dataspec });
    if (o.kind !== "Deferred") n++;
  }
  return n;
}

/** 全保留の再適用（手動の「取得失敗の再実行」）。 */
export async function replayAllPending(s: Services, limit = 500): Promise<{ attempted: number; resolved: number; stillPending: number }> {
  const all = await s.ingest.allPending(TENANT_ID, limit);
  let resolved = 0;
  for (const p of all) {
    const o = await applyRecord(s, p.recordHash, p.recordId, p.payload, { observedAt: p.observedAt, batchId: p.batchId, dataspec: p.dataspec });
    if (o.kind !== "Deferred") resolved++;
  }
  return { attempted: all.length, resolved, stillPending: all.length - resolved };
}

// =====================================================================
// 判定の実行（RaceEvaluator / RaceCycleProcessor の移植・Sites 向けに有限ジョブ化）
// =====================================================================
export interface AnalysisOptions {
  readonly date?: string;
  readonly raceId?: string;
  readonly trigger: BotRun["trigger"];
  readonly actor: string;
  readonly config?: DecisionConfig;
}
export type RaceAnalysisStatus = "ANALYZED" | "NO_ODDS" | "PAST_POST" | "NOT_IN_WINDOW" | "ALREADY_EVALUATED" | "ERROR";
export interface RaceAnalysisResult {
  readonly raceId: string;
  readonly status: RaceAnalysisStatus;
  readonly signals: number;
  readonly bestEv: number | null;
  readonly note: string | null;
}
export interface AnalysisSummary {
  readonly runId: string | null;
  readonly date: string;
  readonly state: "SUCCEEDED" | "FAILED" | "STOPPED_BY_MODE" | "ALREADY_RUNNING" | "NOTHING_TO_DO";
  readonly races: readonly RaceAnalysisResult[];
  readonly message: string;
}

/** 実行のリース（Sites の 1 リクエストの実行時間は未確認。既定 5 分で、落ちた実行は期限切れで回収する）。 */
export const RUN_LEASE_MS = 5 * 60_000;
/** 通知スナップショットの形式（Sites 版の独自形式。docs/DATABASE.md §4）。 */
export const NOTICE_SCHEMA = 101;

export async function runAnalysis(s: Services, opt: AnalysisOptions): Promise<AnalysisSummary> {
  const now = s.clock.now();
  const nowIso = now.toISOString();
  let date = opt.date ?? jstDate(now);
  if (opt.raceId !== undefined) {
    const id = parseRaceId(opt.raceId);
    if (id === null) throw new Error("raceId が不正");
    date = id.date;
  }
  const mode = await s.access.mode(TENANT_ID);
  if (mode !== "NORMAL") {
    const runId = uuid();
    await s.runs.record(TENANT_ID, runId, date, opt.trigger, "STOPPED_BY_MODE", `MODE_${mode}`, now);
    return { runId, date, state: "STOPPED_BY_MODE", races: [], message: "運用モードが停止中のため実行しませんでした。" };
  }
  const runId = uuid();
  const lease = await s.runs.tryStart(TENANT_ID, runId, date, opt.trigger, opt.actor, now, RUN_LEASE_MS);
  if (lease === null) return { runId: null, date, state: "ALREADY_RUNNING", races: [], message: "同じ日の実行が進行中です（重複実行を防止しました）。" };
  const results: RaceAnalysisResult[] = [];
  try {
    const day = await effectiveDay(s, date, now);
    let targets = day.races.filter((r) => r.status !== "CANCELLED");
    if (opt.raceId !== undefined) targets = targets.filter((r) => r.raceId === opt.raceId);
    if (day.denyRun && opt.trigger === "SCHEDULER") {
      await s.runs.finish(TENANT_ID, runId, "SUCCEEDED", "DENY_RUN", null, s.clock.now());
      return { runId, date, state: "NOTHING_TO_DO", races: [], message: "手動補正（実行を禁止）により実行しませんでした。" };
    }
    for (const race of targets) results.push(await analyzeRace(s, runId, race.raceId, race.postAt, race.inWindow || opt.raceId !== undefined, now, opt.config ?? RECOMMENDED_DECISION_CONFIG));
    const failed = results.filter((r) => r.status === "ERROR").length;
    await s.runs.finish(TENANT_ID, runId, failed > 0 ? "FAILED" : "SUCCEEDED", failed > 0 ? `RACE_ERRORS:${failed}` : null, JSON.stringify({ analyzed: results.filter((r) => r.status === "ANALYZED").length }), s.clock.now());
    const analyzed = results.filter((r) => r.status === "ANALYZED").length;
    return {
      runId,
      date,
      state: failed > 0 ? "FAILED" : results.length === 0 ? "NOTHING_TO_DO" : "SUCCEEDED",
      races: results,
      message: results.length === 0 ? "対象のレースがありません（予定未取得・中止を含む）。" : `判定 ${analyzed} レース / 対象 ${results.length} レース（${nowIso}）`,
    };
  } catch (e) {
    await s.runs.finish(TENANT_ID, runId, "FAILED", e instanceof Error ? e.name : "ERROR", null, s.clock.now());
    throw e;
  }
}

async function effectiveDay(s: Services, date: string, now: Date): Promise<EffectiveDay> {
  const [days, races, overrides] = await Promise.all([s.days.listByDate(TENANT_ID, date), s.schedules.listByDate(TENANT_ID, date), s.overrides.listByDate(TENANT_ID, date)]);
  const fetchFact = days.map((d) => d.lastConfirmedAt).filter((x): x is string => x !== null).sort().pop() ?? null;
  return deriveEffectiveDay(date, now, days, races, overrides, fetchFact);
}

/** 1 レースの判定。発走後のオッズは使わない（観測時刻 <= min(現在, 発走)）。 */
async function analyzeRace(s: Services, runId: string, raceId: string, postAt: string | null, inWindow: boolean, now: Date, config: DecisionConfig): Promise<RaceAnalysisResult> {
  try {
    if (!inWindow) return { raceId, status: "NOT_IN_WINDOW", signals: 0, bestEv: null, note: "発走時刻が未確定、または開催が確認できていません。" };
    if (postAt !== null && Date.parse(postAt) <= now.getTime()) {
      // 発走後でも、発走前に観測したオッズがあれば、その時点の判定を記録できる（未来情報は混ぜない）
    }
    const cutoff = postAt === null ? now.toISOString() : new Date(Math.min(now.getTime(), Date.parse(postAt))).toISOString();
    const win = await s.market.latestWinOdds(TENANT_ID, raceId, cutoff);
    if (win === null || win.entries.length === 0) return { raceId, status: "NO_ODDS", signals: 0, bestEv: null, note: "発走前の単勝オッズが未取得のため分析不能です。" };
    const existingEval = await s.evaluations.latestByRace(TENANT_ID, raceId);
    if (existingEval !== null && existingEval["snapshot_at"] === win.observedAt) return { raceId, status: "ALREADY_EVALUATED", signals: 0, bestEv: null, note: "同じオッズで判定済みです（変化なし）。" };
    const [wide, tri, recent] = await Promise.all([
      s.market.latestCombos(TENANT_ID, raceId, "wide", cutoff),
      s.market.latestCombos(TENANT_ID, raceId, "sanrenpuku", cutoff),
      s.market.recentWinSnapshots(TENANT_ID, raceId, cutoff, 4),
    ]);
    const odds: OddsEntry[] = win.entries.map((e) => ({ umaban: e.umaban, odds: e.odds, popularity: e.popularity ?? 0 }));
    const minutesToPost = postAt === null ? null : (Date.parse(postAt) - Date.parse(win.observedAt)) / 60_000;
    const cfg: DecisionConfig = config.priorityMode === "hit_rate" ? { ...config, hitRateMinEv: resolveHitRateMinEv(RECOMMENDED_HIT_RATE_SCHEDULE, config.hitRateMinEv ?? config.evThreshold, minutesToPost) } : config;
    const wideMap = new Map<string, readonly [number, number]>((wide?.rows ?? []).map((r) => [r.comboKey.split("-").map(Number).join("-"), [r.odds, r.oddsHigh ?? r.odds] as const]));
    const triMap = new Map<string, number>((tri?.rows ?? []).map((r) => [r.comboKey.split("-").map(Number).join("-"), r.odds]));
    const result = evaluateOdds({ odds, recentSnapshots: (u) => recent.get(u) ?? [], wideOddsMap: wideMap, sanrenpukuOddsMap: triMap, raceId }, cfg);
    const nowIso = s.clock.now().toISOString();
    const evalId = await s.evaluations.insert(
      TENANT_ID,
      {
        raceId,
        snapshotAt: win.observedAt,
        betTypes: JSON.stringify(cfg.betTypes ?? ["単勝", "ワイド", "三連複"]),
        priorityMode: cfg.priorityMode,
        evThreshold: cfg.priorityMode === "hit_rate" ? (cfg.hitRateMinEv ?? cfg.evThreshold) : cfg.evThreshold,
        bestCandidateJson: result.bestCandidate === null ? null : JSON.stringify(result.bestCandidate),
        bestEv: result.bestCandidate?.ev ?? null,
        rejectionJson: JSON.stringify({ ...result.rejectCounts, ...result.extraRejects }),
        signalSent: result.signals.some((x) => x.kind === "bet"),
        fallbackReason: result.probSource.startsWith("market") ? "NO_MODEL" : null,
        modelType: result.probSource.startsWith("market") ? "market" : "ml",
      },
      nowIso,
    );
    if (evalId === null) return { raceId, status: "ALREADY_EVALUATED", signals: 0, bestEv: null, note: "同じ時刻の評価が既にあります。" };
    const bets = result.signals.filter((x): x is Extract<DecisionSignal, { kind: "bet" }> => x.kind === "bet");
    const stmts = bets.map((b) =>
      s.signals.insertStatement(
        TENANT_ID,
        {
          id: null,
          raceId,
          market: b.market,
          umaban: b.umaban,
          observedAt: win.observedAt,
          odds: b.odds,
          prob: Math.min(Math.max(b.prob, 0), 1),
          ev: b.ev,
          stake: b.bet_amount,
          expectedProfit: b.bet_strategy?.best_strategy?.expected_profit ?? null,
          skipReason: null,
          kellyRaw: b.bet_strategy?.best_strategy?.kelly_raw ?? null,
          kellyAdj: b.bet_strategy?.best_strategy?.kelly_adjusted ?? null,
          betBeforeClip: b.bet_strategy?.best_strategy?.kelly_bet_before_clip ?? null,
          clipped: b.bet_strategy?.best_strategy?.clipped ?? false,
          mkt: b.p_mkt,
          ratio: b.ratio,
          expectedReturn: b.expected_return,
          suggestedBet: b.bet_amount,
          probSource: b.prob_source,
          reason: b.reason,
          // Sites 版の「通知」はサイト内表示（Discord は外部通信の確認後）。表示した = SENT として成績の対象にする
          state: "SENT",
        },
        nowIso,
      ),
    );
    if (stmts.length > 0) await s.db.batch(stmts);
    if (postAt !== null && result.signals.length > 0) {
      const minutes = Math.max(0, (Date.parse(postAt) - Date.parse(win.observedAt)) / 60_000);
      const timingCenti = Math.min(144000, Math.max(1, Math.round(minutes * 100)));
      const notice = noticeSnapshot(result.signals);
      await s.evaluations.insertNotice(TENANT_ID, { raceId, timingCenti, runId, evaluationId: evalId, oddsObservedAt: win.observedAt, schema: NOTICE_SCHEMA, json: notice, sha256: await sha256Hex(notice) }, nowIso);
    }
    return { raceId, status: "ANALYZED", signals: bets.length, bestEv: result.bestCandidate?.ev ?? null, note: bets.length === 0 ? "条件を満たす買い目はありません（見送り）。" : null };
  } catch (e) {
    return { raceId, status: "ERROR", signals: 0, bestEv: null, note: e instanceof Error ? e.name : "ERROR" };
  }
}

/** 通知のスナップショット（成績集計の入力）。買い目は表示と同じ選び方（重複除去 → EV 降順 → 6 点）で保存する。 */
export function noticeSnapshot(signals: readonly DecisionSignal[]): string {
  return JSON.stringify({
    schema: NOTICE_SCHEMA,
    items: signals.map((sg) => ({
      umaban: sg.umaban,
      betType: sg.bet_type,
      skipReason: sg.kind === "skip" ? (sg.skip_reason ?? "投資額が0") : null,
      strategies: Object.values(sg.bet_strategy?.strategies ?? {}).map((st) => ({
        type: st.type,
        tickets: displayedTickets(st.tickets ?? []).map((t) => ({ kumi: t.kumi, ev: t.ev, stake: t.stake ?? null })),
      })),
    })),
  });
}

interface NoticeItem {
  readonly skipReason: string | null;
  readonly strategies: readonly { readonly type: string; readonly tickets: readonly { readonly kumi: string; readonly ev: number; readonly stake: number | null }[] }[];
}
function decodeNotice(schema: number, json: string): NoticeItem[] | null {
  if (schema !== NOTICE_SCHEMA) return null;
  try {
    const v: unknown = JSON.parse(json);
    if (typeof v !== "object" || v === null || !("items" in v) || !Array.isArray(v.items)) return null;
    return v.items as NoticeItem[];
  } catch {
    return null;
  }
}

// =====================================================================
// 成績（PerformanceReadService の移植）
// =====================================================================
export const PERFORMANCE_MAX_DAYS = 366;

export interface PerformanceReport {
  readonly from: string;
  readonly to: string;
  readonly win: ReturnType<typeof summarizeWin>;
  readonly combos: ReturnType<typeof summarizeCombos>;
  readonly winUnsettled: number;
  readonly comboUnsettled: number;
  readonly racesWithoutPostTime: number;
  readonly unreadableNotices: number;
}

export async function performanceReport(s: Services, from: string, to: string): Promise<PerformanceReport> {
  if (to < from || daysBetween(from, to) > PERFORMANCE_MAX_DAYS) throw new RangeError("期間が不正");
  const winItems: SettledSignal[] = [];
  const comboItems: SettledCombo[] = [];
  let winUnsettled = 0;
  let comboUnsettled = 0;
  let noPost = 0;
  let unreadable = 0;
  for (let date = from; date <= to; date = addDays(date, 1)) {
    for (const race of await s.schedules.listByDate(TENANT_ID, date)) {
      const postAt = race.postTimeUnknown ? null : race.scheduledPostAt;
      const sent = (await s.signals.listByRace(TENANT_ID, race.raceId)).filter((x) => x.market === "win" && x.state === "SENT");
      const notices = await s.evaluations.listNotices(TENANT_ID, race.raceId);
      if (postAt === null) {
        if (sent.length > 0 || notices.length > 0) noPost++;
        continue;
      }
      if (sent.length === 0 && notices.length === 0) continue;
      const finishers = await s.market.listResults(TENANT_ID, race.raceId);
      const winPayouts = await s.market.listPayouts(TENANT_ID, race.raceId, "win");
      for (const x of sent) {
        const o = settleWin({ umaban: x.umaban, odds: x.odds, stake: x.stake }, finishers, winPayouts);
        if (o.kind === "Settled") winItems.push({ raceId: race.raceId, umaban: x.umaban, observedAt: x.observedAt, postAt, outcome: o });
        else winUnsettled++;
      }
      for (const n of notices) {
        const items = decodeNotice(n.schema, n.json);
        if (items === null || (await sha256Hex(n.json)) !== n.sha256) {
          unreadable++;
          continue;
        }
        const byMarket = new Map<Market, { kumi: string; ev: number; stake: number | null }[]>();
        for (const it of items.filter((i) => i.skipReason === null || i.skipReason === "")) {
          for (const st of it.strategies) {
            const m: Market | null = st.type === "ワイド" ? "wide" : st.type === "三連複" ? "sanrenpuku" : null;
            if (m === null) continue;
            byMarket.set(m, [...(byMarket.get(m) ?? []), ...st.tickets]);
          }
        }
        for (const [m, all] of byMarket) {
          const pay = await s.market.listPayouts(TENANT_ID, race.raceId, m);
          for (const t of displayedTickets(all)) {
            if (t.stake === null || !(t.stake > 0)) continue;
            const key = comboKeyOf(m, t.kumi);
            const o = settleCombo(m, t.kumi, t.stake, pay, finishers);
            if (o.kind === "Settled" && key !== null) comboItems.push({ raceId: race.raceId, market: m, comboKey: key, observedAt: n.oddsObservedAt, postAt, outcome: o });
            else comboUnsettled++;
          }
        }
      }
    }
  }
  return { from, to, win: summarizeWin(winItems), combos: summarizeCombos(comboItems), winUnsettled, comboUnsettled, racesWithoutPostTime: noPost, unreadableNotices: unreadable };
}

// =====================================================================
// 状態（ReadApi.status）
// =====================================================================
export async function status(s: Services) {
  const now = s.clock.now();
  const today = jstDate(now);
  const dayRows = await s.days.listByDate(TENANT_ID, today);
  const confirmed = dayRows.map((d) => d.lastConfirmedAt).filter((x): x is string => x !== null).sort().pop() ?? null;
  const races = await s.schedules.listByDate(TENANT_ID, today);
  const next = races.map((r) => r.scheduledPostAt).filter((x): x is string => x !== null && Date.parse(x) > now.getTime()).sort()[0] ?? null;
  const lastRun = (await s.runs.listByDate(TENANT_ID, today))[0] ?? null;
  const stale = dayRows.length > 0 && (confirmed === null || now.getTime() - Date.parse(confirmed) > STALE_AFTER_MS);
  return {
    serverTime: now.toISOString(),
    today,
    mode: await s.access.mode(TENANT_ID),
    days: dayRows.map((d) => ({ venueCode: d.venue, status: d.status, lastConfirmedAt: d.lastConfirmedAt })),
    lastRun: lastRun === null ? null : runDto(lastRun),
    nextRaceAt: next,
    scheduleStale: stale,
    latestConfirmedAt: confirmed,
  };
}

export function runDto(r: BotRun) {
  return { runId: r.runId, date: r.runDate, trigger: r.trigger, state: r.state, startedAt: r.startedAt, finishedAt: r.finishedAt, exitReason: r.exitReason };
}

// =====================================================================
// 手動補正（CalendarOverrideService の移植）
// =====================================================================
export type CreateOverrideOutcome = { kind: "Created"; override: CalendarOverride } | { kind: "Duplicate" } | { kind: "RaceNotFound" } | { kind: "Invalid"; reason: string };

export async function createOverride(
  s: Services,
  p: { scope: OverrideScope; date: string; raceId: string | null; action: OverrideAction; postAt: string | null; postponedTo: string | null; reason: string; createdBy: string },
): Promise<CreateOverrideOutcome> {
  const now = s.clock.now().toISOString();
  const value = p.action === "SET_POST_TIME" && p.postAt !== null ? eventJson({ post_at: new Date(p.postAt).toISOString() }) : p.action === "POSTPONE_TO" && p.postponedTo !== null ? eventJson({ to: p.postponedTo }) : null;
  const o: CalendarOverride = { tenantId: TENANT_ID, id: null, scope: p.scope, raceDate: p.date, raceId: p.raceId, action: p.action, value, reason: p.reason.trim(), createdBy: p.createdBy, createdAt: now, validUntil: null, revokedAt: null, revokedBy: null };
  const invalid = validateOverride(o);
  if (invalid !== null) return { kind: "Invalid", reason: invalid };
  if (p.raceId !== null && (await s.schedules.find(TENANT_ID, p.raceId)) === null) return { kind: "RaceNotFound" };
  const event = await createEvent({
    tenantId: TENANT_ID,
    raceId: p.raceId,
    raceDate: p.date,
    type: "MANUAL_OVERRIDE",
    oldValue: null,
    newValue: eventJson({ action: p.action, scope: p.scope, value, valid_until: null, created_by: p.createdBy, reason: o.reason }),
    source: "MANUAL",
    observedAt: now,
    receivedAt: now,
    dedupGroup: `override:${now}`,
  });
  const r = await s.overrides.create(o, event);
  return r === "Duplicate" ? { kind: "Duplicate" } : { kind: "Created", override: r };
}

export async function revokeOverride(s: Services, id: number, revokedBy: string): Promise<"Revoked" | "AlreadyRevoked" | "NotFound"> {
  if (!validActor(revokedBy)) throw new Error("revokedBy が不正");
  const current = await s.overrides.find(TENANT_ID, id);
  if (current === null) return "NotFound";
  if (current.revokedAt !== null) return "AlreadyRevoked";
  const now = s.clock.now().toISOString();
  const event = await createEvent({
    tenantId: TENANT_ID,
    raceId: current.raceId,
    raceDate: current.raceDate,
    type: "MANUAL_REVOKE",
    oldValue: eventJson({ override_id: id, action: current.action }),
    newValue: eventJson({ revoked_by: revokedBy }),
    source: "MANUAL",
    observedAt: now,
    receivedAt: now,
    dedupGroup: `revoke:${id}`,
  });
  return s.overrides.revoke(TENANT_ID, id, revokedBy, now, event);
}

/** 取得状況（データ取得状況の画面・MCP の get_sync_status）。 */
export async function syncStatus(s: Services) {
  const now = s.clock.now();
  const today = jstDate(now);
  const [batches, counts, day, mode] = await Promise.all([s.ingest.recentBatches(TENANT_ID, 20), s.ingest.counts(TENANT_ID), effectiveDay(s, today, now), s.access.mode(TENANT_ID)]);
  const races = await Promise.all(
    day.races.map(async (r) => {
      const win = await s.market.latestWinOdds(TENANT_ID, r.raceId, now.toISOString());
      const results = await s.market.listResults(TENANT_ID, r.raceId);
      const payouts = await s.market.listPayouts(TENANT_ID, r.raceId, "win");
      return { raceId: r.raceId, status: r.status, postAt: r.postAt, latestWinOddsAt: win?.observedAt ?? null, hasResult: results.some((x) => (x.finish ?? 0) > 0), hasPayout: payouts.some((p) => !p.provisional) };
    }),
  );
  return {
    serverTime: now.toISOString(),
    today,
    mode,
    dayVerdict: day.verdict,
    pendingRecords: counts.pending,
    failedRecords: counts.failed,
    lastBatchAt: batches[0]?.receivedAt ?? null,
    recentBatches: batches.slice(0, 5),
    races,
  };
}

export { REASON_RACE_NOT_FOUND };
