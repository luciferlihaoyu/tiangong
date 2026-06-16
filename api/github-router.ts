/**
 * P11: GitHub App Integration Router
 *
 * Minimal Tiangong-internal GitHub integration:
 * - GitHub App installation token generation (when secrets configured)
 * - Repo/permission management
 * - PR approval queue (approve/reject within Tiangong)
 * - Optional live merge via GitHub API when secrets available
 */
import { z } from "zod";
import { adminQuery, authedQuery, createRouter } from "./middleware";
import { getDb } from "./queries/connection";
import {
  githubIntegrations,
  githubRepos,
  githubRepoPermissions,
  githubPullRequests,
  githubAuditLog,
  agents,
} from "@db/schema";
import { eq, and, desc, asc } from "drizzle-orm";
import { env } from "./lib/env";

/* ═══════════════════════════════════════════
   GitHub API helpers
   ═══════════════════════════════════════════ */

const GITHUB_API_BASE = "https://api.github.com";

function githubReadiness() {
  return {
    appId: env.githubAppId || null,
    appIdConfigured: !!env.githubAppId,
    privateKeyConfigured: !!(env.githubAppPrivateKeyPath || env.githubAppPrivateKey || env.githubAppPrivateKeyBase64),
    installationId: env.githubAppInstallationId || null,
    installationIdConfigured: !!env.githubAppInstallationId,
    webhookSecretConfigured: !!env.githubWebhookSecret,
    ready: !!(env.githubAppId && (env.githubAppPrivateKeyPath || env.githubAppPrivateKey || env.githubAppPrivateKeyBase64) && env.githubAppInstallationId),
  };
}

async function generateInstallationToken(): Promise<string | null> {
  const readiness = githubReadiness();
  if (!readiness.ready) return null;

  try {
    const joseModule = await import("jose");

    let pem = env.githubAppPrivateKey || "";
    if (env.githubAppPrivateKeyBase64) {
      pem = Buffer.from(env.githubAppPrivateKeyBase64, "base64").toString("utf8");
    } else if (env.githubAppPrivateKeyPath) {
      const fsModule = await import("node:fs/promises");
      pem = await fsModule.readFile(env.githubAppPrivateKeyPath, "utf8");
    }
    pem = pem.replace(/\\n/g, "\n");
    const privateKey = await joseModule.importPKCS8(pem, "RS256");

    const jwt = await new joseModule.SignJWT({
      iat: Math.floor(Date.now() / 1000) - 60,
      exp: Math.floor(Date.now() / 1000) + 600,
      iss: env.githubAppId,
    })
      .setProtectedHeader({ alg: "RS256" })
      .sign(privateKey);

    const tokenUrl = `${GITHUB_API_BASE}/app/installations/${env.githubAppInstallationId}/access_tokens`;
    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    if (!response.ok) {
      console.error(`[GitHub] Failed to get installation token: ${response.status}`);
      return null;
    }

    const data = (await response.json()) as any;
    return data.token ?? null;
  } catch (e: any) {
    console.error(`[GitHub] generateInstallationToken error: ${e.message}`);
    return null;
  }
}

