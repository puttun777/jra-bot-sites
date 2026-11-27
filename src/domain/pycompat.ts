/**
 * 旧 Python 実装（puttun777/jra-bot）と同じ数値・同じ文字列を得るための互換関数。
 *
 * 旧実装は IEEE754 倍精度で計算し、丸めは表示だけで行う。JavaScript の number も同じ表現だが、
 * 次の点は結果が変わり得るため、旧実装の呼び出しをそのまま写す（jra-bot-web の PythonCompat.kt と同じ方針）。
 * - min/max: Python は先頭の引数を返し、後ろが厳密に小さい（大きい）ときだけ置き換える。
 * - sum: CPython 3.12 以降は Neumaier の補償加算。
 * - repr(float) / format(x, ".2f") / format(x, ".1%"): 通知文・理由文に入る文字列。
 */

/** Python の `min(a, b)`。 */
export function pyMin(a: number, b: number): number {
  return b < a ? b : a;
}

/** Python の `max(a, b)`。 */
export function pyMax(a: number, b: number): number {
  return b > a ? b : a;
}

/** Python の `min(max(x, lo), hi)`。 */
export function pyClamp(x: number, lo: number, hi: number): number {
  return pyMin(pyMax(x, lo), hi);
}

/** Python 3.12+ の `sum(floats)`（Neumaier 補償加算）。空は 0。 */
export function pySum(values: readonly number[]): number {
  let result = 0;
  let c = 0;
  for (const x of values) {
    const t = result + x;
    c += Math.abs(result) >= Math.abs(x) ? result - t + x : x - t + result;
    result = t;
  }
  if (c !== 0 && Number.isFinite(c)) result += c;
  return result;
}

/** Python の `max(iterable, key=...)`（最初の最大要素）。空なら undefined。 */
export function pyMaxBy<T>(items: readonly T[], key: (item: T) => number): T | undefined {
  let best: T | undefined;
  let bestKey = 0;
  let first = true;
  for (const item of items) {
    const k = key(item);
    if (first || k > bestKey) {
      best = item;
      bestKey = k;
      first = false;
    }
  }
  return best;
}

/** Python の `repr(float)`（最短の往復表現。指数表記の境界は Python に合わせる）。 */
export function pyRepr(value: number): string {
  if (Number.isNaN(value)) return "nan";
  if (!Number.isFinite(value)) return value > 0 ? "inf" : "-inf";
  if (value === 0) return Object.is(value, -0) ? "-0.0" : "0.0";
  const negative = value < 0;
  // toExponential() は往復できる最短の桁を返す（例: "1.2345e+2"）
  const exp = Math.abs(value).toExponential();
  const [mant = "0", expPart = "0"] = exp.split("e");
  const digits = mant.replace(".", "");
  const e = Number(expPart);
  const decpt = e + 1; // 0.d1d2... × 10^decpt
  let body: string;
  if (decpt > -4 && decpt <= 16) {
    if (decpt <= 0) body = `0.${"0".repeat(-decpt)}${digits}`;
    else if (decpt >= digits.length) body = `${digits}${"0".repeat(decpt - digits.length)}.0`;
    else body = `${digits.slice(0, decpt)}.${digits.slice(decpt)}`;
  } else {
    const mantissa = digits.length === 1 ? digits : `${digits[0] ?? ""}.${digits.slice(1)}`;
    const sign = e < 0 ? "-" : "+";
    body = `${mantissa}e${sign}${String(Math.abs(e)).padStart(2, "0")}`;
  }
  return negative ? `-${body}` : body;
}

/** Python の `format(x, ".{digits}f")`（2 進の正確な値に対する偶数丸め）。 */
export function pyFixed(value: number, digits: number): string {
  if (Number.isNaN(value)) return "nan";
  if (!Number.isFinite(value)) return value > 0 ? "inf" : "-inf";
  const negative = value < 0 || Object.is(value, -0);
  const abs = Math.abs(value);
  if (abs >= 1e21) {
    // 現実の入力（オッズ・確率・金額）では起きない範囲。BigInt で整数部を出す
    const s = BigInt(Math.round(abs)).toString() + (digits > 0 ? `.${"0".repeat(digits)}` : "");
    return negative ? `-${s}` : s;
  }
  let s = abs.toFixed(digits); // 同点は「大きい方」を選ぶ（Python は偶数側）
  const exact = abs.toFixed(Math.min(100, digits + 60));
  const tail = exact.split(".")[1]?.slice(digits) ?? "";
  if (tail.length > 0 && tail[0] === "5" && /^50*$/.test(tail)) {
    // ちょうど中間。JS は切り上げたので、結果の最終桁が奇数なら 1 単位戻す
    const intDigits = s.replace(".", "");
    const last = Number(intDigits[intDigits.length - 1] ?? "0");
    if (last % 2 === 1) {
      const n = BigInt(intDigits) - 1n;
      const raw = n.toString().padStart(digits + 1, "0");
      s = digits > 0 ? `${raw.slice(0, raw.length - digits)}.${raw.slice(raw.length - digits)}` : raw;
    }
  }
  return negative ? `-${s}` : s;
}

/** Python の `format(x, ".{digits}%")`。 */
export function pyPercent(value: number, digits: number): string {
  return `${pyFixed(value * 100, digits)}%`;
}

/** Python の `f"{n:02d}"`。 */
export function pad2(n: number): string {
  const s = String(Math.trunc(Math.abs(n))).padStart(2, "0");
  return n < 0 ? `-${s}` : s;
}

/** 旧実装の `ZeroDivisionError`（Kelly で odds == 1.0 のとき）。旧挙動の再現専用。 */
export class LegacyZeroDivisionError extends Error {
  constructor() {
    super("float division by zero");
    this.name = "ZeroDivisionError";
  }
}
