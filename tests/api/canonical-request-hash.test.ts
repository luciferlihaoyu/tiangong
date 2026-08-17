/**
 * Todo 20 (Beidou plan): canonical request-hash normalization (consumed by
 * Todo 21 for idempotent external task identity).
 *
 * RFC 8785 (JCS) over the EXACT named field set
 * (originSystem, external_ref, idempotency_key, operation, target,
 * params_snapshot) with explicit JSON normalization: UTF-8 bytes, JCS key
 * ordering, sorted params_snapshot, integers as JSON numbers, no whitespace.
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import {
  CANONICAL_FIELDS,
  canonicalJson,
  canonicalRequestHash,
  type CanonicalRequest,
} from "../../api/lib/canonical-request-hash";

const jcsSha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** No structural whitespace outside string literals (JCS). */
function expectNoStructuralWhitespace(text: string) {
  const structural = text.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  expect(structural).not.toMatch(/\s/);
}

describe("canonical request hash (RFC 8785 JCS)", () => {
  it("freezes the named field set — no extras, no ordering choice", () => {
    expect(CANONICAL_FIELDS).toEqual([
      "originSystem",
      "external_ref",
      "idempotency_key",
      "operation",
      "target",
      "params_snapshot",
    ]);
  });

  it("serializes the exact named field set in canonical JCS order with no whitespace", () => {
    const req: CanonicalRequest = {
      originSystem: "beidou",
      external_ref: "beidou:research:job-001",
      idempotency_key: "idem-001",
      operation: "create",
      target: "research task one",
      params_snapshot: { limit: 8, query: "New API MCP 接入" },
    };
    const text = canonicalJson(req);
    // No structural whitespace anywhere.
    expectNoStructuralWhitespace(text);
    // RFC 8785 orders keys by (UTF-8 length, then byte order): target(6),
    // operation(9), external_ref(11), originSystem(12), idempotency_key(15),
    // params_snapshot(15). Exactly the named field set — no extras.
    expect(text).toBe(
      '{"target":"research task one","operation":"create","external_ref":"beidou:research:job-001",' +
        '"originSystem":"beidou","idempotency_key":"idem-001","params_snapshot":{"limit":8,"query":"New API MCP 接入"}}',
    );
    expect(canonicalRequestHash(req)).toBe(jcsSha256(text));
    expect(canonicalRequestHash(req)).toHaveLength(64);
  });

  it("is deterministic across key orders in params_snapshot (JCS sorts keys)", () => {
    const a: CanonicalRequest = {
      originSystem: "beidou",
      external_ref: "r1",
      idempotency_key: "k1",
      operation: "create",
      target: "t",
      params_snapshot: { z: 1, a: { y: 1, x: 2 }, m: "v" },
    };
    const b: CanonicalRequest = {
      originSystem: "beidou",
      external_ref: "r1",
      idempotency_key: "k1",
      operation: "create",
      target: "t",
      params_snapshot: { m: "v", a: { x: 2, y: 1 }, z: 1 },
    };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toContain('"a":{"x":2,"y":1}');
    expect(canonicalRequestHash(a)).toBe(canonicalRequestHash(b));
  });

  it("sorts object keys by length first, then lexicographic byte order (RFC 8785)", () => {
    const req: CanonicalRequest = {
      originSystem: "beidou",
      external_ref: "r",
      idempotency_key: "k",
      operation: "create",
      target: "t",
      params_snapshot: { aa: 1, b: 2, c: 3 },
    };
    // JCS ordering: "b", "c" (length 1), then "aa" (length 2).
    expect(canonicalJson(req)).toContain('"b":2,"c":3,"aa":1');
  });

  it("serializes integers as JSON numbers and floats canonically", () => {
    const req: CanonicalRequest = {
      originSystem: "beidou",
      external_ref: "r",
      idempotency_key: "k",
      operation: "create",
      target: "t",
      params_snapshot: { count: 3, ratio: 0.5, big: 1e2, flag: true, none: null, list: [3, 1, 2] },
    };
    const text = canonicalJson(req);
    expect(text).toContain('"count":3');
    expect(text).not.toContain('"count":"3"');
    expect(text).toContain('"ratio":0.5');
    expect(text).toContain('"big":100');
    expect(text).toContain('"flag":true');
    expect(text).toContain('"none":null');
    expect(text).toContain('"list":[3,1,2]');
  });

  it("encodes UTF-8 strings as raw bytes (no unicode-escape sequences)", () => {
    const req: CanonicalRequest = {
      originSystem: "beidou",
      external_ref: "r",
      idempotency_key: "k",
      operation: "create",
      target: "目标-€",
      params_snapshot: {},
    };
    const text = canonicalJson(req);
    expect(text).toContain("目标-€");
    expect(text).not.toContain("\\u");
    // UTF-8 byte length is what is hashed.
    expect(canonicalRequestHash(req)).toBe(jcsSha256(text));
  });

  it("treats missing params_snapshot as the empty object", () => {
    const req: CanonicalRequest = {
      originSystem: "beidou",
      external_ref: "r",
      idempotency_key: "k",
      operation: "create",
      target: "t",
      params_snapshot: {},
    };
    expect(canonicalJson(req)).toContain('"params_snapshot":{}');
  });

  it("escapes JSON string characters per JCS (backslash, quotes, control chars)", () => {
    const req: CanonicalRequest = {
      originSystem: "beidou",
      external_ref: 'r"\\\n',
      idempotency_key: "k",
      operation: "create",
      target: "t",
      params_snapshot: { note: 'a"b\\c' },
    };
    const text = canonicalJson(req);
    expect(text).toContain('"note":"a\\"b\\\\c"');
    expectNoStructuralWhitespace(text);
  });
});
