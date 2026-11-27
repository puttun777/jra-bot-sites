/**
 * ゴールデン比較（jra-bot-web の tools/golden/fixtures を gzip で同梱。旧 Python 実装の実際の出力）。
 * 比較規則はフィクスチャ自身の comparison_rules（最長一致の override、無ければ既定の abs_tol）。
 * 制約: JSON.parse は 1 と 1.0 を区別できないため、数値の int/float の型は比べない（値は比べる）。
 */
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface GoldenCall {
  readonly call_id: string;
  readonly function: string;
  readonly args: { [key: string]: Json };
}
export interface GoldenOutcome {
  readonly status: "ok" | "exception";
  readonly value?: Json;
  readonly exception_type?: string;
  readonly message?: string;
}
export interface GoldenFixture {
  readonly case_id: string;
  readonly description: string;
  readonly calls: readonly GoldenCall[];
  readonly expected: ReadonlyMap<string, GoldenOutcome>;
  readonly rules: Rules;
}
interface RuleEntry {
  readonly mode: string;
  readonly abs_tol?: number;
  readonly path?: string;
}
interface Rules {
  readonly default: { readonly float: RuleEntry };
  readonly overrides: readonly RuleEntry[];
}

function isObj(v: Json | undefined): v is { [key: string]: Json } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const here = dirname(fileURLToPath(import.meta.url));
/** dist/tests/golden から見たソースのフィクスチャ置き場。 */
const FIXTURE_DIR = join(here, "..", "..", "..", "tests", "golden", "fixtures");

export function loadFixture(caseId: string): GoldenFixture {
  const raw = gunzipSync(readFileSync(join(FIXTURE_DIR, `${caseId}.json.gz`))).toString("utf8");
  const j = JSON.parse(raw) as { [key: string]: Json };
  const input = j["input"];
  const expectedOutput = j["expected_output"];
  if (!isObj(input) || !isObj(expectedOutput)) throw new Error(`invalid fixture ${caseId}`);
  const calls = input["calls"];
  const results = expectedOutput["results"];
  if (!Array.isArray(calls) || !Array.isArray(results)) throw new Error(`invalid fixture ${caseId}`);
  const expected = new Map<string, GoldenOutcome>();
  for (const r of results) {
    if (!isObj(r) || typeof r["call_id"] !== "string" || !isObj(r["outcome"])) throw new Error("invalid result");
    expected.set(r["call_id"], r["outcome"] as unknown as GoldenOutcome);
  }
  return {
    case_id: caseId,
    description: String(j["description"]),
    calls: calls as unknown as GoldenCall[],
    expected,
    rules: j["comparison_rules"] as unknown as Rules,
  };
}

function resolveRule(rules: Rules, segs: readonly string[]): RuleEntry {
  let best: { len: number; rule: RuleEntry } | null = null;
  for (const o of rules.overrides) {
    const pat = (o.path ?? "").split(".");
    const ok = pat.length <= segs.length && pat.every((p, i) => p === "*" || p === segs[i]);
    if (ok && (best === null || pat.length > best.len)) best = { len: pat.length, rule: o };
  }
  return best?.rule ?? rules.default.float;
}

export interface Diff {
  readonly path: string;
  readonly kind: string;
  readonly expected: unknown;
  readonly actual: unknown;
}

