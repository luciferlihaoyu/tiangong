/**
 * Todo 20 (Beidou plan): canonical request-hash normalization (consumed by
 * Todo 21 for idempotent external task identity).
 *
 * RFC 8785 (JCS) JSON canonicalization over the EXACT named field set:
 *   (originSystem, external_ref, idempotency_key, operation, target,
 *    params_snapshot)
 * with explicit JSON normalization:
 *   - UTF-8 bytes (no \uXXXX escaping of non-ASCII)
 *   - JCS key ordering (length first, then lexicographic UTF-8 byte order)
 *   - sorted params_snapshot (recursively)
 *   - integers as JSON numbers
 *   - no whitespace
 *
 * The canonical fields are exactly the named set above — no extra fields, no
 * field ordering choice. The resulting sha256 hex is recorded alongside the
 * idempotency row so duplicate Beidou create attempts with the same canonical
 * hash return the same TG id; the same hash is reused on get-by-reference.
 */

import { createHash } from "node:crypto";

export const CANONICAL_FIELDS = [
  "originSystem",
  "external_ref",
  "idempotency_key",
  "operation",
  "target",
  "params_snapshot",
] as const;

export type CanonicalRequest = {
  readonly originSystem: string;
  readonly external_ref: string;
  readonly idempotency_key: string;
  readonly operation: string;
  readonly target: string;
  readonly params_snapshot: Readonly<Record<string, unknown>>;
};

/**
 * RFC 8785 key ordering: shortest UTF-8 key first; equal lengths ordered by
 * lexicographic byte order of the UTF-8 encoding.
 */
function jcsKeyCompare(a: string, b: string): number {
  const aLen = Buffer.byteLength(a, "utf8");
  const bLen = Buffer.byteLength(b, "utf8");
  if (aLen !== bLen) return aLen - bLen;
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/**
 * Canonical JSON serialization per RFC 8785: object keys sorted by
 * (length, byte order), strings emitted as UTF-8 (JSON.stringify escaping,
 * which produces no whitespace and standard string escapes), numbers as JSON
 * numbers, booleans/null verbatim.
 */
export function jcsSerialize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return serializeNumber(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => jcsSerialize(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort(jcsKeyCompare);
    const parts = keys.map((key) => `${JSON.stringify(key)}:${jcsSerialize(record[key])}`);
    return `{${parts.join(",")}}`;
  }
  // undefined / functions are not valid JCS members; drop them (empty string
  // never matches a valid document, keeps hashing deterministic).
  throw new TypeError(`jcsSerialize: unsupported value type ${typeof value}`);
}

/** RFC 8785 number serialization: integers as JSON numbers, no exponent. */
function serializeNumber(value: number): string {
  if (!Number.isFinite(value)) throw new TypeError(`jcsSerialize: non-finite number ${value}`);
  // JSON.stringify(1e2) === "100" in ES2019+; NaN/Infinity already rejected.
  return JSON.stringify(value);
}

/**
 * Canonical JSON text over the named field set in frozen order. The output
 * contains no whitespace and is fully deterministic.
 */
export function canonicalJson(req: CanonicalRequest): string {
  return jcsSerialize({
    originSystem: req.originSystem,
    external_ref: req.external_ref,
    idempotency_key: req.idempotency_key,
    operation: req.operation,
    target: req.target,
    params_snapshot: req.params_snapshot,
  });
}

/** sha256 hex of the canonical JSON (the recorded request hash). */
export function canonicalRequestHash(req: CanonicalRequest): string {
  return createHash("sha256").update(canonicalJson(req), "utf8").digest("hex");
}
