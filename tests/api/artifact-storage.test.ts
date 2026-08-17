import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ArtifactStorageError,
  ArtifactVolume,
  computeSealedManifest,
} from "../../api/lib/artifacts/artifact-volume";
import { ArtifactGarbageCollector } from "../../api/lib/artifacts/artifact-gc";

const roots: string[] = [];
const volumeId = "4f88db8d-5fef-47f4-8e7b-74419feca315";

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "tiangong-artifacts-"));
  roots.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

describe("immutable artifact volume", () => {
  it("refuses startup without an operator-created marker", async () => {
    const storage = new ArtifactVolume({ root: await root(), volumeId, generationId: 1, allowEphemeralForTests: true });
    await expect(storage.probe()).rejects.toMatchObject<Partial<ArtifactStorageError>>({ code: "missing_marker" });
  });

  it("initializes once, probes, stages with 0600, and seals immutable bytes", async () => {
    const storage = new ArtifactVolume({ root: await root(), volumeId, generationId: 1, allowEphemeralForTests: true });
    await storage.initialize();
    await expect(storage.initialize()).rejects.toMatchObject({ code: "volume_already_initialized" });
    await storage.probe();
    const bytes = Buffer.from("immutable-result\n", "utf8");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const stageId = randomUUID();
    await storage.stage({ stageId, bytes, expectedSha256: digest, expectedSize: bytes.length });
    expect((await stat(join(storage.root, "staged", stageId))).mode & 0o777).toBe(0o600);
    const installed = await storage.install({ stageId, sha256: digest, size: bytes.length });
    expect(installed.reused).toBe(false);
    expect(await readFile(installed.path)).toEqual(bytes);
    expect((await stat(installed.path)).mode & 0o777).toBe(0o444);
    await storage.stage({ stageId: "duplicate", bytes, expectedSha256: digest, expectedSize: bytes.length });
    expect((await storage.install({ stageId: "duplicate", sha256: digest, size: bytes.length })).reused).toBe(true);
    expect(await readFile(installed.path)).toEqual(bytes);
  });

  it("reuses exact EEXIST bytes and quarantines mismatched content", async () => {
    const storage = new ArtifactVolume({ root: await root(), volumeId, generationId: 1, allowEphemeralForTests: true });
    await storage.initialize();
    const bytes = Buffer.from("same bytes");
    const digest = createHash("sha256").update(bytes).digest("hex");
    await storage.stage({ stageId: "first", bytes, expectedSha256: digest, expectedSize: bytes.length });
    await storage.install({ stageId: "first", sha256: digest, size: bytes.length });
    await storage.stage({ stageId: "second", bytes, expectedSha256: digest, expectedSize: bytes.length });
    expect((await storage.install({ stageId: "second", sha256: digest, size: bytes.length })).reused).toBe(true);
    await writeFile(join(storage.root, "by-sha", digest), "corrupt", { mode: 0o444 });
    await storage.stage({ stageId: "third", bytes, expectedSha256: digest, expectedSize: bytes.length });
    await expect(storage.install({ stageId: "third", sha256: digest, size: bytes.length })).rejects.toMatchObject({ code: "seal_object_reuse_mismatch" });
    expect(await stat(join(storage.root, "gc", "quarantine-third"))).toBeDefined();
  });

  it("canonicalizes sorted descriptors into one stable manifest identity", () => {
    const result = computeSealedManifest({
      schema_version: "tiangong-artifact-manifest.v1",
      task_id: "TG-ONE",
      external_ref: "beidou:1",
      task_revision: 4,
      sealed_at: "2026-08-13T00:00:00.000Z",
      artifacts: [
        { artifact_uuid: "b", sha256: "b".repeat(64), generation_id: 1, size: 2, mime: "text/plain" },
        { artifact_uuid: "a", sha256: "a".repeat(64), generation_id: 1, size: 1, mime: "text/plain" },
      ],
    });
    expect(result.manifest.artifacts.map((item) => item.artifact_uuid)).toEqual(["a", "b"]);
    expect(result.identity).toMatch(/^[a-f0-9]{64}$/);
    expect(createHash("sha256").update(result.canonicalBytes).digest("hex")).toBe(result.identity);
  });

  it("two-phase GC never removes referenced content generations", async () => {
    const storage = new ArtifactVolume({ root: await root(), volumeId, generationId: 1, allowEphemeralForTests: true });
    await storage.initialize();
    await writeFile(join(storage.root, "by-sha", "a".repeat(64)), "kept", { mode: 0o444 });
    await writeFile(join(storage.root, "by-sha", "b".repeat(64)), "orphan", { mode: 0o444 });
    const gc = new ArtifactGarbageCollector(storage, { graceMs: 0, leaseMs: 60_000 });
    const first = await gc.sweep({ referenced: new Set([`1:${"a".repeat(64)}`]), generationId: 1, now: new Date(0) });
    expect(first.marked).toBe(1);
    const second = await gc.sweep({ referenced: new Set([`1:${"a".repeat(64)}`]), generationId: 1, now: new Date(1) });
    expect(second.deleted).toBe(1);
    expect(await readFile(join(storage.root, "by-sha", "a".repeat(64)), "utf8")).toBe("kept");
  });
});
