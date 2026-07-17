import { z } from "zod";
import { createRouter, userQuery } from "./middleware";
import { membershipRoleSchema } from "./workspace/auth";
import {
  listWorkspaces,
  getWorkspace,
  createWorkspace,
  updateWorkspace,
  deleteWorkspace,
} from "./workspace/workspace";
import {
  listProjects,
  getProject,
  createProject,
  updateProject,
  deleteProject,
} from "./workspace/project";
import {
  listMemberships,
  addMembership,
  updateMembershipRole,
  removeMembership,
} from "./workspace/membership";

export const workspaceRouter = createRouter({
  list: userQuery.query(async ({ ctx }) => listWorkspaces(ctx.user)),

  get: userQuery
    .input(z.object({ workspaceId: z.number() }))
    .query(async ({ input, ctx }) => getWorkspace(input.workspaceId, ctx.user)),

  create: userQuery
    .input(
      z.object({
        name: z.string().min(1).max(100),
        slug: z.string().min(1).max(100),
        description: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => createWorkspace(input, ctx.user)),

  update: userQuery
    .input(
      z.object({
        workspaceId: z.number(),
        name: z.string().min(1).max(100).optional(),
        description: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) =>
      updateWorkspace(input.workspaceId, { name: input.name, description: input.description }, ctx.user)
    ),

  delete: userQuery
    .input(z.object({ workspaceId: z.number() }))
    .mutation(async ({ input, ctx }) => deleteWorkspace(input.workspaceId, ctx.user)),

  projectList: userQuery
    .input(z.object({ workspaceId: z.number() }))
    .query(async ({ input, ctx }) => listProjects(input.workspaceId, ctx.user)),

  projectGet: userQuery
    .input(z.object({ projectId: z.number() }))
    .query(async ({ input, ctx }) => getProject(input.projectId, ctx.user)),

  projectCreate: userQuery
    .input(
      z.object({
        workspaceId: z.number(),
        name: z.string().min(1).max(100),
        slug: z.string().min(1).max(100),
        description: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => createProject(input, ctx.user)),

  projectUpdate: userQuery
    .input(
      z.object({
        projectId: z.number(),
        name: z.string().min(1).max(100).optional(),
        description: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) =>
      updateProject(input.projectId, { name: input.name, description: input.description }, ctx.user)
    ),

  projectDelete: userQuery
    .input(z.object({ projectId: z.number() }))
    .mutation(async ({ input, ctx }) => deleteProject(input.projectId, ctx.user)),

  membershipList: userQuery
    .input(z.object({ workspaceId: z.number() }))
    .query(async ({ input, ctx }) => listMemberships(input.workspaceId, ctx.user)),

  membershipAdd: userQuery
    .input(
      z.object({
        workspaceId: z.number(),
        userId: z.number(),
        role: membershipRoleSchema.default("member"),
      })
    )
    .mutation(async ({ input, ctx }) => addMembership(input, ctx.user)),

  membershipUpdateRole: userQuery
    .input(
      z.object({
        workspaceId: z.number(),
        userId: z.number(),
        role: membershipRoleSchema,
      })
    )
    .mutation(async ({ input, ctx }) => updateMembershipRole(input, ctx.user)),

  membershipRemove: userQuery
    .input(
      z.object({
        workspaceId: z.number(),
        userId: z.number(),
      })
    )
    .mutation(async ({ input, ctx }) =>
      removeMembership(input.workspaceId, input.userId, ctx.user)
    ),
});
