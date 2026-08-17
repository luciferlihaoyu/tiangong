import { readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ArtifactVolume } from "./artifact-volume";

type GcOptions = Readonly<{ graceMs: number; leaseMs: number }>;
type SweepInput = Readonly<{ referenced: ReadonlySet<string>; generationId: number; now: Date }>;

export class ArtifactGarbageCollector {
  constructor(private readonly volume: ArtifactVolume, private readonly options: GcOptions) {}

  async sweep(input: SweepInput): Promise<Readonly<{ marked: number; deleted: number }>> {
    const bySha = join(this.volume.root, "by-sha");
    const gc = join(this.volume.root, "gc");
    const deletionCandidates = await readdir(gc);
    let marked = 0;
    let deleted = 0;
    for (const sha256 of await readdir(bySha)) {
      if (input.referenced.has(`${input.generationId}:${sha256}`)) continue;
      await rename(join(bySha, sha256), join(gc, `${input.now.getTime()}-${input.generationId}-${sha256}`));
      marked++;
    }
    for (const entry of deletionCandidates) {
      const digest = entry.slice(-64);
      const prefix = entry.slice(0, -65);
      const separator = prefix.indexOf("-");
      if (separator < 1 || !/^[a-f0-9]{64}$/.test(digest)) continue;
      const markedText = prefix.slice(0, separator);
      const generationText = prefix.slice(separator + 1);
      const markedAt = Number(markedText);
      const generation = Number(generationText);
      if (!Number.isFinite(markedAt) || !Number.isFinite(generation) || input.referenced.has(`${generation}:${digest}`)) continue;
      if (input.now.getTime() - markedAt < this.options.graceMs) continue;
      await rm(join(gc, entry));
      deleted++;
    }
    void this.options.leaseMs;
    return { marked, deleted };
  }
}
