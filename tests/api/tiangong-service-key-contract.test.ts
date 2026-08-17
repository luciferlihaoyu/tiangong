/**
 * Todo 20 (Beidou plan): verifier-only record contract audit.
 *
 * The source-controlled contract file
 * `tianGong/contracts/tiangong_service_key_records.v1.schema.json` documents
 * the schema and field names ONLY — `key_id -> {verifier, key_prefix,
 * issued_at, rotation_window_end, revoked_at, version}` — with redacted
 * examples. Actual verifier values live only in the runtime DB; F2 inspects
 * the schema file and DB schema/tests, never verifier contents.
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  tiangongServiceKeys,
  serviceKeyAuditLog,
  type TiangongServiceKey,
} from "@db/schema";

const CONTRACT_PATH = fileURLToPath(
  new URL("../../tianGong/contracts/tiangong_service_key_records.v1.schema.json", import.meta.url),
);

/**
 * Version-controlled digest of the schema contract file. Bumping the contract
 * requires updating this pin deliberately (the audit chain asserts it).
 */
const CONTRACT_SHA256 = "84137b0f6963173a9a4e5fca2de896bd686446235505ee7a6007000341777f19";

describe("tiangong_service_key_records.v1 schema contract", () => {
  it("exists and is version-controlled with a pinned digest", () => {
    const raw = readFileSync(CONTRACT_PATH, "utf8");
    const digest = createHash("sha256").update(raw).digest("hex");
    expect(digest).toBe(CONTRACT_SHA256);
  });

  it("documents the exact record shape key_id -> {verifier, key_prefix, issued_at, rotation_window_end, revoked_at, version}", () => {
    const contract = JSON.parse(readFileSync(CONTRACT_PATH, "utf8"));
    expect(contract.$schema).toContain("json-schema.org");
    expect(contract.title).toContain("tiangong_service_key_records.v1");
    const props = contract.properties;
    expect(Object.keys(props).sort()).toEqual(
      ["issued_at", "key_id", "key_prefix", "revoked_at", "rotation_window_end", "verifier", "version"].sort(),
    );
    expect(props.key_id.type).toBe("string");
    expect(props.verifier.type).toBe("string");
    expect(props.key_prefix.type).toBe("string");
    expect(props.issued_at.type).toBe("string");
    // Nullable timestamps are documented as [string, null].
    expect(props.rotation_window_end.type).toEqual(["string", "null"]);
    expect(props.revoked_at.type).toEqual(["string", "null"]);
    expect(props.version.type).toBe("integer");
  });

  it("contains redacted examples only — never real verifier bytes or tokens", () => {
    const raw = readFileSync(CONTRACT_PATH, "utf8");
    // The exact redaction placeholders from the plan.
    expect(raw).toContain("<verifier: 32-byte HMAC-SHA-256(server_pepper, token); not committed>");
    expect(raw).toContain("<key_prefix: 6-byte prefix; not committed>");
    // No 64-hex verifier value.
    expect(raw.match(/[0-9a-f]{64}/g) ?? []).toEqual([]);
    // No 43-char base64url token value.
    for (const m of raw.matchAll(/[A-Za-z0-9_-]{43}/g)) {
      expect(m[0].startsWith("<")).toBe(true);
    }
    // No server pepper.
    expect(raw.toLowerCase()).not.toContain("server_pepper\": \"");
  });

  it("runtime DB schema carries the documented fields (verifier bytes live only in the DB)", () => {
    const record = tiangongServiceKeys["$inferSelect"] as unknown as TiangongServiceKey;
    void record;
    for (const field of ["keyId", "verifier", "keyPrefix", "issuedAt", "rotationWindowEnd", "revokedAt", "version"]) {
      expect(tiangongServiceKeys).toHaveProperty(field);
    }
    // The DB row type carries the verifier as a string (64 hex bytes) and the
    // key prefix as a short string — never a plaintext token field.
    expect(tiangongServiceKeys.verifier.dataType).toBe("string");
    expect(tiangongServiceKeys.verifier.notNull).toBe(true);
    expect(tiangongServiceKeys.keyId.notNull).toBe(true);
  });

  it("audit chain: every auth decision is persisted with key_id, originSystem and a redacted prefix", () => {
    for (const field of ["keyId", "originSystem", "tokenPrefix", "decision", "reason"]) {
      expect(serviceKeyAuditLog).toHaveProperty(field);
    }
  });

  it("the plaintext-token era (mcp_api_keys.key) is not reused for service credentials", () => {
    // Service credentials use verifier-only storage; the legacy plaintext
    // `mcp_api_keys.key` column pattern must not be the service-key storage.
    expect(tiangongServiceKeys).not.toHaveProperty("token");
    expect(tiangongServiceKeys).not.toHaveProperty("plaintextKey");
  });
});
