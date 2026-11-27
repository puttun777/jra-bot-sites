/**
 * 入力の実行時検証（外部入力: 画面の POST・取込・MCP の引数）。zod で型と範囲を確かめ、余分なキーは拒否する。
 * MCP のツールの入力スキーマ（JSON Schema）もここから生成する（z.toJSONSchema）。
 */
import { z } from "zod";
import { isOverrideAction } from "../domain/calendar.js";
import { NORMALIZED_RECORD_IDS } from "../domain/ingest.js";

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
export const raceIdSchema = z.string().regex(/^\d{12}$/, "12 桁のレース ID");
export const instantSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/, "ISO 8601（タイムゾーン付き）")
  .refine((s) => !Number.isNaN(Date.parse(s)), "時刻として読めない");
// eslint-disable-next-line no-control-regex
const noControl = (s: string): boolean => !/[\u0000-\u001f\u007f-\u009f]/.test(s);

export const CreateOverrideRequest = z
  .object({
    scope: z.enum(["DAY", "RACE"]),
    action: z.string().refine(isOverrideAction, "未知の操作"),
    date: isoDate,
    raceId: raceIdSchema.nullable(),
    postAt: instantSchema.nullable(),
    postponedTo: isoDate.nullable(),
    reason: z.string().trim().min(1).max(500).refine(noControl, "制御文字は使えない"),
  })
  .strict();

export const RevokeAgentRequest = z.object({ reason: z.string().trim().min(1).max(500).refine(noControl) }).strict();
export const CreateAgentRequest = z
  .object({
    agentId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    name: z.string().trim().min(1).max(100).refine(noControl),
    validDays: z.number().int().min(1).max(366),
  })
  .strict();

/** backfill: 過去日の再判定（開催日の確認が無い旧データも、発走時刻が分かるレースを発走前のオッズで判定する）。 */
export const RunAnalysisRequest = z.object({ date: isoDate.optional(), raceId: raceIdSchema.optional(), backfill: z.boolean().optional() }).strict();
export const SetModeRequest = z.object({ mode: z.enum(["NORMAL", "STOPPED"]), reason: z.string().trim().min(1).max(500).refine(noControl) }).strict();

/** 取込の封筒（正規化 JSON レコードの束）。 */
export const IngestRecord = z
  .object({
    id: z.enum(NORMALIZED_RECORD_IDS),
    /** レコードの内容（オブジェクト）。サーバ側で JSON 文字列にして保存・解析する。 */
    data: z.record(z.string(), z.unknown()),
  })
  .strict();
export const IngestEnvelopeRequest = z
  .object({
    batchId: z.uuid(),
    source: z.string().regex(/^[a-z0-9_-]{1,16}$/),
    observedAt: instantSchema,
    records: z.array(IngestRecord).min(1).max(200),
  })
  .strict();

export type IngestEnvelopeRequest = z.infer<typeof IngestEnvelopeRequest>;

const retentionDays = z.number().int().min(7).max(3650);
export const RetentionRequest = z
  .object({
    execute: z.boolean(),
    days: z.object({ COMBO_ODDS: retentionDays.optional(), INGEST_RAW: retentionDays.optional(), SCHEDULE_EVENTS: retentionDays.optional(), BOT_RUNS: retentionDays.optional() }).strict().optional(),
  })
  .strict();
