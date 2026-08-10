/**
 * Phase 1 Task 4: General audit/event ledger query router.
 *
 * - Authenticated workspace members can list events scoped to a workspace they
 *   can read (workspace:read capability).
 * - Global admins may query broadly without a workspace filter.
 *
 * Returns only audit metadata rows; secret payloads or credentials are never
 * stored in the audit table.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { createRouter, userQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { auditEvents } from "@db/schema";
import { desc, eq } from "drizzle-orm";
import { requireCapability } from "./workspace/capability";
import { adaptAuditDb } from "./lib/audit-log";
import { auditStats, verifyAuditIntegrity } from "./lib/audit-integrity";

function requireAdminRole(role: string): void {
  if (role !== "admin") {
    throw new TRPCError({ code: "FORBIDDEN", message: "需要管理员权限" });
  }
}

export const auditRouter = createRouter({
  list: userQuery
    .input(
      z.object({
        workspaceId: z.number().optional(),
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().min(0).default(0),
      })
    )
    .query(async ({ input, ctx }) => {
      const db = getDb();
      if (input.workspaceId) {
        await requireCapability(input.workspaceId, ctx.user, "workspace:read");
        return db
          .select()
          .from(auditEvents)
          .where(eq(auditEvents.workspaceId, input.workspaceId))
          .orderBy(desc(auditEvents.createdAt))
          .limit(input.limit)
          .offset(input.offset);
      }

      if (ctx.user.role !== "admin") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "需要管理员权限才能查询全站审计日志",
        });
      }

      return db
        .select()
        .from(auditEvents)
        .orderBy(desc(auditEvents.createdAt))
        .limit(input.limit)
        .offset(input.offset);
    }),

  // P14: verify the audit hash chain (admin-only). Returns the integrity
  // report: { total, verified, broken[], chainStartId, legacyRows }.
  verifyIntegrity: userQuery.query(async ({ ctx }) => {
    requireAdminRole(ctx.user.role);
    return verifyAuditIntegrity(adaptAuditDb(getDb()));
  }),

  // P14: cheap ledger health summary (admin-only).
  stats: userQuery.query(async ({ ctx }) => {
    requireAdminRole(ctx.user.role);
    return auditStats(adaptAuditDb(getDb()));
  }),
});
