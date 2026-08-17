/**
 * Todo 20 (Beidou plan): Beidou-to-Tiangong service key lifecycle.
 *
 * Covers: 32-byte base64url (no padding) token shown exactly once;
 * verifier-only storage (full 32-byte HMAC-SHA-256(server_pepper, token),
 * never the token, never the reversed order); constant-time comparison;
 * rotation with overlap retention then revocation; immediate revocation;
 * key_id lookup; fail-closed when server pepper is unconfigured; audit
 * decisions logged with key_id + originSystem + one-way-redacted prefix only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac, randomBytes } from "node:crypto";
import { tiangongServiceKeys, serviceKeyAuditLog } from "@db/schema";

const shared = vi.hoisted(() => ({ db: null as unknown as import("./helpers/fake-db").FakeDb }));

vi.mock("../../api/queries/connection", async () => {
  const mod = await import("./helpers/fake-db");
  mod.fakeDbRegistry.instance = mod.createFakeDb();
  shared.db = mod.fakeDbRegistry.instance;
  return { getDb: () => mod.fakeDbRegistry.instance };
});

import {
  BEIDOU_SERVICE_SCOPES,
  issueServiceKey,
  verifyServiceKey,
  rotateServiceKey,
  revokeServiceKey,
  tokenPrefixOf,
  constantTimeEqual,
  type IssuedKey,
} from "../../api/lib/beidou-service-keys";

const TEST_PEPPER = "task20-test-pepper";

function setPepper(value: string | undefined) {
  if (value === undefined) delete process.env.TIANGONG_SERVICE_KEY_PEPPER;
  else process.env.TIANGONG_SERVICE_KEY_PEPPER = value;
}

const b64url = (buf: Buffer) => buf.toString("base64url");

describe("beidou service key lifecycle", () => {
  beforeEach(() => {
    setPepper(TEST_PEPPER);
    shared.db.reset();
  });

  afterEach(() => {
    setPepper(TEST_PEPPER);
  });

  it("issues a 32-byte base64url (no padding) token shown exactly once, with verifier-only storage", async () => {
    const issued = await issueServiceKey({
      workspaceSlug: "beidou-ws",
      projectSlug: "research",
      scopes: ["research-task:create", "research-task:read"],
    });

    // Token: 32 random bytes → 43 base64url chars, no padding.
    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issued.token.endsWith("=")).toBe(false);
    // key_id is a public identifier.
    expect(issued.keyId).toMatch(/^tgsk_[A-Za-z0-9_-]+$/);

    // Verifier stored: full 32-byte HMAC-SHA-256(server_pepper, token).
    const expectedVerifier = createHmac("sha256", TEST_PEPPER)
      .update(issued.token)
      .digest("hex");
    const rows = shared.db.rowsOfTable(tiangongServiceKeys);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.verifier).toBe(expectedVerifier);
    expect(row.verifier).toHaveLength(64);
    // The plaintext token must NOT be stored anywhere in the record.
    expect(JSON.stringify(row)).not.toContain(issued.token);
    expect(row.keyPrefix).toBe(tokenPrefixOf(issued.token));
    // key-id prefix only — the record never holds the full token.
    expect(String(row.keyPrefix)).toHaveLength(8);
    expect(String(row.keyPrefix)).not.toContain(issued.token);
  });

  it("stores HMAC(server_pepper, token) — not the reversed HMAC(token, server_pepper)", async () => {
    const issued = await issueServiceKey({
      workspaceSlug: "beidou-ws",
      projectSlug: "research",
      scopes: ["research-task:read"],
    });
    const reversed = createHmac("sha256", issued.token).update(TEST_PEPPER).digest("hex");
    const row = shared.db.rowsOfTable(tiangongServiceKeys)[0];
    expect(row.verifier).not.toBe(reversed);
    expect(row.verifier).toBe(
      createHmac("sha256", TEST_PEPPER).update(issued.token).digest("hex"),
    );
  });

  it("authenticates with the exact token and binds the service principal", async () => {
    const issued = await issueServiceKey({
      workspaceSlug: "beidou-ws",
      projectSlug: "research",
      scopes: ["research-task:create", "research-task:read", "research-task:cancel", "research-task:artifact-stream"],
    });
    const res = await verifyServiceKey(issued.keyId, issued.token);
    expect(res.valid).toBe(true);
    expect(res.principal).toMatchObject({
      keyId: issued.keyId,
      originSystem: "beidou",
      workspaceSlug: "beidou-ws",
      projectSlug: "research",
      scopes: BEIDOU_SERVICE_SCOPES,
    });
    expect(res.principal?.tokenPrefix).toBe(tokenPrefixOf(issued.token));
    // Verification never returns the token.
    expect(JSON.stringify(res)).not.toContain(issued.token);
  });

  it("rejects a wrong token and an unknown key_id (fail closed)", async () => {
    const issued = await issueServiceKey({
      workspaceSlug: "beidou-ws",
      projectSlug: "research",
      scopes: ["research-task:read"],
    });
    const wrong = b64url(randomBytes(32));
    const res = await verifyServiceKey(issued.keyId, wrong);
    expect(res.valid).toBe(false);
    expect(res.reason).toBe("verifier_mismatch");

    const unknown = await verifyServiceKey("tgsk_nonexistent", issued.token);
    expect(unknown.valid).toBe(false);
    expect(unknown.reason).toBe("unknown_key_id");
  });

  it("rejects tokens that are not 32-byte base64url", async () => {
    const issued = await issueServiceKey({
      workspaceSlug: "beidou-ws",
      projectSlug: "research",
      scopes: ["research-task:read"],
    });
    // Uppercased token is still 43 chars of valid base64url but wrong bytes —
    // format-valid, content-invalid → verifier_mismatch (not malformed).
    const upper = await verifyServiceKey(issued.keyId, issued.token.toUpperCase());
    expect(upper.valid).toBe(false);
    expect(upper.reason).toBe("verifier_mismatch");
    for (const bad of ["", "short", "a".repeat(64), "a".repeat(42), `${issued.token}=`]) {
      const res = await verifyServiceKey(issued.keyId, bad);
      expect(res.valid).toBe(false);
      expect(res.reason).toBe("malformed_token");
    }
  });

  it("uses constant-time comparison and guards length mismatch", async () => {
    const a = randomBytes(32);
    const b = randomBytes(32);
    expect(constantTimeEqual(a, b)).toBe(false);
    expect(constantTimeEqual(a, Buffer.from(a))).toBe(true);
    // Different lengths must not throw (timingSafeEqual would).
    expect(constantTimeEqual(a, randomBytes(16))).toBe(false);
  });

  it("revokes a key immediately and keeps rejecting it", async () => {
    const issued = await issueServiceKey({
      workspaceSlug: "beidou-ws",
      projectSlug: "research",
      scopes: ["research-task:read"],
    });
    await revokeServiceKey(issued.keyId, "qa_revocation");
    const res = await verifyServiceKey(issued.keyId, issued.token);
    expect(res.valid).toBe(false);
    expect(res.reason).toBe("revoked");
    const row = shared.db.rowsOfTable(tiangongServiceKeys)[0];
    expect(row.revokedAt).not.toBeNull();
    expect(row.revokedReason).toBe("qa_revocation");
    // The verifier still exists in storage (revoked, not deleted).
    expect(String(row.verifier)).toHaveLength(64);
  });

  it("rotation issues a new key_id + token; the old key stays valid through the overlap window then is revoked", async () => {
    const issued = await issueServiceKey({
      workspaceSlug: "beidou-ws",
      projectSlug: "research",
      scopes: ["research-task:read"],
      rotationRetentionMs: 86_400_000,
    });
    const rotated = await rotateServiceKey(issued.keyId, {
      retentionMs: 86_400_000,
      now: 1_750_000_000_000,
    });
    expect(rotated.keyId).not.toBe(issued.keyId);
    expect(rotated.token).not.toBe(issued.token);
    expect(rotated.token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // Old key valid inside the overlap window.
    const during = await verifyServiceKey(issued.keyId, issued.token, 1_750_000_000_000 + 3_600_000);
    expect(during.valid).toBe(true);

    // Old key revoked once the retention window has elapsed.
    const after = await verifyServiceKey(issued.keyId, issued.token, 1_750_000_000_000 + 86_400_001);
    expect(after.valid).toBe(false);
    expect(after.reason).toBe("revoked");
    // Lazy revocation is persisted.
    const oldRow = shared.db.rowsOfTable(tiangongServiceKeys).find((r) => r.keyId === issued.keyId)!;
    expect(oldRow.revokedAt).not.toBeNull();

    // New key is valid before and after the old one's window.
    const newKey = await verifyServiceKey(rotated.keyId, rotated.token, 1_750_000_000_000 + 172_800_000);
    expect(newKey.valid).toBe(true);
  });

  it("fails closed when the server pepper is unconfigured", async () => {
    const issued = await issueServiceKey({
      workspaceSlug: "beidou-ws",
      projectSlug: "research",
      scopes: ["research-task:read"],
    });
    setPepper(undefined);
    const res = await verifyServiceKey(issued.keyId, issued.token);
    expect(res.valid).toBe(false);
    expect(res.reason).toBe("pepper_unconfigured");
  });

  it("rejects wildcard or unknown scopes at issuance (least-privilege, no wildcard)", async () => {
    for (const badScopes of [["*"], ["research-task:create", "*"], ["admin:*"], ["research-task:run"]]) {
      await expect(
        issueServiceKey({
          workspaceSlug: "beidou-ws",
          projectSlug: "research",
          scopes: badScopes as never,
        }),
      ).rejects.toThrow(/scope/i);
    }
  });

  it("audit-logs every auth decision with key_id, originSystem and a one-way-redacted prefix only", async () => {
    const issued = await issueServiceKey({
      workspaceSlug: "beidou-ws",
      projectSlug: "research",
      scopes: ["research-task:read"],
    });
    await verifyServiceKey(issued.keyId, issued.token);
    await verifyServiceKey(issued.keyId, b64url(randomBytes(32)));
    await verifyServiceKey("tgsk_unknown", b64url(randomBytes(32)));
    await revokeServiceKey(issued.keyId, "qa");
    await verifyServiceKey(issued.keyId, issued.token);

    const rows = shared.db.rowsOfTable(serviceKeyAuditLog);
    expect(rows.length).toBeGreaterThanOrEqual(4);
    const decisions = rows.map((r) => `${r.decision}:${r.reason ?? ""}`);
    expect(decisions).toEqual(
      expect.arrayContaining([
        "authenticated:ok",
        "denied:verifier_mismatch",
        "denied:unknown_key_id",
        "denied:revoked",
      ]),
    );
    for (const row of rows) {
      expect(row.keyId).toBeDefined();
      expect(row.originSystem).toBeDefined();
      const prefix = String(row.tokenPrefix ?? "");
      expect(prefix.length).toBeLessThanOrEqual(8);
      // Redaction: the full token never appears in any audit row.
      expect(JSON.stringify(row)).not.toContain(issued.token);
    }
  });

  it("never returns or exposes the token through verification, rotation result reuse or records", async () => {
    const issued = await issueServiceKey({
      workspaceSlug: "beidou-ws",
      projectSlug: "research",
      scopes: ["research-task:read"],
    });
    const rotated = await rotateServiceKey(issued.keyId, { retentionMs: 86_400_000 });
    // Only the issuance/rotation responses ever carry a fresh token.
    const seen: IssuedKey[] = [issued, rotated];
    for (const s of seen) expect(s.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const rows = shared.db.rowsOfTable(tiangongServiceKeys);
    for (const row of rows) {
      expect(JSON.stringify(row)).not.toContain(issued.token);
      expect(JSON.stringify(row)).not.toContain(rotated.token);
    }
  });
});
