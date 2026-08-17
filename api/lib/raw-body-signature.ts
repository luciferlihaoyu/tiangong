/**
 * Todo 20 (Beidou plan): frozen raw-body signature verification contract
 * (consumed by Todo 22 for Tiangong→Beidou callbacks and by the directional
 * callback keyring verifier on the Beidou side).
 *
 * Frozen order and rules:
 * 1. `Content-Length` and `Content-Type` are verified against the raw-body
 *    signature FIRST — before any JSON parsing and before hashing.
 * 2. Signature algorithm: HMAC-SHA-256 over
 *    `timestamp + "\n" + nonce + "\n" + raw_body`; signature header is the
 *    lowercase hex digest.
 * 3. Timestamp unit: Unix seconds; allowed skew +/-300s.
 * 4. Nonce format: base64url-encoded 16-byte random value; a seen nonce is
 *    rejected (replay protection).
 * 5. Body size limit is enforced BEFORE hashing.
 *
 * Header names (frozen, shared with Todo 22): x-tg-key-id, x-tg-timestamp,
 * x-tg-nonce, x-tg-signature.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const RAW_BODY_SIGNATURE_HEADERS = {
  keyId: "x-tg-key-id",
  timestamp: "x-tg-timestamp",
  nonce: "x-tg-nonce",
  signature: "x-tg-signature",
} as const;

export const ALLOWED_TIMESTAMP_SKEW_SECONDS = 300;
export const NONCE_BYTES = 16;
/** Body size limit enforced before hashing (callbacks carry small JSON). */
export const MAX_CALLBACK_BODY_BYTES = 1024 * 1024;

/** Replay window = skew + buffer. */
const REPLAY_TTL_MS = (ALLOWED_TIMESTAMP_SKEW_SECONDS + 60) * 1000;

type HeaderBag = Headers | Record<string, string>;

export type RawBodySignHeaders = {
  "content-length": string;
  "content-type": string;
  "x-tg-key-id": string;
  "x-tg-timestamp": string;
  "x-tg-nonce": string;
  "x-tg-signature": string;
};

export type RawBodySignResult = {
  readonly valid: boolean;
  readonly reason?: string;
};

export type ResolveSecret = (keyId: string) => string | Buffer | null;

export function generateNonce(): string {
  return randomBytes(NONCE_BYTES).toString("base64url");
}

/** Sign a raw body with the frozen header contract (test/QA + Todo 22). */
export function signRawBody(params: {
  keyId: string;
  secret: string | Buffer;
  body: string | Buffer;
  timestamp?: number;
  nonce?: string;
}): { headers: RawBodySignHeaders; signature: string } {
  const raw = typeof params.body === "string" ? Buffer.from(params.body, "utf8") : params.body;
  const timestamp = params.timestamp ?? Math.floor(Date.now() / 1000);
  const nonce = params.nonce ?? generateNonce();
  const signature = createHmac("sha256", params.secret)
    .update(`${timestamp}\n${nonce}\n`, "utf8")
    .update(raw)
    .digest("hex");
  return {
    signature,
    headers: {
      "content-length": String(raw.length),
      "content-type": "application/json",
      "x-tg-key-id": params.keyId,
      "x-tg-timestamp": String(timestamp),
      "x-tg-nonce": nonce,
      "x-tg-signature": signature,
    },
  };
}

// ─── Replay protection (in-memory; keyed by keyId+nonce, TTL-bounded) ───
const nonceStore = new Map<string, number>();

function nonceKey(keyId: string, nonce: string): string {
  return `${keyId}:${nonce}`;
}

function pruneNonceStore(now: number): void {
  for (const [key, expiresAt] of nonceStore) {
    if (expiresAt < now) nonceStore.delete(key);
  }
}

function isNonceReplayed(keyId: string, nonce: string, now: number): boolean {
  pruneNonceStore(now);
  const key = nonceKey(keyId, nonce);
  if (nonceStore.has(key)) return true;
  nonceStore.set(key, now + REPLAY_TTL_MS);
  return false;
}

/** Test/QA-only: clear the in-memory replay store. */
export function resetNonceReplayStore(): void {
  nonceStore.clear();
}

