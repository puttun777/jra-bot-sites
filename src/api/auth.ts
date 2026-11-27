/**
 * 認証・認可（jra-bot-web dashboard/api/ApiAuthFilter.kt・CsrfGuardFilter の役割の移植）。
 *
 * - 人（画面）: Sites が注入する本人のメール（既定のヘッダ名 `oai-authenticated-user-email`。**公式仕様で未確認**: docs/SITES_CONSTRAINTS.md E-1）。
 *   役割は app_user 表、無ければ環境変数 OWNER_EMAILS（ADMIN）/ VIEWER_EMAILS（VIEWER）。どちらにも無い人は 403。ヘッダが無ければ 401。
 * - 機械（MCP・取込）: `Authorization: Bearer <token>`。agent 表（SHA-256 のハッシュ）か、環境変数 INGEST_TOKEN。
 * - ローカルの疑似ログイン（devUserEmail）は**ローカルサーバの入口だけ**が渡す。Sites の入口（sites/worker.ts）は渡さない。
 * - 変更系（POST）は CSRF 対策の印 `X-Requested-With: jrabot-dashboard` を要求する（画面の api.ts が付ける）。機械の呼び出しはベアラーで代える。
 */
import { sha256Hex } from "../domain/race.js";
import type { Services } from "../application/services.js";

export type Role = "VIEWER" | "ADMIN";
export interface Principal {
  readonly kind: "user" | "agent";
  readonly id: string;
  readonly role: Role;
  readonly tenantId: number;
}

export interface AuthConfig {
  readonly emailHeader: string;
  readonly ownerEmails: readonly string[];
  readonly viewerEmails: readonly string[];
  /** 32 文字以上でなければ無効（短いトークンは受け付けない）。 */
  readonly ingestToken: string | null;
  /** ローカル専用の疑似ログイン。Sites の入口では必ず null。 */
  readonly devUserEmail: string | null;
}

export const DEFAULT_EMAIL_HEADER = "oai-authenticated-user-email";
export const CSRF_HEADER = { name: "x-requested-with", value: "jrabot-dashboard" } as const;
export const MIN_TOKEN_LENGTH = 32;

export function parseEmails(v: string | undefined | null): string[] {
  return (v ?? "")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter((x) => /^[^@\s]+@[^@\s]+$/.test(x) && x.length <= 254);
}

export type AuthResult = { ok: true; principal: Principal } | { ok: false; status: 401 | 403 };

/** 画面（人）の認証。 */
export async function authenticateUser(req: Request, cfg: AuthConfig, s: Services): Promise<AuthResult> {
  const raw = cfg.devUserEmail ?? req.headers.get(cfg.emailHeader);
  if (raw === null || raw.trim() === "") return { ok: false, status: 401 };
  const email = raw.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(email) || email.length > 254) return { ok: false, status: 401 };
  const user = await s.access.findUser(email);
  if (user !== null) return user.enabled ? { ok: true, principal: { kind: "user", id: email, role: user.role, tenantId: user.tenantId } } : { ok: false, status: 403 };
  if (cfg.ownerEmails.includes(email)) return { ok: true, principal: { kind: "user", id: email, role: "ADMIN", tenantId: 1 } };
  if (cfg.viewerEmails.includes(email)) return { ok: true, principal: { kind: "user", id: email, role: "VIEWER", tenantId: 1 } };
  return { ok: false, status: 403 };
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** 機械（ベアラートークン）の認証。取込クライアントは ADMIN 相当の書込みだけを許す（画面の管理操作には使えない）。 */
export async function authenticateAgent(req: Request, cfg: AuthConfig, s: Services, now: Date): Promise<AuthResult> {
  const h = req.headers.get("authorization");
  if (h === null || !h.startsWith("Bearer ")) return { ok: false, status: 401 };
  const token = h.slice(7).trim();
  if (token.length < MIN_TOKEN_LENGTH || token.length > 512) return { ok: false, status: 401 };
  const hash = await sha256Hex(token);
  if (cfg.ingestToken !== null && cfg.ingestToken.length >= MIN_TOKEN_LENGTH && constantTimeEqual(hash, await sha256Hex(cfg.ingestToken))) {
    return { ok: true, principal: { kind: "agent", id: "env-token", role: "ADMIN", tenantId: 1 } };
  }
  const agent = await s.agents.findByTokenHash(hash);
  if (agent === null || agent.status !== "ACTIVE" || Date.parse(agent.tokenExpiresAt) <= now.getTime()) return { ok: false, status: 401 };
  return { ok: true, principal: { kind: "agent", id: agent.agentId, role: "ADMIN", tenantId: agent.tenantId } };
}

/** 取込クライアントのトークンを発行（表示は 1 回だけ。保存はハッシュ）。 */
export function newToken(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}
