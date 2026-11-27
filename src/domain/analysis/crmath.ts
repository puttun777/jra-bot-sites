/**
 * 正しく丸めた（に極めて近い）自然対数・指数関数。
 *
 * 理由: V8 の Math.log / Math.exp は最後の 1 ULP が glibc（旧 Python の numpy / math、Kotlin の JVM）と違うことがある。
 * 確率の logit 混合でこの差が出ると、EV が完全に同じ買い目・シグナルの並び（安定ソートの同点）が旧実装と変わる（GD06 で確認）。
 * そこで double-double（約 106 ビット）で計算してから倍精度に丸め、glibc と同じ値（真の値の最近接）を得る。
 * 非有限・0・負・非正規化数の扱いは Math と同じにする。
 */

const SPLIT = 134217729; // 2^27 + 1

function twoSum(a: number, b: number): [number, number] {
  const s = a + b;
  const bb = s - a;
  return [s, a - (s - bb) + (b - bb)];
}
function quickTwoSum(a: number, b: number): [number, number] {
  const s = a + b;
  return [s, b - (s - a)];
}
function twoProd(a: number, b: number): [number, number] {
  const p = a * b;
  let t = SPLIT * a;
  const ah = t - (t - a);
  const al = a - ah;
  t = SPLIT * b;
  const bh = t - (t - b);
  const bl = b - bh;
  return [p, ah * bh - p + ah * bl + al * bh + al * bl];
}
type DD = [number, number];
function ddAdd(a: DD, b: DD): DD {
  const [s, e] = twoSum(a[0], b[0]);
  const [t, f] = twoSum(a[1], b[1]);
  const [s2, e2] = quickTwoSum(s, e + t);
  return quickTwoSum(s2, e2 + f);
}
function ddMul(a: DD, b: DD): DD {
  const [p, e] = twoProd(a[0], b[0]);
  return quickTwoSum(p, e + (a[0] * b[1] + a[1] * b[0]));
}
function ddDiv(a: DD, b: DD): DD {
  const q1 = a[0] / b[0];
  const r = ddAdd(a, ddMul([-q1, 0], b));
  const q2 = r[0] / b[0];
  const r2 = ddAdd(r, ddMul([-q2, 0], b));
  const q3 = r2[0] / b[0];
  const [h, l] = quickTwoSum(q1, q2);
  return ddAdd([h, l], [q3, 0]);
}
function ddMulNum(a: DD, n: number): DD {
  return ddMul(a, [n, 0]);
}

/** ln 2 の double-double。 */
const LN2: DD = [0.6931471805599453, 2.3190468138462996e-17];

/** 正しく丸めた ln(x)。 */
export function crLog(x: number): number {
  if (Number.isNaN(x) || x < 0) return Number.NaN;
  if (x === 0) return -Infinity;
  if (x === Infinity) return Infinity;
  if (x === 1) return 0;
  // x = m * 2^e、m は [sqrt(1/2), sqrt(2))
  let e = Math.floor(Math.log2(x));
  let m = x / 2 ** e;
  if (!Number.isFinite(m) || m <= 0) return Math.log(x);
  while (m >= Math.SQRT2) {
    m /= 2;
    e += 1;
  }
  while (m < Math.SQRT1_2) {
    m *= 2;
    e -= 1;
  }
  // ln m = 2 atanh(s), s = (m-1)/(m+1)
  // m - 1 は Sterbenz の補題で正確、m + 1 は丸めが出るので double-double で持つ
  const s = ddDiv([m - 1, 0], twoSum(m, 1));
  const s2 = ddMul(s, s);
  let term: DD = s;
  let sum: DD = s;
  for (let k = 3; k < 80; k += 2) {
    term = ddMul(term, s2);
    const add = ddDiv(term, [k, 0]);
    sum = ddAdd(sum, add);
    if (Math.abs(add[0]) < 1e-40) break;
  }
  const lnm = ddMulNum(sum, 2);
  const r = ddAdd(ddMulNum(LN2, e), lnm);
  return r[0] + r[1];
}

/** 正しく丸めた exp(x)。 */
export function crExp(x: number): number {
  if (Number.isNaN(x)) return Number.NaN;
  if (x === Infinity) return Infinity;
  if (x === -Infinity) return 0;
  if (x > 709.8 || x < -745.2) return Math.exp(x);
  if (x === 0) return 1;
  const k = Math.round(x / LN2[0]);
  // r = x - k ln2（double-double で正確に）
  const r = ddAdd([x, 0], ddMulNum(LN2, -k));
  // exp(r) をテイラー級数で（|r| <= 0.35）。r をさらに 2^-8 にして 8 回 2 乗すると収束が速い
  const rr: DD = [r[0] / 256, r[1] / 256];
  let term: DD = [1, 0];
  let sum: DD = [1, 0];
  for (let n = 1; n < 40; n++) {
    term = ddDiv(ddMul(term, rr), [n, 0]);
    sum = ddAdd(sum, term);
    if (Math.abs(term[0]) < 1e-40) break;
  }
  for (let i = 0; i < 8; i++) sum = ddMul(sum, sum);
  // 2^k を掛ける（非正規化数の範囲では 2 段に分ける）
  if (k < -1000) {
    const v = (sum[0] + sum[1]) * 2 ** (k + 1000);
    return v * 2 ** -1000;
  }
  const hi = sum[0] * 2 ** k;
  const lo = sum[1] * 2 ** k;
  return hi + lo;
}
