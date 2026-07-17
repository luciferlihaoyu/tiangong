/**
 * Phase 1 Task 6: Artifact registry tRPC router.
 *
 * Thin, metadata-only router. All procedures are user-authenticated and use
 * Zod boundaries. Returns artifact metadata only; no file contents.
 */
import { z } from "zod";
import { createRouter, userQuery } from "./middleware";
import {
  listArtifacts,
  getArtifact,
  createArtifact,
  updateArtifact,
  deleteArtifact,
  ARTIFACT_TYPES,
  ARTIFACT_STATUSES,
  STORAGE_BACKREF_TYPES,
} from "./artifact/registry";
import { safeConfigSchema } from "./connector/config";

const artifactTypeSchema = z.enum(ARTIFACT_TYPES);
const artifactStatusSchema = z.enum(ARTIFACT_STATUSES);
const storageBackrefTypeSchema = z.enum(STORAGE_BACKREF_TYPES);

const STORAGE_BACKREF_BLOCKLIST = [
  "password",
  "token",
  "secret",
  "api_key",
  "accesskey",
  "authorization",
  "bearer",
  "credential",
  "private_key",
] as const;

const storageBackrefIdSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9._:\/@-]+$/,
    "Must be a safe opaque reference ID (alphanumeric, ., _, :, /, @, -)"
  )
  .refine(
    (val) => !STORAGE_BACKREF_BLOCKLIST.some((term) => val.toLowerCase().includes(term)),
    { message: "Must not contain credential-like substrings" }
  )
  .max(100)
  .optional();

const checksumSha256Schema = z
  .string()
  .regex(/^[a-fA-F0-9]{64}$/, "Must be exactly 64 hex characters (SHA-256)")
  .optional();

export const artifactRouter = createRouter({
  list: userQuery
    .input(
      z.object({
        workspaceId: z.number(),
        projectId: z.number().optional(),
        taskId: z.number().optional(),
      })
    )
    .query(async ({ input, ctx }) =>
      listArtifacts(input.workspaceId, input.projectId, input.taskId, ctx.user)
    ),

  get: userQuery
    .input(z.object({ artifactId: z.number() }))
    .query(async ({ input, ctx }) => getArtifact(input.artifactId, ctx.user)),

  create: userQuery
    .input(
      z.object({
        workspaceId: z.number(),
        projectId: z.number().optional(),
        taskId: z.number().optional(),
        name: z.string().min(1).max(255),
        slug: z.string().min(1).max(100),
        artifactType: artifactTypeSchema,
        mimeType: z.string().max(100).optional(),
        sizeBytes: z.number().nonnegative().optional(),
        checksumSha256: checksumSha256Schema,
        storageBackrefType: storageBackrefTypeSchema.optional(),
        storageBackrefId: storageBackrefIdSchema,
        metadata: safeConfigSchema.optional(),
        status: artifactStatusSchema.optional(),
      })
    )
    .mutation(async ({ input, ctx }) => createArtifact(input, ctx.user)),

  update: userQuery
    .input(
      z.object({
        artifactId: z.number(),
        name: z.string().min(1).max(255).optional(),
        status: artifactStatusSchema.optional(),
        mimeType: z.string().max(100).optional(),
        sizeBytes: z.number().nonnegative().optional(),
        checksumSha256: checksumSha256Schema,
        storageBackrefType: storageBackrefTypeSchema.optional(),
        storageBackrefId: storageBackrefIdSchema,
        metadata: safeConfigSchema.optional(),
      })
    )
    .mutation(async ({ input, ctx }) =>
      updateArtifact(
        input.artifactId,
        {
          name: input.name,
          status: input.status,
          mimeType: input.mimeType,
          sizeBytes: input.sizeBytes,
          checksumSha256: input.checksumSha256,
          storageBackrefType: input.storageBackrefType,
          storageBackrefId: input.storageBackrefId,
          metadata: input.metadata,
        },
        ctx.user
      )
    ),

  delete: userQuery
    .input(z.object({ artifactId: z.number() }))
    .mutation(async ({ input, ctx }) => deleteArtifact(input.artifactId, ctx.user)),
});
