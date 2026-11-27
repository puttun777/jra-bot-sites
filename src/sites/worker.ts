/** Sites の Worker 入口。利用者の身元は Sites の認証ゲートが注入する。 */
import { createServices } from "../application/services.js";
import { authenticateUser, DEFAULT_EMAIL_HEADER, MIN_TOKEN_LENGTH, parseEmails } from "../api/auth.js";
import { error, handleRequest, json, type AppContext } from "../api/router.js";
import { systemClock } from "../domain/race.js";
import type { SqlDatabase } from "../infrastructure/db/sql.js";

declare const SITES_STATIC_FILES: Readonly<Record<string, string>>;

const USER_ID_HEADER = "oai-authenticated-user-id";
const INGEST_PATH = "/api/v1/ingest/batches";
const CONTENT_TYPES = new Map([
  ["/index.html", "text/html; charset=utf-8"],
  ["/style.css", "text/css; charset=utf-8"],
  ["/js/app.js", "text/javascript; charset=utf-8"],
]);

/** Sites が渡すバインディング・環境変数（値はすべて実行時に検査する）。 */
interface Env {
  readonly DB?: unknown;
  readonly OWNER_EMAILS?: unknown;
  readonly VIEWER_EMAILS?: unknown;
  readonly INGEST_TOKEN?: unknown;
}

function isDb(v: unknown): v is SqlDatabase {
  return typeof v === "object" && v !== null && typeof (v as { prepare?: unknown }).prepare === "function" && typeof (v as { batch?: unknown }).batch === "function";
}
const text = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

function serveAsset(request: Request): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  const key = pathname === "/" ? "/index.html" : pathname;
  const type = CONTENT_TYPES.get(key);
  if (type === undefined) return Promise.resolve(error(404, "not_found"));
  return Promise.resolve(new Response(SITES_STATIC_FILES[key], {
    headers: {
      "Content-Type": type,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'",
    },
  }));
}

async function handleSitesMcp(request: Request, ctx: AppContext): Promise<Response> {
  const principal = await authenticateUser(request, ctx.auth, ctx.services);
  if (!principal.ok) return error(principal.status, "unauthorized");
  if (principal.principal.role !== "ADMIN") return error(403, "forbidden");

  const message: unknown = await request.clone().json().catch(() => null);
  if (typeof message === "object" && message !== null
    && "jsonrpc" in message && message.jsonrpc === "2.0"
    && "method" in message && message.method === "server/discover"
    && "id" in message && (typeof message.id === "string" || typeof message.id === "number" || message.id === null)) {
    return json({ jsonrpc: "2.0", id: message.id, result: { supportedVersions: ["2026-07-28"], capabilities: { tools: {} } } });
  }

  // サーバー内だけで既存の取込認証に接続する。
  const token = ctx.auth.ingestToken;
  if (token === null || token.length < MIN_TOKEN_LENGTH) return error(503, "ingest_not_configured");
  const headers = new Headers(request.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return handleRequest(new Request(request, { headers }), ctx);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/healthz") return json({ ok: true });
    if (!isDb(env.DB)) return error(503, "database_not_bound");
    const hasSiteIdentity = text(request.headers.get(USER_ID_HEADER)) !== null
      && text(request.headers.get(DEFAULT_EMAIL_HEADER)) !== null;
    if (path.startsWith("/api/") && path !== INGEST_PATH && !hasSiteIdentity) {
      return error(401, "unauthorized");
    }
    const ctx: AppContext = {
      services: createServices(env.DB, systemClock),
      auth: {
        emailHeader: DEFAULT_EMAIL_HEADER,
        ownerEmails: parseEmails(text(env.OWNER_EMAILS)),
        viewerEmails: parseEmails(text(env.VIEWER_EMAILS)),
        ingestToken: text(env.INGEST_TOKEN),
        devUserEmail: null,
      },
      assets: serveAsset,
    };
    if (path === "/mcp" && request.method === "POST" && hasSiteIdentity) {
      return handleSitesMcp(request, ctx);
    }
    return handleRequest(request, ctx);
  },
};
