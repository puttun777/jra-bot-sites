/** API の応答 → 表示する行・札（DOM に依存しない純粋な変換。node:test で試験する）。 */
import {
  AGENT_STATUS,
  DASH,
  DAY,
  fmtDateTime,
  fmtTime,
  label,
  MODEL_STATUS,
  modeLabel,
  num,
  pct,
  RACE,
  RUN,
  SIGNAL,
  type Tone,
} from "./format.js";
import type { Agent, AnalysisSummary, MlModel, Override, Performance, Race, RaceDetail, Run, Signal, Status, SyncStatus } from "./schema.js";

export interface Pill {
  readonly text: string;
  readonly tone: Tone;
}

export function statusPills(s: Status): Pill[] {
  const [modeText, modeTone] = modeLabel(s.mode);
  const pills: Pill[] = [{ text: modeText, tone: modeTone }];
  if (s.scheduleStale) pills.push({ text: `予定が未更新（最終確認 ${fmtDateTime(s.latestConfirmedAt)}）`, tone: "ng" });
  else if (s.latestConfirmedAt) pills.push({ text: `予定確認 ${fmtTime(s.latestConfirmedAt)}`, tone: "muted" });
  for (const d of s.days) pills.push({ text: `${d.venueCode} ${label(DAY, d.status)}`, tone: "" });
  if (s.nextRaceAt) pills.push({ text: `次の発走 ${fmtTime(s.nextRaceAt)}`, tone: "" });
  if (s.lastRun) {
    const bad = s.lastRun.state === "FAILED" || s.lastRun.state === "ABORTED";
    const reason = s.lastRun.exitReason ? `（${s.lastRun.exitReason}）` : "";
    pills.push({ text: `直近の実行: ${label(RUN, s.lastRun.state)}${reason}`, tone: bad ? "ng" : "" });
  }
  return pills;
}

export const RACE_HEADERS = ["発走", "レース", "名称", "状態"] as const;
export function raceRows(rows: readonly Race[]): string[][] {
  return rows.map((r) => [fmtTime(r.postAt), `${r.venueCode} ${r.raceNo}R`, r.name || DASH, label(RACE, r.status)]);
}

export const SIGNAL_HEADERS = ["観測", "レース", "馬番", "オッズ", "確率", "EV", "推奨額", "通知", "根拠"] as const;
export const SIGNAL_NUM_COLS = [2, 3, 4, 5, 6] as const;
export function signalRows(items: readonly Signal[]): string[][] {
  return items.map((s) => [
    fmtTime(s.observedAt),
    s.raceId,
    String(s.umaban),
    num(s.odds, 1),
    pct(s.prob),
    num(s.ev, 2),
    num(s.stake, 1),
    label(SIGNAL, s.state),
    s.probSource || DASH,
  ]);
}

export const PERF_HEADERS = ["賭式", "件数", "的中", "的中率", "推奨額合計", "実払戻", "回収率"] as const;
export const PERF_NUM_COLS = [1, 2, 3, 4, 5, 6] as const;
export function performanceRows(p: Performance): string[][] {
  const rows = [
    [
      "単勝",
      String(p.winCount),
      String(p.winHits),
      pct(p.winHitRate),
      num(p.winTotalStake, 1),
      num(p.winActualPayout, 1),
      pct(p.winActualRoi),
    ],
  ];
  for (const c of p.combos)
    rows.push([
      c.market === "wide" ? "ワイド" : "三連複",
      String(c.count),
      String(c.hits),
      pct(c.hitRate),
      num(c.totalStake, 1),
      num(c.actualPayout, 1),
      pct(c.actualRoi),
    ]);
  return rows;
}

/** 集計に含めていないもの（未確定・発走時刻不明・読めない通知）の注記。 */
export function performanceNote(p: Performance): string {
  const notes: string[] = [];
  if (p.winUnsettled) notes.push(`単勝の未確定 ${p.winUnsettled} 件`);
  if (p.comboUnsettled) notes.push(`買い目の未確定 ${p.comboUnsettled} 件`);
  if (p.racesWithoutPostTime) notes.push(`発走時刻不明のレース ${p.racesWithoutPostTime}`);
  if (p.unreadableNotices) notes.push(`読めない通知内容 ${p.unreadableNotices} 件`);
  return notes.length ? `集計に含めていないもの: ${notes.join("、")}` : "集計に含めていないものはありません。";
}

