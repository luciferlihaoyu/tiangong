import { z } from "zod";
import { createRouter, userQuery } from "./middleware";
import {
  listSecrets,
  getSecret,
  createSecret,
  updateSecret,
  deleteSecret,
} from "./secret-vault/item";

export const secretVaultRouter = createRouter({
  list: userQuery
    .input(
      z.object({
        workspaceId: z.number(),
        projectId: z.number(),
      })
    )
    .query(async ({ input, ctx }) => listSecrets(input.workspaceId, input.projectId, ctx.user)),

  get: userQuery
    .input(z.object({ itemId: z.number() }))
    .query(async ({ input, ctx }) => getSecret(input.itemId, ctx.user)),

  create: userQuery
    .input(
      z.object({
        workspaceId: z.number(),
        projectId: z.number(),
        name: z.string().min(1).max(100),
        description: z.string().optional(),
        plaintext: z.string().min(1),
      })
    )
    .mutation(async ({ input, ctx }) => createSecret(input, ctx.user)),

  update: userQuery
    .input(
      z.object({
        itemId: z.number(),
        name: z.string().min(1).max(100).optional(),
        description: z.string().optional(),
        plaintext: z.string().min(1).optional(),
      })
    )
    .mutation(async ({ input, ctx }) =>
      updateSecret(input.itemId, {
        name: input.name,
        description: input.description,
        plaintext: input.plaintext,
      }, ctx.user)
    ),

  delete: userQuery
    .input(z.object({ itemId: z.number() }))
    .mutation(async ({ input, ctx }) => deleteSecret(input.itemId, ctx.user)),
});
