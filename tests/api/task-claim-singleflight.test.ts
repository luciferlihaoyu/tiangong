import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, markSystemReady } from "./helpers/test-db";
import { agents, tasks } from "@db/schema";
import { claimNextTask } from "../../api/lib/task-claim";

/**
 * 单飞闸（2026-11-09，commit 6c45286）的真实数据库覆盖。
 *
 * 闸门语义：claimNextTask 在预算闸之后、选任务之前，查该 agent 是否有
 * status="running" 的真在跑任务（`select({id}).from(tasks).where(eq(agentId), eq(status,"running")).limit(1)`），
 * 有则拒派新单返回 `{ task: null, reason: "agent_busy" }`。
 * 缺口实证：busy 标志只写不查——重复 connector 进程、租约回收重认都会
 * 绕过进程内串行叠加执行（#133 双执行、#136 三代执行器并存白烧 token）。
 *
 * 本文件用 helpers/test-db 的真内存 SQLite（非按序消费队列的假 DB），
 * 验证闸门的判定口径确实是 per-agent、且拒绝时绝不改动 queued 行。
 */
async function setup() {
  // 认领入口有就绪闸门（Phase B §2），未就绪一律不接单；本文件测单飞闸本身，先声明就绪
  markSystemReady();
  const { db, dispose } = createTestDb();
  return { db, dispose };
}

async function seedAgent(db: ReturnType<typeof createTestDb>["db"], handle: string) {
  await db.insert(agents).values({ agentId: handle, name: handle, system: "dsh" });
  const row = (await db.select().from(agents).where(eq(agents.agentId, handle)).get()) as { id: number };
  return row.id;
}

async function seedTask(
  db: ReturnType<typeof createTestDb>["db"],
  overrides: Record<string, unknown>,
): Promise<number> {
  await db.insert(tasks).values({
    name: "singleflight task",
    description: null,
    input: "{}",
    priority: 10,
    status: "queued",
    lifecycleStatus: "queued",
    ...overrides,
  } as never);
  const row = (await db
    .select()
    .from(tasks)
    .where(eq(tasks.taskId, overrides.taskId as string))
    .get()) as { id: number };
  return row.id;
}

