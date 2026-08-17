export const ARTIFACT_MANIFEST_VERSION = "tiangong-artifact-manifest.v1" as const;

export type ArtifactManifestItem = Readonly<{
  artifact_uuid: string;
  sha256: string;
  generation_id: number;
  size: number;
  mime: string;
}>;

export type ArtifactManifest = Readonly<{
  schema_version: typeof ARTIFACT_MANIFEST_VERSION;
  task_id: string;
  external_ref: string;
  task_revision: number;
  sealed_at: string;
  artifacts: readonly ArtifactManifestItem[];
}>;

export class ArtifactStorageError extends Error {
  readonly name = "ArtifactStorageError";
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export type ArtifactVolumeOptions = Readonly<{
  root: string;
  volumeId: string;
  generationId: number;
  allowEphemeralForTests?: boolean;
}>;