/** 期待値と実際の差分（空なら一致）。 */
export function diffJson(expected: Json, actual: Json, rules: Rules, segs: string[] = [], out: Diff[] = []): Diff[] {
  const rule = resolveRule(rules, segs.map((s) => (/^\d+$/.test(s) ? "*" : s)));
  const path = segs.join(".") || "$";
  if (rule.mode === "ignore") return out;
  if (typeof expected === "number" && typeof actual === "number") {
    const tol = rule.abs_tol ?? 0;
    if (!(Math.abs(expected - actual) <= tol) && expected !== actual) out.push({ path, kind: "float", expected, actual });
    return out;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return [...out, { path, kind: "type", expected, actual }];
    if (expected.length !== actual.length) out.push({ path, kind: "length", expected: expected.length, actual: actual.length });
    const n = Math.min(expected.length, actual.length);
    for (let i = 0; i < n; i++) diffJson(expected[i] ?? null, actual[i] ?? null, rules, [...segs, String(i)], out);
    return out;
  }
  if (isObj(expected)) {
    if (!isObj(actual)) return [...out, { path, kind: "type", expected, actual }];
    const ek = Object.keys(expected).sort();
    const ak = Object.keys(actual).sort();
    for (const k of ek) if (!(k in actual)) out.push({ path: `${path}.${k}`, kind: "missing", expected: expected[k], actual: undefined });
    for (const k of ak) if (!(k in expected)) out.push({ path: `${path}.${k}`, kind: "extra", expected: undefined, actual: actual[k] });
    for (const k of ek) if (k in actual) diffJson(expected[k] ?? null, actual[k] ?? null, rules, [...segs, k], out);
    return out;
  }
  if (expected !== actual) out.push({ path, kind: "value", expected, actual });
  return out;
}

/** 実装の戻り値を JSON に正規化する（undefined のキーは落とす）。 */
export function toJson(v: unknown): Json {
  return JSON.parse(JSON.stringify(v)) as Json;
}

export type Runner = (call: GoldenCall) => Json;

/**
 * フィクスチャの全呼び出しを実行して比較する。`skip` は未対応の呼び出し（成功に数えない。件数を返す）。
 */
export function runFixture(fx: GoldenFixture, runner: Runner, skip: (call: GoldenCall) => boolean = () => false): { checked: number; skipped: number; failures: string[] } {
  let checked = 0;
  let skipped = 0;
  const failures: string[] = [];
  for (const call of fx.calls) {
    if (skip(call)) {
      skipped++;
      continue;
    }
    const exp = fx.expected.get(call.call_id);
    if (exp === undefined) throw new Error(`no expected for ${call.call_id}`);
    let actual: GoldenOutcome;
    try {
      actual = { status: "ok", value: runner(call) };
    } catch (e: unknown) {
      const name = e instanceof Error ? e.name : "Error";
      actual = { status: "exception", exception_type: name, message: e instanceof Error ? e.message : String(e) };
    }
    checked++;
    const expJson = toJson({ call_id: call.call_id, outcome: exp });
    const actJson = toJson({ call_id: call.call_id, outcome: actual });
    const prefixed = { results: [expJson] } as Json;
    const prefixedA = { results: [actJson] } as Json;
    const diffs = diffJson(prefixed, prefixedA, fx.rules);
    if (diffs.length > 0) {
      failures.push(`${fx.case_id}/${call.call_id}: ${diffs.slice(0, 5).map((d) => `${d.kind} ${d.path} exp=${JSON.stringify(d.expected)?.slice(0, 200)} act=${JSON.stringify(d.actual)?.slice(0, 200)}`).join(" | ")}`);
    }
  }
  return { checked, skipped, failures };
}

// ---- 引数の取り出し ----
export function num(args: { [key: string]: Json }, key: string): number {
  const v = args[key];
  if (typeof v !== "number") throw new Error(`arg ${key} is not a number`);
  return v;
}
export function obj(v: Json | undefined): { [key: string]: Json } {
  if (!isObj(v)) return {};
  return v;
}
export function optNum(o: { [key: string]: Json }, key: string): number | undefined {
  const v = o[key];
  return typeof v === "number" ? v : undefined;
}
export function optStr(o: { [key: string]: Json }, key: string): string | undefined {
  const v = o[key];
  return typeof v === "string" ? v : undefined;
}
export function optBool(o: { [key: string]: Json }, key: string): boolean | undefined {
  const v = o[key];
  return typeof v === "boolean" ? v : undefined;
}
export function arr(v: Json | undefined): Json[] {
  return Array.isArray(v) ? v : [];
}