describe("认领单飞闸 agent_busy（真实 SQLite）", () => {
  it("同 agent 已有 running 在跑任务 → 拒派新单，queued 行原样不动", async () => {
    const { db, dispose } = await setup();
    const agentId = await seedAgent(db, "sf-busy");

    // 一行真在跑（running）+ 一行可认领（queued），同一 agent
    const runningId = await seedTask(db, {
      taskId: "TG-SF-RUN",
      agentId,
      status: "running",
      lifecycleStatus: "working",
    });
    const queuedId = await seedTask(db, {
      taskId: "TG-SF-QUEUED",
      agentId,
      status: "queued",
      lifecycleStatus: "queued",
      priority: 50,
    });

    const result = await claimNextTask(db, agentId);

    // 拒绝形状：task=null + reason="agent_busy"（读码为准：ClaimNextReason 枚举之一）
    expect(result.task).toBeNull();
    expect(result.reason).toBe("agent_busy");

    // queued 行不得被改成 claimed/running，归属与修订号都不动
    const queuedRow = await db.select().from(tasks).where(eq(tasks.id, queuedId)).get();
    expect(queuedRow?.status).toBe("queued");
    expect(queuedRow?.lifecycleStatus).toBe("queued");
    expect(queuedRow?.agentId).toBe(agentId);
    expect(queuedRow?.claimedAt ?? null).toBeNull();
    expect(queuedRow?.stateRevision).toBe(1);

    // 在跑行也不许被顺手改写
    const runningRow = await db.select().from(tasks).where(eq(tasks.id, runningId)).get();
    expect(runningRow?.status).toBe("running");

    // 副作用不得泄漏：agent 不因拒派被置 busy
    const agentRow = await db.select().from(agents).where(eq(agents.id, agentId)).get();
    expect(agentRow?.status).not.toBe("busy");

    dispose();
  });

  it("对照组：同 agent 无 running 在跑任务 → 正常认领那条 queued", async () => {
    const { db, dispose } = await setup();
    const agentId = await seedAgent(db, "sf-free");

    const queuedId = await seedTask(db, {
      taskId: "TG-SF-FREE",
      agentId,
      status: "queued",
      lifecycleStatus: "queued",
    });

    const result = await claimNextTask(db, agentId);

    expect(result.reason).toBeUndefined();
    expect(result.task?.id).toBe(queuedId);
    expect(result.task?.taskId).toBe("TG-SF-FREE");

    const updated = await db.select().from(tasks).where(eq(tasks.id, queuedId)).get();
    expect(updated?.status).toBe("running");
    expect(updated?.agentId).toBe(agentId);
    expect(updated?.claimedAt).toBeTruthy();

    const agentRow = await db.select().from(agents).where(eq(agents.id, agentId)).get();
    expect(agentRow?.status).toBe("busy");

    dispose();
  });

  it("闸门口径 per-agent：running 行属于别的 agent → 不影响本 agent 认领", async () => {
    const { db, dispose } = await setup();
    const mine = await seedAgent(db, "sf-mine");
    const other = await seedAgent(db, "sf-other");

    // 别的 agent 有一行 running + 一行 queued（交叉场景：本 agent 认领时它的两行都必须零副作用）
    const otherRunningId = await seedTask(db, {
      taskId: "TG-SF-OTHER",
      agentId: other,
      status: "running",
      lifecycleStatus: "working",
    });
    const otherQueuedId = await seedTask(db, {
      taskId: "TG-SF-OTHER-Q",
      agentId: other,
      status: "queued",
      lifecycleStatus: "queued",
      priority: 99, // 优先级更高：若选任务口径写错，最容易被误认领的就是它
    });
    // 本 agent 只有一行 queued
    const queuedId = await seedTask(db, {
      taskId: "TG-SF-MINE",
      agentId: mine,
      status: "queued",
      lifecycleStatus: "queued",
    });

    const result = await claimNextTask(db, mine);

    expect(result.task?.id).toBe(queuedId);
    expect(result.reason).toBeUndefined();

    // 他人在跑的行不被触碰
    const otherRunning = await db.select().from(tasks).where(eq(tasks.id, otherRunningId)).get();
    expect(otherRunning?.agentId).toBe(other);
    expect(otherRunning?.status).toBe("running");

    // 评审 minor②：别人的 queued 行同样必须零副作用——不被认领、不改归属、不动修订号
    const otherQueued = await db.select().from(tasks).where(eq(tasks.id, otherQueuedId)).get();
    expect(otherQueued?.status).toBe("queued");
    expect(otherQueued?.lifecycleStatus).toBe("queued");
    expect(otherQueued?.agentId).toBe(other);
    expect(otherQueued?.claimedAt ?? null).toBeNull();
    expect(otherQueued?.stateRevision).toBe(1);

    dispose();
  });

  it("done/failed 等终态行不算在跑，不触发单飞闸", async () => {
    const { db, dispose } = await setup();
    const agentId = await seedAgent(db, "sf-terminal");

    await seedTask(db, {
      taskId: "TG-SF-DONE",
      agentId,
      status: "done",
      lifecycleStatus: "completed",
    });
    await seedTask(db, {
      taskId: "TG-SF-FAILED",
      agentId,
      status: "failed",
      lifecycleStatus: "failed",
    });
    const queuedId = await seedTask(db, {
      taskId: "TG-SF-AFTER",
      agentId,
      status: "queued",
      lifecycleStatus: "queued",
    });

    const result = await claimNextTask(db, agentId);

    expect(result.task?.id).toBe(queuedId);
    expect(result.reason).toBeUndefined();

    dispose();
  });
});
