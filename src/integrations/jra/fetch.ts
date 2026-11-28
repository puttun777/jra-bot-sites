/**
 * JRA 公式サイトから、指定日の開催日・レース（出馬表）と、結果・払戻を取得して取込の封筒にする。
 * 取得と保存は分離（ここは封筒を作るだけ。保存は ingestBatch か /api/v1/ingest/batches）。オッズは未対応（発売中のページの構造を未確認）。
 */
import type { JraClient} from "./client.js";
import { TOP } from "./client.js";
import { parseCardDays, parseCardRaces, parseOddsAsOf, parseOddsDays, parseOddsRaces, parseResult, parseResultDays, parseResultRaces, parseTrioOdds, parseWideOdds, parseWinOdds, rankByOdds } from "./parse.js";

export interface JraEnvelope {
  readonly source: "jra-web";
  readonly observedAt: string;
  readonly records: { id: "NYS" | "NRA" | "NRS" | "NHR"; data: Record<string, unknown> }[];
  readonly notes: string[];
}

const ymd = (d: string): string => d.replaceAll("-", "");

/** 出馬表: 開催日（NYS: PLANNED）とレース（NRA: kubun 2。発走時刻が読めなければ 1）。createdOn は取得日（JST）。 */
export async function fetchCard(client: JraClient, date: string, now: Date, venue?: string): Promise<JraEnvelope> {
  const notes: string[] = [];
  const top = await client.page(TOP.card.page, TOP.card.cname);
  const days = parseCardDays(top).filter((d) => d.date === date && (venue === undefined || d.venue === venue));
  if (days.length === 0) notes.push(`出馬表に ${date} の開催が見つからない（未発表・開催なし）`);
  const createdOn = ymd(new Date(now.getTime() + 9 * 3_600_000).toISOString().slice(0, 10));
  const records: JraEnvelope["records"] = [];
  for (const d of days) {
    records.push({ id: "NYS", data: { date: ymd(d.date), venue: d.venue, kai: d.kai, nichime: d.nichime, status: "PLANNED", replacedBy: null } });
    const races = parseCardRaces(await client.page(TOP.card.page, d.cname)).filter((r) => r.date === date && r.venue === d.venue);
    if (races.length === 0) notes.push(`${d.venue} のレース一覧を読めない（構造の変更の可能性）`);
    for (const r of races) {
      records.push({ id: "NRA", data: { raceId: r.raceId, kubun: r.postTime === null ? "1" : "2", createdOn, postTime: r.postTime === null ? null : r.postTime.replace(":", ""), raceName: r.raceName, kai: r.kai, nichime: r.nichime } });
    }
  }
  return { source: "jra-web", observedAt: now.toISOString(), records, notes };
}

/**
 * 結果: 着順（NRS）と払戻（NHR: 単勝・ワイド・3 連複。確定として登録）。raceIds を渡すとそのレースだけ。
 * 過去日のレースが未登録でも保留にならないよう、同じ封筒の先頭に開催日（NYS）とレース（NRA: 結果ページの発走時刻。作成日はレース日）も入れる。
 */
export async function fetchResults(client: JraClient, date: string, now: Date, venue?: string, raceIds?: ReadonlySet<string>): Promise<JraEnvelope> {
  const notes: string[] = [];
  const top = await client.page(TOP.result.page, TOP.result.cname);
  const days = parseResultDays(top).filter((d) => d.date === date && (venue === undefined || d.venue === venue));
  if (days.length === 0) notes.push(`結果に ${date} の開催が見つからない（未確定・開催なし）`);
  const records: JraEnvelope["records"] = [];
  for (const d of days) {
    records.push({ id: "NYS", data: { date: ymd(d.date), venue: d.venue, kai: d.kai, nichime: d.nichime, status: "PLANNED", replacedBy: null } });
    const races = parseResultRaces(await client.page(TOP.result.page, d.cname)).filter((r) => r.date === date && (raceIds === undefined || raceIds.has(r.raceId)));
    for (const r of races) {
      const res = parseResult(await client.page(TOP.result.page, r.cname));
      if (res.finishes.length === 0) {
        notes.push(`${r.raceId}: 着順を読めない`);
        continue;
      }
      records.push({ id: "NRA", data: { raceId: r.raceId, kubun: res.postTime === null ? "1" : "2", createdOn: ymd(r.date), postTime: res.postTime === null ? null : res.postTime.replace(":", ""), raceName: res.raceName, kai: r.kai, nichime: r.nichime } });
      records.push({ id: "NRS", data: { raceId: r.raceId, entries: res.finishes } });
      for (const market of ["win", "wide", "sanrenpuku"] as const) {
        const rows = res.payouts[market];
        if (rows.length > 0) records.push({ id: "NHR", data: { raceId: r.raceId, market, provisional: false, entries: rows } });
        else notes.push(`${r.raceId}: ${market} の払戻を読めない`);
      }
    }
  }
  return { source: "jra-web", observedAt: now.toISOString(), records, notes };
}

