/**
 * JRA 公式サイトへの控えめなアクセス（取得元のアダプター。docs/DATA_SOURCES.md §5）。
 * - robots.txt は全許可（2026-11-27 確認）。利用規約は著作物の私的使用の範囲（本人の承認済み: HANDOFF U-1）。
 * - 1 リクエストごとに最小 2 秒あける・1 回の実行の上限 MAX_REQUESTS・識別できる User-Agent。アクセス制限の回避（偽装・並列）はしない。
 * - 応答は Shift_JIS。生の HTML は保存しない（解析した値だけを返す）。
 * fetch は差し替えられる（試験・Sites の外部通信の確認前）。Sites から直接呼べるかは未検証（SITES_CONSTRAINTS E-3）。
 */
export const JRA_BASE = "https://www.jra.go.jp";
export const MIN_INTERVAL_MS = 2000;
export const MAX_REQUESTS = 80;
export const USER_AGENT = "jra-bot-sites/0.1 (personal non-commercial; low-frequency)";

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

export class JraClient {
  private last = Number.NEGATIVE_INFINITY;
  private count = 0;

  constructor(
    private readonly fetcher: Fetcher = (u, i) => fetch(u, i),
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    private readonly now: () => number = () => Date.now(),
    /** 応答の文字コード（JRA は Shift_JIS。試験では UTF-8 の見本を使う）。 */
    private readonly encoding: string = "shift_jis",
  ) {}

  get requests(): number {
    return this.count;
  }

  /** /JRADB/{page} に CNAME を POST して、Shift_JIS を文字列にして返す。 */
  async page(page: string, cname: string): Promise<string> {
    if (!/^access[A-Z0-9]{1,2}\.html$/.test(page) || !/^[A-Za-z0-9]{6,60}\/[0-9A-F]{2}$/.test(cname)) throw new Error("不正なページ指定");
    if (this.count >= MAX_REQUESTS) throw new Error("1 回の実行のリクエスト上限に達した");
    const wait = this.last + MIN_INTERVAL_MS - this.now();
    if (wait > 0) await this.sleep(wait);
    this.count++;
    this.last = this.now();
    const res = await this.fetcher(`${JRA_BASE}/JRADB/${page}`, {
      method: "POST",
      headers: { "User-Agent": USER_AGENT, "Content-Type": "application/x-www-form-urlencoded" },
      body: `cname=${encodeURIComponent(cname)}`,
    });
    if (!res.ok) throw new Error(`JRA: HTTP ${res.status}`);
    return new TextDecoder(this.encoding).decode(await res.arrayBuffer());
  }
}

/** トップの CNAME（サイトの共通メニューにある固定の値。2026-11-27 確認）。 */
export const TOP = { card: { page: "accessD.html", cname: "pw01dli00/F3" }, result: { page: "accessS.html", cname: "pw01sli00/AF" } } as const;
