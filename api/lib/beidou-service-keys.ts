/**
 * Todo 20 (Beidou plan): Beidou-to-Tiangong service key lifecycle.
 *
 * Frozen model:
 * - Exact request headers: `Authorization: Bearer <token>` +
 *   `X-TG-Service-Key-ID`. The token is a 32-byte cryptographically random
 *   secret encoded base64url (no padding), generated exactly once at issuance
 *   and shown to the operator exactly once — it can never be retrieved again.
 * - Verifier storage: the DB stores the full 32-byte
 *   `HMAC-SHA-256(server_pepper, token)` verifier plus `key_id` and a 6-byte
 *   key-id prefix ONLY. The verifier is NOT `HMAC(token, server_pepper)` so
 *   no remote party can reconstruct the token from the verifier. The server
 *   pepper is a deployment secret (env/vault). The plaintext token never
 *   appears in source, DB, response bodies or logs after issuance; it lives
 *   only in runtime memory at the Beidou-side holder.
 * - Comparison uses crypto.timingSafeEqual (constant-time).
 * - Rotation issues a new key_id + new 32-byte token; the previous key is
 *   retained through `key-overlap retention = max(callback retry window)`
 *   then revoked. Revocation invalidates a key_id immediately (rejected by
 *   key_id lookup; the verifier stays in storage marked revoked).
 * - Independent directional keyrings (frozen): the Beidou-to-Tiangong service
 *   key (this module) versus the Tiangong-to-Beidou callback HMAC keyring
 *   (Todo 22) are independent — this module does NOT own callback-secret
 *   storage.
 * - Every auth decision is audit-logged with key_id, originSystem and a
 *   one-way-redacted token prefix only.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getDb } from "../queries/connection";
import { tiangongServiceKeys, serviceKeyAuditLog } from "@db/schema";
import { eq, and, isNull } from "drizzle-orm";

/** Least-privilege allowlist for external research-task operations. */
export const BEIDOU_SERVICE_SCOPES = [
  "research-task:create",
  "research-task:read",
  "research-task:cancel",
  "research-task:artifact-stream",
] as const;

export type BeidouServiceScope = (typeof BEIDOU_SERVICE_SCOPES)[number];

export const ORIGIN_SYSTEM_BEIDOU = "beidou" as const;

/** Default overlap retention for rotated keys = max callback retry window. */
export const DEFAULT_ROTATION_RETENTION_MS = 24 * 60 * 60 * 1000;

const TOKEN_BYTES = 32;
const KEY_ID_PREFIX = "tgsk_";
const KEY_ID_ENTROPY_BYTES = 16;
const TOKEN_PREFIX_BYTES = 6;

export type ServiceKeyRecord = {
  readonly id: number;
  readonly keyId: string;
  readonly verifier: string;
  readonly keyPrefix: string;
  readonly originSystem: string;
  readonly workspaceSlug: string;
  readonly projectSlug: string;
  readonly scopes: readonly BeidouServiceScope[];
  readonly issuedAt: Date;
  readonly rotationWindowEnd: Date | null;
  readonly revokedAt: Date | null;
  readonly revokedReason: string | null;
  readonly version: number;
};

/** Scoped principal derived from a verified key (no secrets). */
export type ServicePrincipal = {
  readonly keyId: string;
  readonly originSystem: "beidou";
  readonly workspaceSlug: string;
  readonly projectSlug: string;
  readonly scopes: readonly BeidouServiceScope[];
  /** One-way-redacted 6-byte token prefix (base64url, 8 chars). */
  readonly tokenPrefix: string;
};

/** Result of issuance/rotation: the token is shown exactly once here. */
export type IssuedKey = {
  readonly keyId: string;
  readonly token: string;
  readonly tokenPrefix: string;
};

export type VerifyResult = {
  readonly valid: boolean;
  readonly reason?: string;
  readonly principal?: ServicePrincipal;
};

export type IssueServiceKeyParams = {
  readonly workspaceSlug: string;
  readonly projectSlug: string;
  readonly scopes: readonly BeidouServiceScope[];
  readonly originSystem?: "beidou";
  readonly now?: Date;
  readonly rotationRetentionMs?: number;
};

// ─── Pepper resolution (call-time, so tests/operators can inject) ───
export function getServerPepper(): string {
  return process.env.TIANGONG_SERVICE_KEY_PEPPER ?? "";
}

export function getRotationRetentionMs(): number {
  const raw = process.env.TIANGONG_SERVICE_KEY_ROTATION_RETENTION_MS;
  if (!raw) return DEFAULT_ROTATION_RETENTION_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ROTATION_RETENTION_MS;
}

/** base64url (no padding) encoding, as mandated for tokens/nonces/prefixes. */
export function base64UrlNoPadding(bytes: Buffer): string {
  return bytes.toString("base64url");
}

/** One-way-redacted prefix: first 6 bytes of the token, base64url (8 chars). */
export function tokenPrefixOf(token: string): string {
  const bytes = Buffer.from(token, "base64url");
  return base64UrlNoPadding(bytes.subarray(0, TOKEN_PREFIX_BYTES));
}