/** 3 連複のうち保存する組: 単勝オッズの上位 TRIO_TOP 頭のうち 2 頭以上を含む組（判定の流し・BOX が使う範囲。全 816 組は保存しない: DATABASE §5）。 */
export const TRIO_TOP = 6;

export interface JraOddsEnvelope {
  readonly source: "jra-web";
  readonly raceId: string;
  /** オッズの時点（ページの「◯時◯分現在オッズ」。読めなければ取得時刻）。 */
  readonly observedAt: string;
  readonly records: { id: "NOW" | "NOD" | "NOS"; data: Record<string, unknown> }[];
}

/**
 * オッズ（単勝・ワイド・3 連複）を、発走前のレースだけ取得する。レースごとに封筒を作る（オッズの時点がレースごとに違うため）。
 * withinMinutes を渡すと、発走まで その分以内のレースだけ（利用枠・リクエスト数の節約）。発走後・時点が発走以降（最終オッズ）のものは取得・登録しない（未来情報の混入防止）。
 * 人気の列が無いので NOW の pop は null（判定のときに単勝オッズの順位で補う: services.ts）。
 */
export async function fetchOdds(
  client: JraClient,
  date: string,
  now: Date,
  opts: { venue?: string; withinMinutes?: number; raceIds?: ReadonlySet<string> } = {},
): Promise<{ envelopes: JraOddsEnvelope[]; notes: string[] }> {
  const notes: string[] = [];
  const top = await client.page("accessO.html", "pw15oli00/6D");
  const days = parseOddsDays(top).filter((d) => d.date === date && (opts.venue === undefined || d.venue === opts.venue));
  if (days.length === 0) notes.push(`オッズに ${date} の開催が見つからない（発売前・開催なし）`);
  const toInstant = (hhmm: string): number => Date.parse(`${date}T${hhmm}:00+09:00`);
  const envelopes: JraOddsEnvelope[] = [];
  for (const d of days) {
    const races = parseOddsRaces(await client.page("accessO.html", d.cname)).filter((r) => opts.raceIds === undefined || opts.raceIds.has(r.raceId));
    for (const r of races) {
      if (r.postTime === null) {
        notes.push(`${r.raceId}: 発走時刻を読めないので取得しない`);
        continue;
      }
      const post = toInstant(r.postTime);
      if (post <= now.getTime()) continue;
      if (opts.withinMinutes !== undefined && post - now.getTime() > opts.withinMinutes * 60_000) continue;
      const winHtml = await client.page("accessO.html", r.winCname);
      const asOf = parseOddsAsOf(winHtml);
      const observed = asOf === null ? now.getTime() : toInstant(asOf);
      if (observed >= post) {
        notes.push(`${r.raceId}: オッズの時点が発走以降（最終オッズ）なので登録しない`);
        continue;
      }
      const win = parseWinOdds(winHtml);
      if (win.length === 0) {
        notes.push(`${r.raceId}: 単勝オッズを読めない`);
        continue;
      }
      const records: JraOddsEnvelope["records"] = [{ id: "NOW", data: { raceId: r.raceId, entries: win.map((e) => ({ umaban: e.umaban, odds: e.odds, pop: null })) } }];
      if (r.wideCname !== null) {
        const wide = parseWideOdds(await client.page("accessO.html", r.wideCname));
        if (wide.length > 0) records.push({ id: "NOD", data: { raceId: r.raceId, entries: wide.map((e) => ({ a: e.a, b: e.b, low: e.low, high: e.high, pop: null })) } });
        else notes.push(`${r.raceId}: ワイドのオッズを読めない`);
      }
      if (r.trioCname !== null) {
        const rank = rankByOdds(win);
        const top6 = new Set([...rank].filter(([, k]) => k <= TRIO_TOP).map(([u]) => u));
        const trio = parseTrioOdds(await client.page("accessO.html", r.trioCname)).filter((e) => [e.a, e.b, e.c].filter((u) => top6.has(u)).length >= 2);
        if (trio.length > 0) records.push({ id: "NOS", data: { raceId: r.raceId, entries: trio.map((e) => ({ a: e.a, b: e.b, c: e.c, odds: e.odds, pop: null })) } });
        else notes.push(`${r.raceId}: 3 連複のオッズを読めない`);
      }
      envelopes.push({ source: "jra-web", raceId: r.raceId, observedAt: new Date(observed).toISOString(), records });
    }
  }
  return { envelopes, notes };
}