async function mergeGitHubPR(
  owner: string,
  repo: string,
  prNumber: number
): Promise<{ success: boolean; skipped: boolean; reason?: string }> {
  const readiness = githubReadiness();
  if (!readiness.ready) {
    return { success: false, skipped: true, reason: "github_secrets_not_configured" };
  }

  const token = await generateInstallationToken();
  if (!token) {
    return { success: false, skipped: true, reason: "installation_token_failed" };
  }

  try {
    const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/pulls/${prNumber}/merge`;
    const response = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ merge_method: "squash" }),
    });

    if (response.ok) return { success: true, skipped: false };

    const errBody = await response.text().catch(() => "");
    return { success: false, skipped: false, reason: `github_api_error: ${response.status} ${errBody.slice(0, 200)}` };
  } catch (e: any) {
    return { success: false, skipped: false, reason: `exception: ${e.message}` };
  }
}

/* ═══════════════════════════════════════════
   Permission helpers
   ═══════════════════════════════════════════ */

async function checkRepoPermission(
  agentId: number,
  repoId: number,
  level: "read" | "push" | "admin"
): Promise<boolean> {
  const db = getDb();
  const levels = level === "read" ? ["read", "push", "admin"] : level === "push" ? ["push", "admin"] : ["admin"];

  const perms = await db
    .select()
    .from(githubRepoPermissions)
    .where(
      and(
        eq(githubRepoPermissions.agentId, agentId),
        eq(githubRepoPermissions.repoId, repoId),
        eq(githubRepoPermissions.active, "true")
      )
    );

  return perms.some((p) => levels.includes(p.permissionLevel));
}

/* ═══════════════════════════════════════════
   Router
   ═══════════════════════════════════════════ */

export const githubRouter = createRouter({
  status: authedQuery.query(async () => {
    const db = getDb();
    const readiness = githubReadiness();

    const repos = await db.select().from(githubRepos).where(eq(githubRepos.active, "true")).orderBy(asc(githubRepos.name));
    const integrations = await db.select().from(githubIntegrations).where(eq(githubIntegrations.active, "true"));

    const permCounts: Record<number, number> = {};
    for (const repo of repos) {
      const perms = await db
        .select()
        .from(githubRepoPermissions)
        .where(and(eq(githubRepoPermissions.repoId, repo.id), eq(githubRepoPermissions.active, "true")));
      permCounts[repo.id] = perms.length;
    }

    return {
      readiness,
      integrations: integrations.map((i) => ({
        id: i.id,
        appId: i.appId ? (i.appId.length > 4 ? `****${i.appId.slice(-4)}` : "****") : null,
        installationId: i.installationId ? `****${i.installationId.slice(-4)}` : null,
        owner: i.owner,
        active: i.active,
      })),
      repos: repos.map((r) => ({
        ...r,
        permissionCount: permCounts[r.id] ?? 0,
      })),
    };
  }),

  listRepos: authedQuery.query(async () => {
    const db = getDb();
    return db.select().from(githubRepos).orderBy(asc(githubRepos.name));
  }),

  addRepo: adminQuery
    .input(
      z.object({
        owner: z.string().min(1).max(100),
        name: z.string().min(1).max(100),
        defaultBranch: z.string().default("main"),
      })
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const fullName = `${input.owner}/${input.name}`;

      const existing = await db
        .select()
        .from(githubRepos)
        .where(and(eq(githubRepos.owner, input.owner), eq(githubRepos.name, input.name)))
        .then((r) => r[0]);

      if (existing) {
        return { success: false, error: "repo_already_exists", existing };
      }

      const result = await db.insert(githubRepos).values({
        owner: input.owner,
        name: input.name,
        fullName,
        defaultBranch: input.defaultBranch,
        active: "true",
      });

      const insertId = (result as any).insertId as number;
      const created = await db.select().from(githubRepos).where(eq(githubRepos.id, insertId)).then((r) => r[0]);

      return { success: true, repo: created };
    }),

  bootstrapDefault: adminQuery.mutation(async () => {
    const db = getDb();
    const owner = "luciferlihaoyu";
    const name = "tiangong";
    const fullName = `${owner}/${name}`;

    let repo = await db
      .select()
      .from(githubRepos)
      .where(and(eq(githubRepos.owner, owner), eq(githubRepos.name, name)))
      .then((rows) => rows[0]);

    if (!repo) {
      const result = await db.insert(githubRepos).values({
        owner,
        name,
        fullName,
        defaultBranch: "main",
        installationId: env.githubAppInstallationId ? Number(env.githubAppInstallationId) : null,
        active: "true",
      });
      repo = await db
        .select()
        .from(githubRepos)
        .where(eq(githubRepos.id, (result as any).insertId as number))
        .then((rows) => rows[0]);
    } else if (repo.active !== "true") {
      await db.update(githubRepos).set({ active: "true" }).where(eq(githubRepos.id, repo.id));
      repo = { ...repo, active: "true" };
    }

    const allAgents = await db.select().from(agents);
    const meizhizi = allAgents.find((agent) =>
      String(agent.agentId ?? "").toLowerCase().includes("meizhizi") ||
      String(agent.name ?? "").includes("美智子")
    );

    if (!meizhizi) {
      return { success: false, repo, error: "meizhizi_agent_not_found" };
    }

    const existingPerm = await db
      .select()
      .from(githubRepoPermissions)
      .where(and(eq(githubRepoPermissions.agentId, meizhizi.id), eq(githubRepoPermissions.repoId, repo.id)))
      .then((rows) => rows[0]);

    if (existingPerm) {
      await db
        .update(githubRepoPermissions)
        .set({ permissionLevel: "admin", active: "true" })
        .where(eq(githubRepoPermissions.id, existingPerm.id));
    } else {
      await db.insert(githubRepoPermissions).values({
        agentId: meizhizi.id,
        repoId: repo.id,
        permissionLevel: "admin",
        active: "true",
      });
    }

    return { success: true, repo, agent: { id: meizhizi.id, agentId: meizhizi.agentId, name: meizhizi.name } };
  }),

  listPermissions: authedQuery
    .input(z.object({ repoId: z.number().optional(), agentId: z.number().optional() }))
    .query(async ({ input }) => {
      const db = getDb();
      const conditions: ReturnType<typeof eq>[] = [];

      if (input.repoId) conditions.push(eq(githubRepoPermissions.repoId, input.repoId));
      if (input.agentId) conditions.push(eq(githubRepoPermissions.agentId, input.agentId));
      conditions.push(eq(githubRepoPermissions.active, "true"));

      const where = conditions.length === 1 ? conditions[0] : and(...(conditions as [any, any, ...any[]]));

      return db
        .select()
        .from(githubRepoPermissions)
        .where(where)
        .orderBy(asc(githubRepoPermissions.repoId), asc(githubRepoPermissions.agentId));
    }),

  grantPermission: adminQuery
    .input(
      z.object({
        agentId: z.number(),
        repoId: z.number(),
        permissionLevel: z.enum(["read", "push", "admin"]),
      })
    )
    .mutation(async ({ input }) => {
      const db = getDb();

      const existing = await db
        .select()
        .from(githubRepoPermissions)
        .where(
          and(
            eq(githubRepoPermissions.agentId, input.agentId),
            eq(githubRepoPermissions.repoId, input.repoId)
          )
        )
        .then((r) => r[0]);

      if (existing) {
        await db
          .update(githubRepoPermissions)
          .set({ permissionLevel: input.permissionLevel, active: "true" })
          .where(eq(githubRepoPermissions.id, existing.id));
        return { success: true, updated: true, id: existing.id };
      }

      const result = await db.insert(githubRepoPermissions).values({
        agentId: input.agentId,
        repoId: input.repoId,
        permissionLevel: input.permissionLevel,
        active: "true",
      });

      return { success: true, id: (result as any).insertId };
    }),

  revokePermission: adminQuery
    .input(z.object({ permId: z.number() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      await db
        .update(githubRepoPermissions)
        .set({ active: "false" })
        .where(eq(githubRepoPermissions.id, input.permId));

      return { success: true };
    }),

  listPRs: authedQuery
    .input(
      z
        .object({
          repoId: z.number().optional(),
          status: z.enum(["pending", "approved", "rejected", "merged", "closed"]).optional(),
          limit: z.number().int().min(1).max(100).default(50),
        })
        .optional()
    )
    .query(async ({ input }) => {
      const db = getDb();
      const conditions: ReturnType<typeof eq>[] = [eq(githubPullRequests.status, input?.status ?? "pending")];

      if (input?.repoId) {
        conditions.push(eq(githubPullRequests.repoId, input.repoId));
      }

      const where = conditions.length === 1 ? conditions[0] : and(...(conditions as [any, any, ...any[]]));

      return db
        .select()
        .from(githubPullRequests)
        .where(where)
        .orderBy(desc(githubPullRequests.createdAt))
        .limit(input?.limit ?? 50);
    }),

  getPR: authedQuery.input(z.object({ prId: z.number() })).query(async ({ input }) => {
    const db = getDb();
    const pr = await db
      .select()
      .from(githubPullRequests)
      .where(eq(githubPullRequests.id, input.prId))
      .then((r) => r[0]);

    if (!pr) return null;

    const audit = await db
      .select()
      .from(githubAuditLog)
      .where(eq(githubAuditLog.prId, input.prId))
      .orderBy(asc(githubAuditLog.createdAt));

    return { ...pr, auditLog: audit };
  }),

  registerPR: adminQuery
    .input(
      z.object({
        agentId: z.number(),
        repoId: z.number(),
        prNumber: z.number().int().min(1),
        title: z.string().min(1).max(500),
        body: z.string().optional(),
        branchName: z.string().optional(),
        baseBranch: z.string().optional(),
        headSha: z.string().max(40).optional(),
      })
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const agentId = input.agentId;

      const hasPerm = await checkRepoPermission(agentId, input.repoId, "push");
      if (!hasPerm) {
        return { success: false, error: "permission_denied", detail: "Agent needs push or admin permission on this repo" };
      }

      const existing = await db
        .select()
        .from(githubPullRequests)
        .where(
          and(
            eq(githubPullRequests.repoId, input.repoId),
            eq(githubPullRequests.prNumber, input.prNumber)
          )
        )
        .then((r) => r[0]);

      if (existing) {
        return { success: false, error: "pr_already_registered", existingId: existing.id };
      }

      const result = await db.insert(githubPullRequests).values({
        repoId: input.repoId,
        prNumber: input.prNumber,
        title: input.title,
        body: input.body ?? null,
        branchName: input.branchName ?? null,
        baseBranch: input.baseBranch ?? null,
        headSha: input.headSha ?? null,
        authorAgentId: agentId,
        status: "pending",
      });

      const insertId = (result as any).insertId as number;

      await db.insert(githubAuditLog).values({
        prId: insertId,
        action: "register",
        agentId,
      });

      const created = await db
        .select()
        .from(githubPullRequests)
        .where(eq(githubPullRequests.id, insertId))
        .then((r) => r[0]);

      return { success: true, pr: created };
    }),

  approvePR: adminQuery
    .input(z.object({ prId: z.number(), reason: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const userId = ctx.user.id;

      const pr = await db
        .select()
        .from(githubPullRequests)
        .where(eq(githubPullRequests.id, input.prId))
        .then((r) => r[0]);

      if (!pr) {
        return { success: false, error: "pr_not_found" };
      }

      if (pr.status !== "pending") {
        return { success: false, error: "pr_not_pending", currentStatus: pr.status };
      }

      await db
        .update(githubPullRequests)
        .set({ status: "approved", approvedBy: userId, approvedAt: new Date() })
        .where(eq(githubPullRequests.id, input.prId));

      await db.insert(githubAuditLog).values({
        prId: input.prId,
        action: "approve",
        agentId: pr.authorAgentId ?? null,
        reason: input.reason ?? `approved_by_user:${userId}`,
      });

      const repo = await db
        .select()
        .from(githubRepos)
        .where(eq(githubRepos.id, pr.repoId))
        .then((r) => r[0]);

      const mergeResult = repo
        ? await mergeGitHubPR(repo.owner, repo.name, pr.prNumber)
        : { success: false, skipped: true, reason: "repo_not_found" as string | undefined };

      if (mergeResult.success) {
        await db
          .update(githubPullRequests)
          .set({ status: "merged", mergedAt: new Date() })
          .where(eq(githubPullRequests.id, input.prId));

        await db.insert(githubAuditLog).values({
          prId: input.prId,
          action: "merge",
          agentId: pr.authorAgentId ?? null,
          reason: `Merged via GitHub API by user:${userId}`,
        });
      }

      const updated = await db
        .select()
        .from(githubPullRequests)
        .where(eq(githubPullRequests.id, input.prId))
        .then((r) => r[0]);

      return {
        success: true,
        pr: updated,
        mergeSkipped: mergeResult.skipped,
        mergeSkippedReason: mergeResult.skipped ? (mergeResult.reason ?? null) : null,
        mergeSuccess: mergeResult.success,
      };
    }),

  rejectPR: adminQuery
    .input(z.object({ prId: z.number(), reason: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const userId = ctx.user.id;

      const pr = await db
        .select()
        .from(githubPullRequests)
        .where(eq(githubPullRequests.id, input.prId))
        .then((r) => r[0]);

      if (!pr) {
        return { success: false, error: "pr_not_found" };
      }

      if (pr.status !== "pending") {
        return { success: false, error: "pr_not_pending", currentStatus: pr.status };
      }

      await db
        .update(githubPullRequests)
        .set({ status: "rejected" })
        .where(eq(githubPullRequests.id, input.prId));

      await db.insert(githubAuditLog).values({
        prId: input.prId,
        action: "reject",
        agentId: pr.authorAgentId ?? null,
        reason: input.reason ?? `rejected_by_user:${userId}`,
      });

      const updated = await db
        .select()
        .from(githubPullRequests)
        .where(eq(githubPullRequests.id, input.prId))
        .then((r) => r[0]);

      return { success: true, pr: updated };
    }),

  listAuditLog: authedQuery
    .input(
      z
        .object({
          prId: z.number().optional(),
          limit: z.number().int().min(1).max(200).default(50),
        })
        .optional()
    )
    .query(async ({ input }) => {
      const db = getDb();
      let query = db.select().from(githubAuditLog).orderBy(desc(githubAuditLog.createdAt)).limit(input?.limit ?? 50);
      if (input?.prId) {
        query = query.where(eq(githubAuditLog.prId, input.prId)) as any;
      }
      return query;
    }),

  listAgents: authedQuery.query(async () => {
    const db = getDb();
    return db
      .select({
        id: agents.id,
        agentId: agents.agentId,
        name: agents.name,
        status: agents.status,
      })
      .from(agents)
      .orderBy(asc(agents.name));
  }),
});