export function isBase64UrlToken(token: string): boolean {
  if (typeof token !== "string" || token.length !== 43) return false;
  if (!/^[A-Za-z0-9_-]+$/.test(token)) return false;
  const bytes = Buffer.from(token, "base64url");
  return bytes.length === TOKEN_BYTES;
}

/** Constant-time comparison; length mismatch never throws. */
export function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ─── Verifier math (exported for tests/F2 audit) ───
export function computeVerifier(pepper: string, token: string): string {
  // Direction matters: HMAC(server_pepper, token), NOT HMAC(token, server_pepper).
  return createHmac("sha256", pepper).update(token, "utf8").digest("hex");
}

function newToken(): string {
  return base64UrlNoPadding(randomBytes(TOKEN_BYTES));
}

function newKeyId(): string {
  return `${KEY_ID_PREFIX}${base64UrlNoPadding(randomBytes(KEY_ID_ENTROPY_BYTES))}`;
}

function rowToRecord(row: typeof tiangongServiceKeys.$inferSelect): ServiceKeyRecord {
  return {
    id: row.id,
    keyId: row.keyId,
    verifier: row.verifier,
    keyPrefix: row.keyPrefix,
    originSystem: row.originSystem,
    workspaceSlug: row.workspaceSlug,
    projectSlug: row.projectSlug,
    scopes: parseScopes(row.scopes),
    issuedAt: toDate(row.issuedAt),
    rotationWindowEnd: toDateOrNull(row.rotationWindowEnd),
    revokedAt: toDateOrNull(row.revokedAt),
    revokedReason: row.revokedReason ?? null,
    version: row.version ?? 1,
  };
}

function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === "string") return new Date(value);
  if (typeof value === "number") return new Date(value);
  return new Date(0);
}

function toDateOrNull(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  return toDate(value);
}

function parseScopes(raw: string | null): BeidouServiceScope[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is BeidouServiceScope =>
      BEIDOU_SERVICE_SCOPES.includes(s as BeidouServiceScope),
    );
  } catch {
    return [];
  }
}

function validateScopes(scopes: readonly BeidouServiceScope[]): void {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw new Error("scopes 必须是非空白名单（不允许通配符 scope）");
  }
  for (const scope of scopes) {
    if (scope.includes("*")) {
      throw new Error(`scope 不允许通配符: ${scope}`);
    }
    if (!BEIDOU_SERVICE_SCOPES.includes(scope)) {
      throw new Error(`未知 scope: ${scope}（允许: ${BEIDOU_SERVICE_SCOPES.join(", ")}）`);
    }
  }
}

// ─── Audit (fire-and-forget; key_id + originSystem + redacted prefix only) ───
function writeAuthAudit(entry: {
  keyId: string | null;
  originSystem: string;
  tokenPrefix: string;
  decision: "authenticated" | "denied";
  reason: string;
}) {
  const db = getDb();
  db.insert(serviceKeyAuditLog)
    .values({
      keyId: entry.keyId,
      originSystem: entry.originSystem.slice(0, 32),
      tokenPrefix: entry.tokenPrefix.slice(0, 12),
      decision: entry.decision,
      reason: entry.reason.slice(0, 100),
    })
    .catch(() => {
      // Never block auth on audit failures.
    });
}

// ─── Issuance / rotation / revocation ───

export async function issueServiceKey(params: IssueServiceKeyParams): Promise<IssuedKey> {
  validateScopes(params.scopes);
  const now = params.now ?? new Date();
  const token = newToken();
  const keyId = newKeyId();
  const pepper = getServerPepper();
  if (!pepper) {
    // Fail closed at issuance: without a pepper we cannot store a verifier.
    throw new Error("TIANGONG_SERVICE_KEY_PEPPER 未配置，拒绝签发服务密钥");
  }
  const db = getDb();
  await db.insert(tiangongServiceKeys).values({
    keyId,
    verifier: computeVerifier(pepper, token),
    keyPrefix: tokenPrefixOf(token),
    originSystem: params.originSystem ?? ORIGIN_SYSTEM_BEIDOU,
    workspaceSlug: params.workspaceSlug,
    projectSlug: params.projectSlug,
    scopes: JSON.stringify(params.scopes),
    issuedAt: now,
    rotationWindowEnd: null,
    revokedAt: null,
    version: 1,
  });
  // The token is returned exactly once — it is not retrievable afterwards.
  return { keyId, token, tokenPrefix: tokenPrefixOf(token) };
}

