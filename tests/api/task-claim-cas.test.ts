import { describe, expect, it } from "vitest";
import { createTestDb, markSystemReady } from "./helpers/test-db";
import { agents, tasks } from "@db/schema";
import { claimNextTask } from "../../api/lib/task-claim";

/**
 * 任务认领的 CAS（compare-and-swap）验证 —— 真实 SQLite 适配器。
 *
 * 原实现是「先查后按 id 更新」：findClaimableTask 查到 queued 任务后，
 * 用 `.where(eq(tasks.id, task.id))` 无条件置为 running。两个 Agent 在同一
 * tick 并发认领时，双方都能查到同一任务、双方的 UPDATE 都会成功（后者直接
 * 覆盖前者的 agentId），于是**两个 Agent 都拿到同一个任务**——重复执行同一
 * 任务，这是并发认领里最严重的失效模式。
 *
 * 正确契约：WHERE 必须带上预期状态，并按真实受影响行数裁决胜负；
 * 只有胜者才返回任务并触发副作用（把 Agent 置为 busy）。
 */
async function setup() {
  // Phase B §2 起，认领入口有就绪闸门（未就绪一律不接单）；本文件测的是 CAS 本身，
  // 因此先声明系统已就绪，否则会被闸门先挡住、测不到 CAS。
  markSystemReady();

  const { db, dispose } = createTestDb();
  await db.insert(agents).values({ agentId: "cas-a", name: "Agent A", system: "dsh" });
  await db.insert(agents).values({ agentId: "cas-b", name: "Agent B", system: "dsh" });
  const agentRows = db.select().from(agents).all() as Array<{ id: number; agentId: string }>;

  // 通用任务（agentId = null）：两个 Agent 都能看到，正是竞态的前提
  await db.insert(tasks).values({
    taskId: "TG-CAS01",
    name: "任务只能被认领一次",
    agentId: null,
    description: "cas",
    priority: 0,
    input: "{}",
    status: "queued",
    lifecycleStatus: "queued",
  } as never);
  const taskRow = db.select().from(tasks).all()[0] as { id: number };
  return { db, dispose, agentRows, taskId: taskRow.id };
}

describe("任务认领 CAS（真实 SQLite 适配器）", () => {
  it("两个 Agent 并发认领同一任务：只有一个成功，另一个明确失败", async () => {
    const { db, dispose, agentRows, taskId } = await setup();
    const [a, b] = agentRows;

    const [ra, rb] = await Promise.all([
      claimNextTask(db, a.id),
      claimNextTask(db, b.id),
    ]);
    const results = [ra, rb];
    const winners = results.filter((r) => r.task !== null);

    // 核心断言：不许双认领
    expect(winners).toHaveLength(1);

    const loser = results.find((r) => r.task === null);
    expect(loser).toBeDefined();
    expect(loser?.reason).toBe("already_claimed");

    // 任务归属唯一，且落在胜者名下
    const finalTask = db.select().from(tasks).all()[0] as { id: number; status: string; agentId: number | null };
    expect(finalTask.status).toBe("running");
    const winnerAgentId = results[0].task ? a.id : b.id;
    expect(finalTask.agentId).toBe(winnerAgentId);
    expect(finalTask.id).toBe(taskId);

    // 副作用不得泄漏：败者不应被置为 busy
    const finalAgents = db.select().from(agents).all() as Array<{ id: number; status: string }>;
    const loserAgentId = winnerAgentId === a.id ? b.id : a.id;
    expect(finalAgents.find((x) => x.id === loserAgentId)?.status).not.toBe("busy");
    expect(finalAgents.find((x) => x.id === winnerAgentId)?.status).toBe("busy");

    dispose();
  });

  it("任务已被认领后，再认领同一任务不会成功", async () => {
    const { db, dispose, agentRows } = await setup();
    const [a, b] = agentRows;

    const first = await claimNextTask(db, a.id);
    expect(first.task).not.toBeNull();

    // a 已认领；b 再来认领同一个（唯一的）任务 → 无任务可认领
    const second = await claimNextTask(db, b.id);
    expect(second.task).toBeNull();

    dispose();
  });
});
