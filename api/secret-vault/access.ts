import { TRPCError } from "@trpc/server";
import { eq, and } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { secretVaultItems } from "@db/schema";
import { getProjectById } from "../workspace/auth";
import type { AuthedUser } from "../workspace/auth";
import { requireCapability } from "../workspace/capability";

export async function requireItemAccess(
  itemId: number,
  user: AuthedUser,
  requiredRole: "viewer" | "admin" = "viewer"
): Promise<{ workspaceId: number; projectId: number; name: string }> {
  const db = getDb();
  const item = await db
    .select({
      workspaceId: secretVaultItems.workspaceId,
      projectId: secretVaultItems.projectId,
      name: secretVaultItems.name,
    })
    .from(secretVaultItems)
    .where(eq(secretVaultItems.id, itemId))
    .then((rows) =>
      rows[0] ?? null
    );
  if (!item) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Secret not found" });
  }
  await requireCapability(
    item.workspaceId,
    user,
    requiredRole === "admin" ? "secret:manage" : "secret:read"
  );
  await verifyProjectInWorkspace(item.projectId, item.workspaceId);
  return item;
}

export async function verifyProjectInWorkspace(
  projectId: number,
  workspaceId: number
): Promise<void> {
  const project = await getProjectById(projectId);
  if (!project || project.workspaceId !== workspaceId) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Project does not belong to workspace",
    });
  }
}

export async function requireProjectWriteAccess(
  workspaceId: number,
  projectId: number,
  user: AuthedUser
): Promise<void> {
  await requireCapability(workspaceId, user, "secret:manage");
  await verifyProjectInWorkspace(projectId, workspaceId);
}
