import { describe, expect, it } from "vitest";
import { computeAuditHash } from "../../api/lib/audit-log";
import type { AuditHashFields } from "../../api/lib/audit-log";

const TS = new Date("2026-08-10T10:00:00.000Z");

function fields(overrides: Partial<AuditHashFields> = {}): AuditHashFields {
  return {
    event: "workspace:created",
    actorUserId: 1,
    entityType: "workspace",
    entityId: 7,
    metadataJson: '{"name":"w"}',
    createdAt: TS,
    ...overrides,
  };
}

describe("audit hash chain — computeAuditHash", () => {
  it("is deterministic for identical inputs and emits a 64-hex digest", () => {
    expect(computeAuditHash(null, fields())).toBe(computeAuditHash(null, fields()));
    expect(computeAuditHash(null, fields())).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is sensitive to every input including prevHash, metadata and timestamp", () => {
    const h = computeAuditHash(null, fields());
    const variants: Array<Partial<AuditHashFields>> = [
      { event: "project:created" },
      { actorUserId: 2 },
      { entityType: "project" },
      { entityId: 8 },
      { metadataJson: '{"name":"z"}' },
      { metadataJson: null },
      { createdAt: new Date("2026-08-10T10:00:01.000Z") },
    ];
    for (const v of variants) {
      expect(computeAuditHash(null, fields(v))).not.toBe(h);
    }
    expect(computeAuditHash("cafe".repeat(16), fields())).not.toBe(h);
  });

  it("is stable across separate invocations (known-answer check)", () => {
    // Pin the exact digest so a future canonical-format change is caught.
    expect(computeAuditHash(null, fields({ metadataJson: null }))).toBe(
      "0ec75c701c1f00a4545f7cdd1115d857311f6979d00f961342a9763247b04a2a"
    );
  });
});