export function performanceIsEmpty(p: Performance): boolean {
  return !p.winCount && !p.combos.length;
}

export const RUN_HEADERS = ["開始", "終了", "起動", "状態", "理由"] as const;
export function runRows(rows: readonly Run[]): string[][] {
  return rows.map((r) => [fmtDateTime(r.startedAt), fmtDateTime(r.finishedAt), r.trigger, label(RUN, r.state), r.exitReason || DASH]);
}

/** 末尾の列（取消ボタン）は画面側で足す。 */
export const OVERRIDE_HEADERS = ["作成", "対象", "操作", "理由", "作成者", "状態", ""] as const;
export function overrideRows(rows: readonly Override[]): string[][] {
  return rows.map((o) => [
    fmtDateTime(o.createdAt),
    o.raceId || o.date,
    o.action,
    o.reason,
    o.createdBy,
    o.revokedAt ? "取消済み" : "有効",
  ]);
}

/** 補正の追加の要求本文（サーバの CreateOverrideRequest）。空欄は null（サーバが操作ごとに必須を検査する）。 */
export interface OverrideForm {
  readonly scope: string;
  readonly action: string;
  readonly date: string;
  readonly raceId: string;
  readonly postAt: string;
  readonly postponedTo: string;
  readonly reason: string;
}
export function overrideRequest(f: OverrideForm): Record<string, string | null> {
  return {
    scope: f.scope,
    action: f.action,
    date: f.date,
    raceId: f.raceId || null,
    postAt: f.postAt || null,
    postponedTo: f.postponedTo || null,
    reason: f.reason,
  };
}

/** ML モデルの一覧（R22。表示だけ。有効化は本人の判断なので操作のボタンは置かない）。 */
export const ML_HEADERS = ["作成", "モデル", "種別", "状態", "学習期間", "件数", "指標", "品質ゲート"] as const;
export const ML_NUM_COLS = [5] as const;
export function mlModelRows(rows: readonly MlModel[]): string[][] {
  return rows.map((m) => [
    fmtDateTime(m.createdAt),
    m.modelId,
    m.kind,
    label(MODEL_STATUS, m.status),
    m.trainedFrom || m.trainedTo ? `${m.trainedFrom ?? "?"}〜${m.trainedTo ?? "?"}` : DASH,
    m.nTrain === null ? DASH : num(m.nTrain),
    mlMetricsText(m),
    m.gatePurpose ? `${m.gatePurpose}: ${m.gateReasons.join("・") || DASH}` : m.gateReasons.join("・") || DASH,
  ]);
}

