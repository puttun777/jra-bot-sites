/**
 * ローカル開発サーバ（Node の http → Web 標準の Request/Response → handleRequest）。**本番では使わない**。
 * - DB: LOCAL_DB_PATH（既定 data/local.sqlite）。起動時にマイグレーションを適用する。
 * - 疑似ログイン: LOCAL_DEV_USER_EMAIL（既定 owner@example.invalid を ADMIN として扱う）。Sites の入口には存在しない。
 * - 待受けは 127.0.0.1 だけ（外部に公開しない）。
 */
import { createServer } from "node:http";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { createServices } from "../application/services.js";
import { DEFAULT_EMAIL_HEADER, parseEmails } from "../api/auth.js";
import { handleRequest } from "../api/router.js";
import { systemClock } from "../domain/race.js";
import { NodeSqliteDatabase } from "../infrastructure/db/nodeSqlite.js";
import { migrate } from "./migrate.js";

const dbPath = process.env["LOCAL_DB_PATH"] ?? "data/local.sqlite";
mkdirSync(dirname(dbPath), { recursive: true });
const db = new NodeSqliteDatabase(dbPath);
const applied = migrate(db, "migrations");
if (applied.length > 0) console.log(`migrations applied: ${applied.join(", ")}`);

const devUser = (process.env["LOCAL_DEV_USER_EMAIL"] ?? "owner@example.invalid").toLowerCase();
const services = createServices(db, systemClock);
const PUBLIC = "dist/public";
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

function assets(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname === "/" ? "/index.html" : url.pathname;
  const file = normalize(join(PUBLIC, p));
  if (!file.startsWith(normalize(PUBLIC)) || !existsSync(file)) return Promise.resolve(new Response("not found", { status: 404 }));
  return Promise.resolve(new Response(readFileSync(file), { headers: { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" } }));
}

const port = Number(process.env["PORT"] ?? "8787");
createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    const method = req.method ?? "GET";
    const request = new Request(`http://127.0.0.1:${port}${req.url ?? "/"}`, { method, headers, ...(method === "GET" || method === "HEAD" ? {} : { body: Buffer.concat(chunks) }) });
    handleRequest(request, {
      services,
      auth: { emailHeader: DEFAULT_EMAIL_HEADER, ownerEmails: [devUser, ...parseEmails(process.env["OWNER_EMAILS"])], viewerEmails: parseEmails(process.env["VIEWER_EMAILS"]), ingestToken: process.env["INGEST_TOKEN"] ?? null, devUserEmail: devUser },
      assets,
    })
      .then(async (r) => {
        res.writeHead(r.status, Object.fromEntries(r.headers.entries()));
        res.end(Buffer.from(await r.arrayBuffer()));
      })
      .catch(() => {
        res.writeHead(500);
        res.end();
      });
  });
}).listen(port, "127.0.0.1", () => {
  console.log(`jra-bot-sites local: http://127.0.0.1:${port}/ (user=${devUser}, db=${dbPath})`);
});
