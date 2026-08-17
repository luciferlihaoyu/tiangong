import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  statfs,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { jcsSerialize } from "../canonical-request-hash";
import {
  ARTIFACT_MANIFEST_VERSION,
  ArtifactStorageError,
  type ArtifactManifest,
  type ArtifactManifestItem,
  type ArtifactVolumeOptions,
} from "./artifact-types";

export { ArtifactStorageError } from "./artifact-types";
export type { ArtifactManifest, ArtifactManifestItem } from "./artifact-types";

const MARKER = ".tiangong-artifact-root-marker.v1";
const SHA256 = /^[a-f0-9]{64}$/;
const STAGE_ID = /^[A-Za-z0-9_-]{1,128}$/;

type Marker = Readonly<{
  volume_id: string;
  generation_id: number;
  marker_format_version: 1;
  created_at: string;
  root_path: string;
  init_device: string;
  init_inode: string;
}>;

export class ArtifactVolume {
  readonly root: string;
  private readonly options: ArtifactVolumeOptions;

  constructor(options: ArtifactVolumeOptions) {
    this.root = resolve(options.root);
    this.options = options;
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o750 });
    const markerPath = join(this.root, MARKER);
    try {
      await lstat(markerPath);
      throw new ArtifactStorageError("volume_already_initialized", "artifact volume marker already exists");
    } catch (error) {
      if (error instanceof ArtifactStorageError) throw error;
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
    await Promise.all(["by-sha", "staged", "gc", "probe"].map((name) => mkdir(join(this.root, name), { recursive: true, mode: 0o750 })));
    const rootStat = await stat(this.root);
    const marker: Marker = {
      volume_id: this.options.volumeId,
      generation_id: this.options.generationId,
      marker_format_version: 1,
      created_at: new Date().toISOString(),
      root_path: this.root,
      init_device: String(rootStat.dev),
      init_inode: String(rootStat.ino),
    };
    await writeFile(markerPath, JSON.stringify(marker), { mode: 0o440, flag: "wx" });
    await this.fsyncDirectory(this.root);
  }

  async probe(): Promise<void> {
    const marker = await this.readMarker();
    if (marker.volume_id !== this.options.volumeId || marker.generation_id !== this.options.generationId || marker.root_path !== this.root) {
      throw new ArtifactStorageError("mount_validation_failed", "configured artifact volume identity does not match marker");
    }
    await statfs(this.root);
    if (!this.options.allowEphemeralForTests) await this.assertDedicatedMount();
    const probeDir = join(this.root, "probe");
    const source = join(probeDir, `.probe-${process.pid}-${Date.now()}`);
    const target = `${source}.renamed`;
    const handle = await open(source, constants.O_NOFOLLOW | constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    await handle.writeFile("probe");
    await handle.sync();
    await handle.close();
    await rename(source, target);
    if ((await readFile(target, "utf8")) !== "probe") throw new ArtifactStorageError("startup_probe_failed", "rename probe changed bytes");
    await unlink(target);
    await this.fsyncDirectory(probeDir);
  }

  async stage(input: Readonly<{ stageId: string; bytes: Uint8Array; expectedSha256: string; expectedSize: number }>): Promise<string> {
    this.assertStageId(input.stageId);
    this.assertDigest(input.expectedSha256);
    if (input.bytes.byteLength !== input.expectedSize) throw new ArtifactStorageError("artifact_size_mismatch", "staged size differs from descriptor");
    const path = join(this.root, "staged", input.stageId);
    const handle = await open(path, constants.O_NOFOLLOW | constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      await handle.writeFile(input.bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await this.fsyncDirectory(dirname(path));
    await this.verifyFile(path, input.expectedSize, input.expectedSha256);
    return path;
  }

  async install(input: Readonly<{ stageId: string; sha256: string; size: number }>): Promise<Readonly<{ path: string; reused: boolean }>> {
    this.assertStageId(input.stageId);
    this.assertDigest(input.sha256);
    const staged = join(this.root, "staged", input.stageId);
    const destination = join(this.root, "by-sha", input.sha256);
    await this.verifyFile(staged, input.size, input.sha256);
    await chmod(staged, 0o444);
    const reopened = await open(staged, constants.O_NOFOLLOW | constants.O_RDONLY);
    const mode = (await reopened.stat()).mode & 0o777;
    await reopened.close();
    if (mode !== 0o444) throw new ArtifactStorageError("staged_mode_verification_failed", "verified staged object is not mode 0444");
    let reused = false;
    try {
      await link(staged, destination);
      await unlink(staged);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") {
        throw new ArtifactStorageError("sealer_unavailable_rename_primitive", "atomic no-replace install failed", { cause: error });
      }
      try {
        await this.verifyFile(destination, input.size, input.sha256);
        await unlink(staged);
        reused = true;
      } catch (verifyError) {
        const quarantine = join(this.root, "gc", `quarantine-${input.stageId}`);
        await rename(staged, quarantine);
        throw new ArtifactStorageError("seal_object_reuse_mismatch", "existing content-addressed object differs", { cause: verifyError });
      }
    }
    await Promise.all([this.fsyncDirectory(join(this.root, "staged")), this.fsyncDirectory(join(this.root, "by-sha"))]);
    return { path: destination, reused };
  }

  async verifyInstalled(sha256: string, size: number): Promise<string> {
    this.assertDigest(sha256);
    const path = join(this.root, "by-sha", sha256);
    await this.verifyFile(path, size, sha256);
    return path;
  }

  private async readMarker(): Promise<Marker> {
    let bytes: string;
    try {
      bytes = await readFile(join(this.root, MARKER), "utf8");
    } catch (error) {
      throw new ArtifactStorageError("missing_marker", "artifact volume marker is missing or unreadable", { cause: error });
    }
    try {
      const value: unknown = JSON.parse(bytes);
      if (!value || typeof value !== "object") throw new TypeError("marker is not an object");
      const marker = value as Partial<Marker>;
      if (typeof marker.volume_id !== "string" || typeof marker.generation_id !== "number" || marker.marker_format_version !== 1 || typeof marker.root_path !== "string") throw new TypeError("invalid marker fields");
      return marker as Marker;
    } catch (error) {
      throw new ArtifactStorageError("missing_marker", "artifact volume marker is invalid", { cause: error });
    }
  }

  private async assertDedicatedMount(): Promise<void> {
    const mountInfo = await readFile("/proc/self/mountinfo", "utf8");
    const escapedRoot = this.root.replaceAll(" ", "\\040");
    const mounted = mountInfo.split("\n").some((line) => line.split(" - ")[0]?.split(" ")[4] === escapedRoot);
    if (!mounted) throw new ArtifactStorageError("ephemeral_root_filesystem", "artifact root is not a dedicated persistent mount");
  }

  private async verifyFile(path: string, size: number, sha256: string): Promise<void> {
    const handle = await open(path, constants.O_NOFOLLOW | constants.O_RDONLY);
    try {
      const facts = await handle.stat();
      if (!facts.isFile() || facts.size !== size) throw new ArtifactStorageError("artifact_size_mismatch", "artifact is absent, non-regular, or wrong size");
      const bytes = await handle.readFile();
      if (createHash("sha256").update(bytes).digest("hex") !== sha256) throw new ArtifactStorageError("artifact_digest_mismatch", "artifact digest verification failed");
    } finally {
      await handle.close();
    }
  }

  private async fsyncDirectory(path: string): Promise<void> {
    const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
    await handle.sync();
    await handle.close();
  }

  private assertDigest(value: string): void {
    if (!SHA256.test(value)) throw new ArtifactStorageError("invalid_digest", "sha256 must be lowercase hexadecimal");
  }

  private assertStageId(value: string): void {
    if (!STAGE_ID.test(value)) throw new ArtifactStorageError("invalid_stage_id", "stage id is not a safe path component");
  }
}

export function computeSealedManifest(input: ArtifactManifest): Readonly<{ manifest: ArtifactManifest; canonicalBytes: Buffer; identity: string }> {
  const artifacts = [...input.artifacts].sort((left, right) => left.artifact_uuid.localeCompare(right.artifact_uuid, "en") || left.sha256.localeCompare(right.sha256, "en"));
  const manifest: ArtifactManifest = { ...input, schema_version: ARTIFACT_MANIFEST_VERSION, artifacts };
  const canonicalBytes = Buffer.from(jcsSerialize(manifest), "utf8");
  return { manifest, canonicalBytes, identity: createHash("sha256").update(canonicalBytes).digest("hex") };
}