/** 指標（キーの辞書順。小数 4 桁まで）。読めなければその旨。 */
export function mlMetricsText(m: MlModel): string {
  if (!m.metricsReadable) return "指標を読めない";
  const parts = Object.entries(m.metrics)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${Number(v.toFixed(4))}`);
  return parts.length ? parts.join(", ") : DASH;
}

/** エージェントの一覧（R20）。末尾の列（失効ボタン）は画面側で足す。 */
export const AGENT_HEADERS = ["エージェント", "名前", "状態", "資格情報の期限", "登録", "失効", ""] as const;
export function agentRows(rows: readonly Agent[]): string[][] {
  return rows.map((a) => [
    a.agentId,
    a.name,
    label(AGENT_STATUS, a.status),
    fmtDateTime(a.tokenExpiresAt),
    `${fmtDateTime(a.createdAt)}${a.createdBy ? ` (${a.createdBy})` : ""}`,
    a.revokedAt ? `${fmtDateTime(a.revokedAt)}${a.revokedBy ? ` (${a.revokedBy})` : ""}` : DASH,
  ]);
}

/** 失効の理由（入力の検査。サーバの isISOControl と同じく C0・DEL・C1 の制御文字を拒否し、1〜500 文字）。不正なら null。 */
export function revokeReason(input: string | null): string | null {
  if (input === null) return null;
  const r = input.trim();
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字を拒否するための範囲
  // eslint-disable-next-line no-control-regex
  return r.length >= 1 && r.length <= 500 && !/[\u0000-\u001f\u007f-\u009f]/.test(r) ? r : null;
}

// ---- Sites 版で追加した表示（DOM に依存しない）----

const VERDICT: Readonly<Record<string, string>> = {
  CONFIRMED: "開催確定",
  NO_RACE_CONFIRMED: "開催なし（確認済み）",
  UNKNOWN: "予定未取得",
  STALE: "予定が古い",
  UNCONFIRMED: "未確認",
  CANCELLED: "中止",
  POSTPONED: "延期",
};

export const SYNC_HEADERS = ["レース", "発走", "状態", "最新オッズ取得", "着順", "払戻"] as const;
export function syncRows(s: SyncStatus): string[][] {
  return s.races.map((r) => [r.raceId, fmtTime(r.postAt), label(RACE, r.status), r.latestWinOddsAt ? fmtDateTime(r.latestWinOddsAt) : "未取得", r.hasResult ? "取得済み" : "未取得", r.hasPayout ? "取得済み" : "未取得"]);
}
export function syncSummary(s: SyncStatus): string {
  return `本日の判定: ${label(VERDICT, s.dayVerdict)} / 保留 ${s.pendingRecords} 件・失敗 ${s.failedRecords} 件 / 最終取込 ${fmtDateTime(s.lastBatchAt)}（取得日時は Asia/Tokyo）`;
}

export const ENTRY_HEADERS = ["馬番", "単勝オッズ", "人気", "着順"] as const;
export const ENTRY_NUM_COLS = [0, 1, 2, 3] as const;
export function entryRows(d: RaceDetail): string[][] {
  return d.entries.map((e) => [String(e.umaban), num(e.odds, 1), e.popularity === null ? DASH : String(e.popularity), e.finish === null ? DASH : String(e.finish)]);
}
export function raceDetailNote(d: RaceDetail): string {
  const odds = d.oddsObservedAt ? `オッズ取得 ${fmtDateTime(d.oddsObservedAt)}（発走前の最新）` : "発走前のオッズは未取得（分析不能）";
  const pays = d.payouts
    .filter((p) => p.rows.length > 0)
    .map((p) => `${p.market === "win" ? "単勝" : p.market === "wide" ? "ワイド" : "三連複"} ${p.rows.map((r) => `${r.comboKey}=${num(r.payout)}円${r.provisional ? "（速報）" : ""}`).join(" ")}`);
  return `${d.raceId} ${d.name ?? ""} / ${label(RACE, d.status)} / 発走 ${fmtTime(d.postAt)} / ${odds}${pays.length ? ` / 払戻: ${pays.join(" / ")}` : " / 払戻: 未取得"}`;
}
export function detailSignalRows(d: RaceDetail): string[][] {
  return d.signals.map((s) => [fmtTime(s.observedAt), s.market, String(s.umaban), num(s.odds, 1), pct(s.prob), num(s.ev, 2), num(s.stake, 1), s.reason ?? DASH]);
}
export const DETAIL_SIGNAL_HEADERS = ["観測", "賭式", "軸", "オッズ", "確率", "EV", "推奨額", "根拠"] as const;

export function analysisMessage(a: AnalysisSummary): string {
  const counts = new Map<string, number>();
  for (const r of a.races) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
  const parts = [...counts].map(([k, v]) => `${label(ANALYSIS_STATUS, k)} ${v}`);
  return `${a.message}${parts.length ? `（${parts.join("、")}）` : ""}`;
}
const ANALYSIS_STATUS: Readonly<Record<string, string>> = {
  ANALYZED: "判定済み",
  NO_ODDS: "オッズ未取得",
  PAST_POST: "発走後",
  NOT_IN_WINDOW: "対象外",
  ALREADY_EVALUATED: "変化なし",
  ERROR: "失敗",
};
