/**
 * P14 hardening: unified searchable event stream.
 *
 * Merges the audit ledger, task thread messages, and token usage into ONE
 * time-ordered feed (createdAt DESC; deterministic tie-break by source kind
 * rank then row id DESC). Admin-only.
 *
 * Pagination uses an opaque cursor: base64url(JSON { ts: ISO, rank: 0|1|2,
 * id }) identifying the position of the last returned row in the global order
 * (time DESC, kind rank ASC, id DESC). The next page is everything strictly
 * after that position, re-derived per source:
 *   rank > cursor.rank → createdAt <= ts
 *   rank = cursor.rank → createdAt < ts OR (createdAt = ts AND id < cid)
 *   rank < cursor.rank → createdAt < ts
 * This is a real keyset cursor — no OFFSET, no duplicates, no page drift.
 *
 * NOTE: the three source queries always run in fixed order audit → task →
 * usage (tests and the mock depend on this ordering).
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { createRouter, userQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { auditEvents, taskMessages, tokenUsage } from "@db/schema";
import { and, desc, eq, gte, lte, lt, or, type SQL } from "drizzle-orm";

const SOURCE_RANK = { audit: 0, task: 1, usage: 2 } as const;
type SourceKind = keyof typeof SOURCE_RANK;

// ─── Cursor (opaque base64url JSON) ───

const cursorSchema = z.object({
  ts: z.iso.datetime(),
  rank: z.number().int().min(0).max(2),
  id: z.number().int().positive(),
});
type CursorPayload = z.infer<typeof cursorSchema>;

function encodeCursor(ts: Date, rank: number, id: number): string {
  return Buffer.from(JSON.stringify({ ts: ts.toISOString(), rank, id })).toString("base64url");
}

function decodeCursor(raw: string): CursorPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf-8"));
  } catch {
    throw new TRPCError({ code: "BAD_REQUEST", message: "无效的游标" });
  }
  const result = cursorSchema.safeParse(parsed);
  if (!result.success) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "无效的游标" });
  }
  return result.data;
}

// ─── Per-source query builder ───

type SourceColumns = {
  createdAt: typeof auditEvents.createdAt | typeof taskMessages.createdAt | typeof tokenUsage.createdAt;
  id: typeof auditEvents.id | typeof taskMessages.id | typeof tokenUsage.id;
};
type EntityColumns = typeof auditEvents.entityId | typeof taskMessages.taskId | typeof tokenUsage.taskId;

/** Keyset condition: rows strictly after the cursor in the global order. */
function cursorCondition(cols: SourceColumns, sourceRank: number, c: CursorPayload): SQL | undefined {
  const ts = new Date(c.ts);
  if (sourceRank > c.rank) return lte(cols.createdAt, ts);
  if (sourceRank === c.rank) {
    return or(lt(cols.createdAt, ts), and(eq(cols.createdAt, ts), lt(cols.id, c.id)));
  }
  return lt(cols.createdAt, ts);
}

// ─── Normalized items (discriminated union) ───

type AuditItem = {
  kind: "audit";
  ts: string;
  id: string;
  entityType: string;
  entityId: number | null;
  actor: { userId: number };
  summary: string;
  metadata: string | null;
};
type TaskItem = {
  kind: "task";
  ts: string;
  id: string;
  entityId: number;
  summary: string;
  metadata: { contentPreview: string | null; fromAgentId: number | null; toAgentId: number | null };
};
type UsageItem = {
  kind: "usage";
  ts: string;
  id: string;
  entityId: number | null;
  summary: string;
  metadata: { provider: string | null; model: string; totalTokens: number; costCents: number };
};
export type UnifiedEventItem = AuditItem | TaskItem | UsageItem;

const CONTENT_PREVIEW_LEN = 120;

// ─── Router ───

const unifiedListInput = z.object({
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
  kind: z.enum(["audit", "task", "usage"]).optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  entityId: z.number().int().positive().optional(),
});

