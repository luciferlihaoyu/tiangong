import { beforeEach, describe, expect, it, vi } from "vitest";
import { taskExecutionSlots, tiangongTaskLimits } from "@db/schema";

const shared = vi.hoisted(() => ({ db: null as unknown as import("./helpers/fake-db").FakeDb }));

vi.mock("../../api/queries/connection", async () => {
  const mod = await import("./helpers/fake-db");
  mod.fakeDbRegistry.instance = mod.createFakeDb();
  shared.db = mod.fakeDbRegistry.instance;
  return { getDb: () => mod.fakeDbRegistry.instance };
});

import { acquireTaskSlot, releaseTaskSlot } from "../../api/lib/task-concurrency";

const NOW = new Date("2026-08-13T12:00:00.000Z");

describe("DB-backed Tiangong task concurrency", () => {
  beforeEach(() => shared.db.reset());

  it("atomically caps concurrent work per principal and workspace", async () => {
    await shared.db.insert(tiangongTaskLimits).values({ principalKey: "agent:7", workspaceSlug: "ws-a", maxConcurrentTasks: 2 });

    const results = await Promise.all([1, 2, 3].map((taskId) => acquireTaskSlot({
      taskId,
      principalKey: "agent:7",
      workspaceSlug: "ws-a",
      leaseToken: `lease-${taskId}`,
      now: NOW,
      expiresAt: new Date(NOW.getTime() + 60_000),
    })));

    expect(results.filter((result) => result.acquired)).toHaveLength(2);
    expect(shared.db.rowsOfTable(taskExecutionSlots)).toHaveLength(2);
  });

  it("isolates limits by principal/workspace and releases a slot", async () => {
    const first = await acquireTaskSlot({ taskId: 1, principalKey: "agent:1", workspaceSlug: "ws-a", leaseToken: "a", now: NOW, expiresAt: new Date(NOW.getTime() + 60_000), maxConcurrentTasks: 1 });
    const other = await acquireTaskSlot({ taskId: 2, principalKey: "agent:2", workspaceSlug: "ws-a", leaseToken: "b", now: NOW, expiresAt: new Date(NOW.getTime() + 60_000), maxConcurrentTasks: 1 });
    expect(first.acquired).toBe(true);
    expect(other.acquired).toBe(true);
    await releaseTaskSlot(1, "a");
    const replacement = await acquireTaskSlot({ taskId: 3, principalKey: "agent:1", workspaceSlug: "ws-a", leaseToken: "c", now: NOW, expiresAt: new Date(NOW.getTime() + 60_000), maxConcurrentTasks: 1 });
    expect(replacement.acquired).toBe(true);
  });
});
