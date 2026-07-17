/**
 * Phase 1 Task 5: Connector registry tRPC router.
 *
 * Thin, metadata-only router. All procedures are user-authenticated and use
 * Zod boundaries. Returns connector metadata only; no secret values.
 */
import { z } from "zod";
import { createRouter, userQuery } from "./middleware";
import {
  listConnectors,
  getConnector,
  createConnector,
  updateConnector,
  deleteConnector,
  CONNECTOR_TYPES,
  CONNECTOR_STATUSES,
} from "./connector/registry";
import { safeConfigSchema } from "./connector/config";

const connectorTypeSchema = z.enum(CONNECTOR_TYPES);
const connectorStatusSchema = z.enum(CONNECTOR_STATUSES);

export const connectorRouter = createRouter({
  list: userQuery
    .input(
      z.object({
        workspaceId: z.number(),
        projectId: z.number().optional(),
      })
    )
    .query(async ({ input, ctx }) =>
      listConnectors(input.workspaceId, input.projectId, ctx.user)
    ),

  get: userQuery
    .input(z.object({ connectorId: z.number() }))
    .query(async ({ input, ctx }) => getConnector(input.connectorId, ctx.user)),

  create: userQuery
    .input(
      z.object({
        workspaceId: z.number(),
        projectId: z.number().optional(),
        name: z.string().min(1).max(100),
        slug: z.string().min(1).max(100),
        connectorType: connectorTypeSchema,
        endpoint: z.string().url().max(500).optional(),
        config: safeConfigSchema.optional(),
        status: connectorStatusSchema.optional(),
        secretRefId: z.number().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => createConnector(input, ctx.user)),

  update: userQuery
    .input(
      z.object({
        connectorId: z.number(),
        name: z.string().min(1).max(100).optional(),
        endpoint: z.string().url().max(500).optional(),
        config: safeConfigSchema.optional(),
        status: connectorStatusSchema.optional(),
        secretRefId: z.number().optional(),
      })
    )
    .mutation(async ({ input, ctx }) =>
      updateConnector(
        input.connectorId,
        {
          name: input.name,
          endpoint: input.endpoint,
          config: input.config,
          status: input.status,
          secretRefId: input.secretRefId,
        },
        ctx.user
      )
    ),

  delete: userQuery
    .input(z.object({ connectorId: z.number() }))
    .mutation(async ({ input, ctx }) => deleteConnector(input.connectorId, ctx.user)),
});