async function loadRecord(keyId: string): Promise<ServiceKeyRecord | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(tiangongServiceKeys)
    .where(eq(tiangongServiceKeys.keyId, keyId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return rowToRecord(row);
}

/**
 * Constant-time verifier check: HMAC(pepper, presented token) against the
 * stored 32-byte verifier via crypto.timingSafeEqual.
 */
async function checkVerifier(record: ServiceKeyRecord, token: string): Promise<boolean> {
  const pepper = getServerPepper();
  if (!pepper) return false;
  const candidate = createHmac("sha256", pepper).update(token, "utf8").digest();
  const stored = Buffer.from(record.verifier, "hex");
  return constantTimeEqual(candidate, stored);
}

export async function verifyServiceKey(
  keyId: string,
  token: string,
  now?: number,
): Promise<VerifyResult> {
  const nowDate = new Date(now ?? Date.now());

  if (!isBase64UrlToken(token)) {
    writeAuthAudit({ keyId, originSystem: "unknown", tokenPrefix: redactedPrefixOf(token), decision: "denied", reason: "malformed_token" });
    return { valid: false, reason: "malformed_token" };
  }
  if (!getServerPepper()) {
    writeAuthAudit({ keyId, originSystem: "unknown", tokenPrefix: redactedPrefixOf(token), decision: "denied", reason: "pepper_unconfigured" });
    return { valid: false, reason: "pepper_unconfigured" };
  }

  const record = await loadRecord(keyId);
  if (!record) {
    writeAuthAudit({ keyId, originSystem: "unknown", tokenPrefix: redactedPrefixOf(token), decision: "denied", reason: "unknown_key_id" });
    return { valid: false, reason: "unknown_key_id" };
  }

  const prefix = tokenPrefixOf(token);
  const auditBase = { keyId: record.keyId, originSystem: record.originSystem, tokenPrefix: prefix };

  if (record.revokedAt !== null) {
    writeAuthAudit({ ...auditBase, decision: "denied", reason: "revoked" });
    return { valid: false, reason: "revoked" };
  }

  // Lazy revocation: rotation keeps the previous key through the overlap
  // window; once the window elapses it is revoked (persisted).
  if (record.rotationWindowEnd !== null && nowDate.getTime() > record.rotationWindowEnd.getTime()) {
    const db = getDb();
    await db
      .update(tiangongServiceKeys)
      .set({ revokedAt: nowDate, revokedReason: "rotation_window_elapsed" })
      .where(eq(tiangongServiceKeys.keyId, record.keyId));
    writeAuthAudit({ ...auditBase, decision: "denied", reason: "revoked" });
    return { valid: false, reason: "revoked" };
  }

  const match = await checkVerifier(record, token);
  if (!match) {
    writeAuthAudit({ ...auditBase, decision: "denied", reason: "verifier_mismatch" });
    return { valid: false, reason: "verifier_mismatch" };
  }

  writeAuthAudit({ ...auditBase, decision: "authenticated", reason: "ok" });
  return {
    valid: true,
    principal: {
      keyId: record.keyId,
      originSystem: "beidou",
      workspaceSlug: record.workspaceSlug,
      projectSlug: record.projectSlug,
      scopes: record.scopes,
      tokenPrefix: prefix,
    },
  };
}

function redactedPrefixOf(token: string): string {
  try {
    return tokenPrefixOf(token);
  } catch {
    return token.slice(0, 8) ?? "";
  }
}

/**
 * Rotation: issue a new key_id + new 32-byte token; the previous key remains
 * valid through the overlap retention window (= max callback retry window),
 * then is revoked. Returns the new credential (token shown once).
 */
export async function rotateServiceKey(
  keyId: string,
  opts: { retentionMs?: number; now?: Date | number } = {},
): Promise<IssuedKey> {
  const now = opts.now === undefined ? new Date() : toDate(opts.now);
  const retentionMs = opts.retentionMs ?? getRotationRetentionMs();
  const record = await loadRecord(keyId);
  if (!record) {
    throw new Error(`服务密钥不存在: ${keyId}`);
  }
  if (record.revokedAt !== null) {
    throw new Error(`服务密钥已撤销，无法轮换: ${keyId}`);
  }
  const db = getDb();
  // Retain the previous key through the overlap window (lazily revoked after).
  await db
    .update(tiangongServiceKeys)
    .set({
      rotationWindowEnd: new Date(now.getTime() + retentionMs),
      updatedAt: now,
    })
    .where(eq(tiangongServiceKeys.keyId, keyId));
  return issueServiceKey({
    workspaceSlug: record.workspaceSlug,
    projectSlug: record.projectSlug,
    scopes: record.scopes,
    originSystem: ORIGIN_SYSTEM_BEIDOU,
    now,
  });
}

/** Revocation invalidates the key_id immediately (verifier retained). */
export async function revokeServiceKey(keyId: string, reason: string, now?: Date): Promise<void> {
  const db = getDb();
  await db
    .update(tiangongServiceKeys)
    .set({
      revokedAt: now ?? new Date(),
      revokedReason: reason.slice(0, 100),
    })
    .where(and(eq(tiangongServiceKeys.keyId, keyId), isNull(tiangongServiceKeys.revokedAt)));
}

// Re-exported so callers have one import site.
export const SERVICE_KEY_SCOPES = BEIDOU_SERVICE_SCOPES;
