/**
 * Todo 20 (Beidou plan): frozen raw-body signature verification order
 * (consumed by Todo 22 for Tiangong→Beidou callbacks).
 *
 * Frozen contract: Content-Length and Content-Type are verified against the
 * raw-body signature FIRST (before any JSON parsing); HMAC-SHA-256; timestamp
 * in Unix seconds with +/-300s allowed skew; nonce is a base64url-encoded
 * 16-byte random value; body size limit enforced before hashing; signature is
 * lowercase hex over `timestamp + "\n" + nonce + "\n" + raw_body`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Wrapped createHmac so "BEFORE hashing" ordering can be proven by call count.
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, createHmac: vi.fn(actual.createHmac) };
});

import { createHmac } from "node:crypto";

import {
  ALLOWED_TIMESTAMP_SKEW_SECONDS,
  MAX_CALLBACK_BODY_BYTES,
  generateNonce,
  resetNonceReplayStore,
  signRawBody,
  verifyRawBodySignature,
  type RawBodySignHeaders,
} from "../../api/lib/raw-body-signature";

const KEY_ID = "cbk_test_1";
const SECRET = "qa-callback-hmac-secret";
const BODY = JSON.stringify({ event: "task.state", taskId: "TG-1", state: "done" });

function resolve(secret: string | null) {
  return (keyId: string): string | null => (keyId === KEY_ID ? secret : null);
}

function headersOf(overrides: Partial<Record<string, string>> = {}, timestamp?: number): Record<string, string> {
  const { headers } = signRawBody({ keyId: KEY_ID, secret: SECRET, body: BODY, timestamp });
  return { ...headers, ...overrides };
}

describe("raw-body signature frozen contract", () => {
  beforeEach(() => {
    resetNonceReplayStore();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(createHmac).mockClear();
  });

  it("signs with HMAC-SHA-256 lowercase hex over timestamp\\nnonce\\nraw_body", () => {
    const ts = Math.floor(Date.now() / 1000);
    const nonce = generateNonce();
    const { headers, signature } = signRawBody({ keyId: KEY_ID, secret: SECRET, body: BODY, timestamp: ts, nonce });
    expect(signature).toMatch(/^[0-9a-f]{64}$/);
    const expected = createHmac("sha256", SECRET)
      .update(`${ts}\n${nonce}\n${BODY}`)
      .digest("hex");
    expect(signature).toBe(expected);
    expect(headers["x-tg-key-id"]).toBe(KEY_ID);
    expect(headers["x-tg-timestamp"]).toBe(String(ts));
    expect(headers["x-tg-nonce"]).toBe(nonce);
    expect(headers["content-type"]).toBe("application/json");
  });

  it("verifies a correctly signed body", () => {
    const res = verifyRawBodySignature({ headers: headersOf(), rawBody: BODY, resolveSecret: resolve(SECRET) });
    expect(res.valid).toBe(true);
  });

  it("rejects when Content-Length does not match the raw body BEFORE hashing", () => {
    const headers = headersOf(); // signing itself calls createHmac once
    vi.mocked(createHmac).mockClear();
    const res = verifyRawBodySignature({
      headers: { ...headers, "content-length": String(BODY.length + 10) },
      rawBody: BODY,
      resolveSecret: resolve(SECRET),
    });
    expect(res.valid).toBe(false);
    expect(res.reason).toBe("content_length_mismatch");
    expect(vi.mocked(createHmac)).not.toHaveBeenCalled();
  });

  it("rejects missing Content-Length before hashing", () => {
    const headers = headersOf();
    vi.mocked(createHmac).mockClear();
    delete headers["content-length"];
    const res = verifyRawBodySignature({ headers, rawBody: BODY, resolveSecret: resolve(SECRET) });
    expect(res.valid).toBe(false);
    expect(res.reason).toBe("content_length_missing");
    expect(vi.mocked(createHmac)).not.toHaveBeenCalled();
  });

  it("rejects a non-JSON Content-Type before hashing", () => {
    const headers = headersOf({ "content-type": "text/plain" });
    vi.mocked(createHmac).mockClear();
    const res = verifyRawBodySignature({ headers, rawBody: BODY, resolveSecret: resolve(SECRET) });
    expect(res.valid).toBe(false);
    expect(res.reason).toBe("content_type_rejected");
    expect(vi.mocked(createHmac)).not.toHaveBeenCalled();
  });

  it("accepts application/json with a charset parameter", () => {
    const res = verifyRawBodySignature({
      headers: headersOf({ "content-type": "application/json; charset=utf-8" }),
      rawBody: BODY,
      resolveSecret: resolve(SECRET),
    });
    expect(res.valid).toBe(true);
  });

  it("enforces the body size limit BEFORE hashing", () => {
    const bigBody = JSON.stringify({ data: "x".repeat(MAX_CALLBACK_BODY_BYTES + 1) });
    const { headers } = signRawBody({ keyId: KEY_ID, secret: SECRET, body: bigBody });
    vi.mocked(createHmac).mockClear();
    const res = verifyRawBodySignature({ headers, rawBody: bigBody, resolveSecret: resolve(SECRET) });
    expect(res.valid).toBe(false);
    expect(res.reason).toBe("body_too_large");
    expect(vi.mocked(createHmac)).not.toHaveBeenCalled();
  });

  it("rejects timestamps outside the +/-300s skew window", () => {
    const now = Math.floor(Date.now() / 1000);
    const fixedNow = now * 1000;
    for (const delta of [-301, 301]) {
      const res = verifyRawBodySignature({
        headers: headersOf({ "x-tg-timestamp": String(now + delta) }, now + delta),
        rawBody: BODY,
        resolveSecret: resolve(SECRET),
        now: fixedNow,
      });
      expect(res.valid).toBe(false);
      expect(res.reason).toBe("timestamp_rejected");
    }
    for (const delta of [-300, 0, 300]) {
      const ok = verifyRawBodySignature({
        headers: headersOf({ "x-tg-timestamp": String(now + delta) }, now + delta),
        rawBody: BODY,
        resolveSecret: resolve(SECRET),
        now: fixedNow,
      });
      expect(ok.valid).toBe(true);
    }
    expect(ALLOWED_TIMESTAMP_SKEW_SECONDS).toBe(300);
  });

  it("rejects malformed timestamps and nonces", () => {
    const badTs = verifyRawBodySignature({
      headers: headersOf({ "x-tg-timestamp": "not-a-number" }),
      rawBody: BODY,
      resolveSecret: resolve(SECRET),
    });
    expect(badTs.valid).toBe(false);
    expect(badTs.reason).toBe("timestamp_rejected");

    const badNonce = verifyRawBodySignature({
      headers: headersOf({ "x-tg-nonce": "too-short" }),
      rawBody: BODY,
      resolveSecret: resolve(SECRET),
    });
    expect(badNonce.valid).toBe(false);
    expect(badNonce.reason).toBe("nonce_rejected");
  });

  it("rejects a replayed nonce even with a valid signature", () => {
    const h1 = headersOf();
    const first = verifyRawBodySignature({ headers: h1, rawBody: BODY, resolveSecret: resolve(SECRET) });
    expect(first.valid).toBe(true);
    const second = verifyRawBodySignature({ headers: h1, rawBody: BODY, resolveSecret: resolve(SECRET) });
    expect(second.valid).toBe(false);
    expect(second.reason).toBe("nonce_replayed");
  });

  it("rejects tampered bodies (signature_mismatch) and unknown keys", () => {
    const tampered = verifyRawBodySignature({
      headers: headersOf(),
      rawBody: BODY.replace("done", "fail"), // same byte length
      resolveSecret: resolve(SECRET),
    });
    expect(tampered.valid).toBe(false);
    expect(tampered.reason).toBe("signature_mismatch");

    const unknownKey = verifyRawBodySignature({
      headers: headersOf({ "x-tg-key-id": "cbk_unknown" }),
      rawBody: BODY,
      resolveSecret: resolve(SECRET),
    });
    expect(unknownKey.valid).toBe(false);
    expect(unknownKey.reason).toBe("unknown_key_id");
  });

  it("rejects when the resolved secret is missing (fail closed)", () => {
    const res = verifyRawBodySignature({
      headers: headersOf(),
      rawBody: BODY,
      resolveSecret: resolve(null),
    });
    expect(res.valid).toBe(false);
    expect(res.reason).toBe("unknown_key_id");
  });

  it("rejects malformed signature hex", () => {
    const res = verifyRawBodySignature({
      headers: headersOf({ "x-tg-signature": "zzzz" }),
      rawBody: BODY,
      resolveSecret: resolve(SECRET),
    });
    expect(res.valid).toBe(false);
    expect(res.reason).toBe("signature_rejected");
  });

  it("verification order: content checks run before timestamp/nonce/signature checks", () => {
    // Even with garbage timestamp+nonce+signature, Content-Length mismatch wins.
    const res = verifyRawBodySignature({
      headers: headersOf({
        "content-length": "99999",
        "x-tg-timestamp": "bogus",
        "x-tg-nonce": "bogus",
        "x-tg-signature": "bogus",
      }),
      rawBody: BODY,
      resolveSecret: resolve(SECRET),
    });
    expect(res.valid).toBe(false);
    expect(res.reason).toBe("content_length_mismatch");

    // Content-Type wrong wins over timestamp/signature issues.
    const res2 = verifyRawBodySignature({
      headers: headersOf({
        "content-type": "application/xml",
        "x-tg-timestamp": "bogus",
        "x-tg-nonce": "bogus",
        "x-tg-signature": "bogus",
      }),
      rawBody: BODY,
      resolveSecret: resolve(SECRET),
    });
    expect(res2.valid).toBe(false);
    expect(res2.reason).toBe("content_type_rejected");
  });

  it("RawBodySignHeaders carries the exact frozen header names", () => {
    const h = signRawBody({ keyId: KEY_ID, secret: SECRET, body: BODY }).headers as RawBodySignHeaders;
    expect(Object.keys(h).sort()).toEqual(
      [
        "content-length",
        "content-type",
        "x-tg-key-id",
        "x-tg-nonce",
        "x-tg-signature",
        "x-tg-timestamp",
      ].sort(),
    );
  });
});
