/**
 * Sites（Cloudflare Workers 互換と推定）の入口。**Sites 上で未検証**（docs/SITES_CONSTRAINTS.md E-1〜E-6）。
 * - D1 バインディング名は `.openai/hosting.json` の d1（既定 "DB"）。静的ファイルは ASSETS バインディング（Sites が提供する前提・未確認）。
 * - 本人のメールは Sites が注入するヘッダ（既定 `oai-authenticated-user-email`。AUTH_EMAIL_HEADER で変更可）から読む。
 *   ローカルの疑似ログインはこの入口では**常に無効**（devUserEmail: null）。
 * - Sites の推奨構成（例: Vinext）に合わせる必要がある場合は、この関数の中身を、そのルートから `handleRequest` を呼ぶ薄い接続に置き換える。
 * Node 専用 API（node:*）を読み込まない（build-assets.mjs が platform: neutral で束ねて確認する）。
 */
import { createServices } from "../application/services.js";
import { DEFAULT_EMAIL_HEADER, parseEmails } from "../api/auth.js";
import { error, handleRequest } from "../api/router.js";
import { systemClock } from "../domain/race.js";
import type { SqlDatabase } from "../infrastructure/db/sql.js";

interface AssetFetcher {
  fetch(request: Request): Promise<Response>;
}

/** Sites が渡すバインディング・環境変数（値はすべて実行時に検査する）。 */
interface Env {
  readonly DB?: unknown;
  readonly ASSETS?: unknown;
  readonly OWNER_EMAILS?: unknown;
  readonly VIEWER_EMAILS?: unknown;
  readonly INGEST_TOKEN?: unknown;
  readonly AUTH_EMAIL_HEADER?: unknown;
}

function isDb(v: unknown): v is SqlDatabase {
  return typeof v === "object" && v !== null && typeof (v as { prepare?: unknown }).prepare === "function" && typeof (v as { batch?: unknown }).batch === "function";
}
function isAssets(v: unknown): v is AssetFetcher {
  return typeof v === "object" && v !== null && typeof (v as { fetch?: unknown }).fetch === "function";
}
const text = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!isDb(env.DB)) return error(503, "database_not_bound");
    const assets = isAssets(env.ASSETS) ? env.ASSETS : null;
    return handleRequest(request, {
      services: createServices(env.DB, systemClock),
      auth: {
        emailHeader: (text(env.AUTH_EMAIL_HEADER) ?? DEFAULT_EMAIL_HEADER).toLowerCase(),
        ownerEmails: parseEmails(text(env.OWNER_EMAILS)),
        viewerEmails: parseEmails(text(env.VIEWER_EMAILS)),
        ingestToken: text(env.INGEST_TOKEN),
        devUserEmail: null,
      },
      assets: assets === null ? null : (req) => assets.fetch(req),
    });
  },
};
