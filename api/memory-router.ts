import { z } from "zod";
import { createRouter, publicQuery, authedQuery } from "./middleware";
import { XuanjiConnectorError, type XuanjiConnectorClient } from "./connectors/xuanji/client";
import { createXuanjiClient } from "./connectors/xuanji/service";
import {
  GetMemoryDigestRequestSchema,
  LinkArtifactRequestSchema,
  SearchContextRequestSchema,
  StartIngestionRequestSchema,
  WriteTaskMemoryRequestSchema,
} from "./connectors/xuanji/types";
import { getDb } from "./queries/connection";
import { agentMemories } from "@db/schema";
import { eq, and, like } from "drizzle-orm";

type XuanjiRouterResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: "xuanji_not_configured" }
  | { readonly ok: false; readonly error: "xuanji_request_failed"; readonly message: string };

async function callXuanji<T>(
  request: (client: XuanjiConnectorClient) => Promise<T>
): Promise<XuanjiRouterResult<T>> {
  const client = createXuanjiClient();
  if (!client) {
    return { ok: false, error: "xuanji_not_configured" };
  }

  try {
    return { ok: true, data: await request(client) };
  } catch (error) {
    if (error instanceof XuanjiConnectorError) {
      return { ok: false, error: "xuanji_request_failed", message: error.message };
    }
    throw error;
  }
}

export const memoryRouter = createRouter({
  // ─── 个人记忆 ───
  get: authedQuery
    .input(z.object({ agentId: z.number(), key: z.string() }))
    .query(async ({ input }) => {
      const db = getDb();
      return db.select().from(agentMemories)
        .where(and(eq(agentMemories.agentId, input.agentId), eq(agentMemories.key, input.key)))
        .then(r => r[0] || null);
    }),

  set: authedQuery
    .input(z.object({ agentId: z.number(), key: z.string().max(100), value: z.string(), type: z.enum(["personal", "shared", "company"]).default("personal"), tags: z.string().optional() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const existing = await db.select().from(agentMemories)
        .where(and(eq(agentMemories.agentId, input.agentId), eq(agentMemories.key, input.key)))
        .then(r => r[0]);
      if (existing) {
        await db.update(agentMemories).set({ value: input.value, type: input.type, tags: input.tags, updatedAt: new Date() })
          .where(eq(agentMemories.id, existing.id));
      } else {
        await db.insert(agentMemories).values({ agentId: input.agentId, key: input.key, value: input.value, type: input.type, tags: input.tags });
      }
      return { success: true };
    }),

  list: authedQuery
    .input(z.object({ agentId: z.number(), type: z.enum(["personal", "shared", "company"]).optional(), tag: z.string().optional() }))
    .query(async ({ input }) => {
      const db = getDb();
      const conditions = [eq(agentMemories.agentId, input.agentId)];
      if (input.type) conditions.push(eq(agentMemories.type, input.type));
      if (input.tag) conditions.push(like(agentMemories.tags, `%${input.tag}%`));
      return db.select().from(agentMemories).where(and(...conditions));
    }),

  delete: authedQuery
    .input(z.object({ agentId: z.number(), key: z.string() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      await db.delete(agentMemories)
        .where(and(eq(agentMemories.agentId, input.agentId), eq(agentMemories.key, input.key)));
      return { success: true };
    }),

  // ─── 公司级共享记忆（所有 Agent 可读） ───
  getCompany: publicQuery
    .input(z.object({ key: z.string() }))
    .query(async ({ input }) => {
      const db = getDb();
      return db.select().from(agentMemories)
        .where(and(eq(agentMemories.type, "company"), eq(agentMemories.key, input.key)))
        .then(r => r[0] || null);
    }),

  setCompany: authedQuery
    .input(z.object({ key: z.string().max(100), value: z.string(), tags: z.string().optional() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      // company memories are stored with agentId=0 (shared)
      const existing = await db.select().from(agentMemories)
        .where(and(eq(agentMemories.agentId, 0), eq(agentMemories.key, input.key)))
        .then(r => r[0]);
      if (existing) {
        await db.update(agentMemories).set({ value: input.value, tags: input.tags, updatedAt: new Date() })
          .where(eq(agentMemories.id, existing.id));
      } else {
        await db.insert(agentMemories).values({ agentId: 0, key: input.key, value: input.value, type: "company", tags: input.tags });
      }
      return { success: true };
    }),

  listCompany: publicQuery
    .input(z.object({ tag: z.string().optional() }))
    .query(async ({ input }) => {
      const db = getDb();
      const conditions = [eq(agentMemories.type, "company")];
      if (input.tag) conditions.push(like(agentMemories.tags, `%${input.tag}%`));
      return db.select().from(agentMemories).where(and(...conditions));
    }),

  xuanjiSearchContext: authedQuery
    .input(SearchContextRequestSchema)
    .query(async ({ input }) => callXuanji((client) => client.searchContext(input))),

  xuanjiWriteTaskMemory: authedQuery
    .input(WriteTaskMemoryRequestSchema)
    .mutation(async ({ input }) => callXuanji((client) => client.writeTaskMemory(input))),

  xuanjiLinkArtifact: authedQuery
    .input(LinkArtifactRequestSchema)
    .mutation(async ({ input }) => callXuanji((client) => client.linkArtifact(input))),

  xuanjiGetMemoryDigest: authedQuery
    .input(GetMemoryDigestRequestSchema)
    .query(async ({ input }) => callXuanji((client) => client.getMemoryDigest(input))),

  xuanjiStartIngestion: authedQuery
    .input(StartIngestionRequestSchema)
    .mutation(async ({ input }) => callXuanji((client) => client.startIngestion(input))),
});
