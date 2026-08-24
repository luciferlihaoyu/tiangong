/**
 * 通知中心 NC-4：agent.notifications tRPC（list / markRead / markAllRead）
 *
 * 覆盖：
 *   - list：管理位（-1 / 登录用户）跨 agent 全量；绑定 agent 的 Key 只看自己（越权数据隔离）
 *   - list unreadOnly 过滤 / cursor 游标分页（id 单调游标 + nextCursor）
 *   - markRead：正常（管理位 / 标自己）/ 越权（异主 affectedRows 0）/ 不存在
 *   - markAllRead：只标作用域内未读，返回数量
 *
 * 用 tests/api/helpers/fake-db.ts（真实 where 求值 + limit 截断 + createdAt 默认）。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createFakeDb } from "./helpers/fake-db";
import { notifications } from "@db/schema";

const db = createFakeDb();

vi.mock("../../api/queries/connection", () => ({ getDb: () => db }));
vi.mock("../../api/ws-manager", () => ({
  wsManager: { broadcastToDashboard: vi.fn(), broadcast: vi.fn(), sendToAgent: vi.fn(), isOnline: vi.fn(() => false) },
}));
vi.mock("../../api/lib/collaboration-events", () => ({
  emitCollabSummaryForTask: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../api/lib/task-finalize", () => ({
  finalizeCompletedTask: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../api/lib/password", () => ({
  hashPassword: vi.fn(async (s: string) => `hashed_${s}`),
  verifyPassword: vi.fn(async (s: string, h: string) => h === `hashed_${s}`),
}));

import { agentRouter } from "../../api/agent-router";
import { createCallerFactory } from "../../api/middleware";

const caller = createCallerFactory(agentRouter);

function mockCtx(overrides: Record<string, unknown> = {}) {
  return { req: new Request("http://localhost"), user: null, apiKeyAgentId: -1, ...overrides };
}

function seedNotification(overrides: Record<string, unknown> = {}) {
  return db.insert(notifications).values({
    agentId: 1,
    type: "task_approved",
    taskId: null,
    title: "通知标题",
    body: "通知正文",
    metadata: null,
    readAt: null,
    ...overrides,
  });
}

beforeEach(() => {
  db.reset();
});

describe("agent.notifications.list（NC-4）", () => {
  it("管理位（-1）跨 agent 看全量", async () => {
    await seedNotification({ agentId: 1, title: "A" });
    await seedNotification({ agentId: 2, title: "B" });
    await seedNotification({ agentId: 3, title: "C" });

    const res = await caller(mockCtx({ apiKeyAgentId: -1 })).notifications.list({});

    expect(res.items).toHaveLength(3);
    expect(res.nextCursor).toBeUndefined();
  });

  it("登录用户（无 Key）同样看全量", async () => {
    await seedNotification({ agentId: 1, title: "A" });
    await seedNotification({ agentId: 2, title: "B" });

    const res = await caller(mockCtx({ user: { id: 1, role: "admin" }, apiKeyAgentId: null })).notifications.list({});

    expect(res.items).toHaveLength(2);
  });

  it("绑定 agent 的 Key 只看自己（越权数据隔离）", async () => {
    await seedNotification({ agentId: 5, title: "own" });
    await seedNotification({ agentId: 6, title: "other" });

    const res = await caller(mockCtx({ apiKeyAgentId: 5 })).notifications.list({});

    expect(res.items).toHaveLength(1);
    expect(res.items[0]?.title).toBe("own");
    expect(res.items[0]?.agentId).toBe(5);
  });

  it("unreadOnly 只返回未读", async () => {
    await seedNotification({ agentId: 1, readAt: null });
    await seedNotification({ agentId: 1, readAt: new Date("2025-01-01T00:00:00Z") });

    const res = await caller(mockCtx({ apiKeyAgentId: -1 })).notifications.list({ unreadOnly: true });

    expect(res.items).toHaveLength(1);
    expect(res.items[0]?.readAt).toBeNull();
  });

  it("cursor 游标分页：满页给 nextCursor，下一页按 id<cursor 过滤", async () => {
    for (let i = 1; i <= 3; i++) await seedNotification({ agentId: 5, title: `n${i}` });

    const p1 = await caller(mockCtx({ apiKeyAgentId: 5 })).notifications.list({ limit: 2 });
    expect(p1.items).toHaveLength(2);
    expect(p1.nextCursor).toBe(p1.items[1]?.id);

    const p2 = await caller(mockCtx({ apiKeyAgentId: 5 })).notifications.list({ limit: 2, cursor: p1.nextCursor });
    expect(p2.items).toHaveLength(1);
    expect((p2.items[0]?.id as number) < (p1.nextCursor as number)).toBe(true);
    expect(p2.nextCursor).toBeUndefined();
  });

  it("limit 上限 100 / 下限 1 由 zod 校验", async () => {
    const caller5 = caller(mockCtx({ apiKeyAgentId: -1 }));
    await expect(caller5.notifications.list({ limit: 0 })).rejects.toThrow();
    await expect(caller5.notifications.list({ limit: 101 })).rejects.toThrow();
  });
});

describe("agent.notifications.markRead（NC-4）", () => {
  it("管理位可标任意通知", async () => {
    await seedNotification({ agentId: 1, readAt: null });

    const res = await caller(mockCtx({ apiKeyAgentId: -1 })).notifications.markRead({ id: 1 });

    expect(res.marked).toBe(true);
    expect(db.rowsOfTable(notifications)[0]?.readAt).toBeInstanceOf(Date);
  });

  it("绑定 agent 的 Key 可标自己的通知", async () => {
    await seedNotification({ agentId: 5, readAt: null });

    const res = await caller(mockCtx({ apiKeyAgentId: 5 })).notifications.markRead({ id: 1 });

    expect(res.marked).toBe(true);
    expect(db.rowsOfTable(notifications)[0]?.readAt).toBeInstanceOf(Date);
  });

  it("绑定 agent 的 Key 标别人的通知 → marked=false 且不改动", async () => {
    await seedNotification({ agentId: 6, readAt: null });

    const res = await caller(mockCtx({ apiKeyAgentId: 5 })).notifications.markRead({ id: 1 });

    expect(res.marked).toBe(false);
    expect(db.rowsOfTable(notifications)[0]?.readAt).toBeNull();
  });

  it("id 不存在 → marked=false", async () => {
    const res = await caller(mockCtx({ apiKeyAgentId: -1 })).notifications.markRead({ id: 999 });
    expect(res.marked).toBe(false);
  });
});

describe("agent.notifications.markAllRead（NC-4）", () => {
  it("绑定 agent 的 Key 只标自己的未读并返回数量", async () => {
    await seedNotification({ agentId: 5, readAt: null });
    await seedNotification({ agentId: 5, readAt: null });
    await seedNotification({ agentId: 5, readAt: new Date("2025-01-01T00:00:00Z") });
    await seedNotification({ agentId: 6, readAt: null });

    const res = await caller(mockCtx({ apiKeyAgentId: 5 })).notifications.markAllRead({});

    expect(res.marked).toBe(2);
    // 自己两条未读已标读
    const own = db.rowsOfTable(notifications).filter((r) => r.agentId === 5);
    expect(own.every((r) => r.readAt !== null)).toBe(true);
    // agent 6 的未读不受影响
    const other = db.rowsOfTable(notifications).filter((r) => r.agentId === 6);
    expect(other[0]?.readAt).toBeNull();
  });

  it("管理位标全部未读", async () => {
    await seedNotification({ agentId: 5, readAt: null });
    await seedNotification({ agentId: 6, readAt: null });
    await seedNotification({ agentId: 6, readAt: new Date("2025-01-01T00:00:00Z") });

    const res = await caller(mockCtx({ apiKeyAgentId: -1 })).notifications.markAllRead({});

    expect(res.marked).toBe(2);
  });
});