export const eventsRouter = createRouter({
  unifiedList: userQuery
    .input(unifiedListInput)
    .query(async ({ input, ctx }) => {
      if (ctx.user.role !== "admin") {
        throw new TRPCError({ code: "FORBIDDEN", message: "需要管理员权限" });
      }
      const db = getDb();
      const cursor = input.cursor ? decodeCursor(input.cursor) : null;
      const from = input.from ? new Date(input.from) : null;
      const to = input.to ? new Date(input.to) : null;
      const limit = input.limit;

      const selected = (input.kind ? [input.kind] : ["audit", "task", "usage"]) as SourceKind[];
      const items: UnifiedEventItem[] = [];

      for (const kind of selected) {
        const rank = SOURCE_RANK[kind];
        const conditions: SQL[] = [];
        if (cursor) {
          const cond = cursorCondition({ createdAt: createdAtOf(kind), id: idOf(kind) }, rank, cursor);
          if (cond) conditions.push(cond);
        }
        if (from) conditions.push(gte(createdAtOf(kind), from));
        if (to) conditions.push(lte(createdAtOf(kind), to));
        if (input.entityId !== undefined) conditions.push(eq(entityColOf(kind), input.entityId));

        if (kind === "audit") {
          const rows = await db
            .select()
            .from(auditEvents)
            .where(and(...conditions))
            .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
            .limit(limit);
          items.push(
            ...rows.map(
              (row): AuditItem => ({
                kind: "audit",
                ts: row.createdAt.toISOString(),
                id: `audit:${row.id}`,
                entityType: row.entityType,
                entityId: row.entityId ?? null,
                actor: { userId: row.actorUserId },
                summary: row.event,
                metadata: row.metadata,
              })
            )
          );
        } else if (kind === "task") {
          const rows = await db
            .select()
            .from(taskMessages)
            .where(and(...conditions))
            .orderBy(desc(taskMessages.createdAt), desc(taskMessages.id))
            .limit(limit);
          items.push(
            ...rows.map(
              (row): TaskItem => ({
                kind: "task",
                ts: row.createdAt.toISOString(),
                id: `task:${row.id}`,
                entityId: row.taskId,
                summary: row.eventType,
                metadata: {
                  contentPreview: row.content ? row.content.slice(0, CONTENT_PREVIEW_LEN) : null,
                  fromAgentId: row.fromAgentId ?? null,
                  toAgentId: row.toAgentId ?? null,
                },
              })
            )
          );
        } else {
          const rows = await db
            .select()
            .from(tokenUsage)
            .where(and(...conditions))
            .orderBy(desc(tokenUsage.createdAt), desc(tokenUsage.id))
            .limit(limit);
          items.push(
            ...rows.map(
              (row): UsageItem => ({
                kind: "usage",
                ts: row.createdAt.toISOString(),
                id: `usage:${row.id}`,
                entityId: row.taskId ?? null,
                summary: `${row.model} ${row.totalTokens}t $${(row.costCents / 100).toFixed(4)}`,
                metadata: {
                  provider: row.provider,
                  model: row.model,
                  totalTokens: row.totalTokens,
                  costCents: row.costCents,
                },
              })
            )
          );
        }
      }

      // Global order: time DESC, kind rank ASC, row id DESC. ISO strings
      // compare lexicographically, which equals chronologically here.
      items.sort((a, b) => {
        if (a.ts !== b.ts) return a.ts < b.ts ? 1 : -1;
        const rankDiff = SOURCE_RANK[a.kind] - SOURCE_RANK[b.kind];
        if (rankDiff !== 0) return rankDiff;
        return numericId(b.id) - numericId(a.id);
      });

      const page = items.slice(0, limit);
      const last = page[page.length - 1];
      const nextCursor =
        page.length === limit && last
          ? encodeCursor(new Date(last.ts), SOURCE_RANK[last.kind], numericId(last.id))
          : null;
      return { items: page, nextCursor };
    }),
});

function createdAtOf(kind: SourceKind): SourceColumns["createdAt"] {
  if (kind === "audit") return auditEvents.createdAt;
  if (kind === "task") return taskMessages.createdAt;
  return tokenUsage.createdAt;
}

function idOf(kind: SourceKind): SourceColumns["id"] {
  if (kind === "audit") return auditEvents.id;
  if (kind === "task") return taskMessages.id;
  return tokenUsage.id;
}

function entityColOf(kind: SourceKind): EntityColumns {
  if (kind === "audit") return auditEvents.entityId;
  if (kind === "task") return taskMessages.taskId;
  return tokenUsage.taskId;
}

/** Row id embedded in the opaque item id (`kind:id`). */
function numericId(itemId: string): number {
  return Number(itemId.slice(itemId.indexOf(":") + 1));
}