function getHeader(bag: HeaderBag, name: string): string | null {
  if (typeof Headers !== "undefined" && bag instanceof Headers) {
    return bag.get(name);
  }
  const record = bag as Record<string, string>;
  const value = record[name.toLowerCase()];
  return value === undefined ? null : String(value);
}

function isValidNonce(nonce: string): boolean {
  if (typeof nonce !== "string" || !/^[A-Za-z0-9_-]+$/.test(nonce)) return false;
  try {
    return Buffer.from(nonce, "base64url").length === NONCE_BYTES;
  } catch {
    return false;
  }
}

/**
 * Verify a raw-body signature with the frozen order:
 * content-length → content-type → body-size-limit → timestamp(skew) →
 * nonce(format+replay) → signature(format) → HMAC (constant-time).
 */
export function verifyRawBodySignature(params: {
  headers: HeaderBag;
  rawBody: string | Buffer;
  resolveSecret: ResolveSecret;
  now?: number;
  bodySizeLimit?: number;
}): RawBodySignResult {
  const now = params.now ?? Date.now();
  const raw = typeof params.rawBody === "string" ? Buffer.from(params.rawBody, "utf8") : params.rawBody;
  const bodySizeLimit = params.bodySizeLimit ?? MAX_CALLBACK_BODY_BYTES;

  // 1a. Content-Length verified against the raw body FIRST (before hashing).
  const contentLengthHeader = getHeader(params.headers, "content-length");
  if (contentLengthHeader === null) return { valid: false, reason: "content_length_missing" };
  const declaredLength = Number(contentLengthHeader);
  if (!Number.isInteger(declaredLength) || declaredLength < 0) {
    return { valid: false, reason: "content_length_malformed" };
  }
  if (declaredLength !== raw.length) return { valid: false, reason: "content_length_mismatch" };

  // 1b. Content-Type must be JSON (before hashing).
  const contentType = getHeader(params.headers, "content-type") ?? "";
  const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (mime !== "application/json") return { valid: false, reason: "content_type_rejected" };

  // Body size limit enforced before hashing.
  if (raw.length > bodySizeLimit) return { valid: false, reason: "body_too_large" };

  // 2. Timestamp: Unix seconds, skew +/-300s.
  const timestampHeader = getHeader(params.headers, RAW_BODY_SIGNATURE_HEADERS.timestamp);
  if (timestampHeader === null || !/^\d{1,12}$/.test(timestampHeader)) {
    return { valid: false, reason: "timestamp_rejected" };
  }
  const timestamp = Number(timestampHeader);
  const nowSeconds = Math.floor(now / 1000);
  if (Math.abs(nowSeconds - timestamp) > ALLOWED_TIMESTAMP_SKEW_SECONDS) {
    return { valid: false, reason: "timestamp_rejected" };
  }

  // 3. Nonce: base64url 16-byte; replay rejection.
  const nonce = getHeader(params.headers, RAW_BODY_SIGNATURE_HEADERS.nonce);
  if (nonce === null || !isValidNonce(nonce)) return { valid: false, reason: "nonce_rejected" };

  // 4. Key id resolution.
  const keyId = getHeader(params.headers, RAW_BODY_SIGNATURE_HEADERS.keyId);
  if (keyId === null || keyId.length === 0 || keyId.length > 128) {
    return { valid: false, reason: "unknown_key_id" };
  }
  const secret = params.resolveSecret(keyId);
  if (secret === null || secret === undefined) return { valid: false, reason: "unknown_key_id" };

  // 5. Signature format + constant-time HMAC comparison.
  const signature = getHeader(params.headers, RAW_BODY_SIGNATURE_HEADERS.signature);
  if (signature === null || !/^[0-9a-f]{64}$/.test(signature)) {
    return { valid: false, reason: "signature_rejected" };
  }

  // Replay check happens after format validation but before HMAC work.
  if (isNonceReplayed(keyId, nonce, now)) return { valid: false, reason: "nonce_replayed" };

  const expected = createHmac("sha256", secret)
    .update(`${timestamp}\n${nonce}\n`, "utf8")
    .update(raw)
    .digest();
  const provided = Buffer.from(signature, "hex");
  if (expected.length !== provided.length) return { valid: false, reason: "signature_mismatch" };
  if (!timingSafeEqual(expected, provided)) return { valid: false, reason: "signature_mismatch" };

  return { valid: true };
}
