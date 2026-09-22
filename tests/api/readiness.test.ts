import { describe, expect, it } from "vitest";
import { createTestDb } from "./helpers/test-db";
import { agents, tasks } from "@db/schema";
import { claimNextTask } from "../../api/lib/task-claim";
import { createReadinessStore, readiness, type ReadinessStore } from "../../api/lib/readiness";

/**
 * 就绪状态（readiness）与「不接单」（Phase B §2）。
 *
 * 原状况：/health 只尝试 getDb()，只能证明"能开连接"，**证明不了迁移和执行器就绪**；
 * 迁移失败时进程照常启动、照常把任务派给 Agent，故障被推迟到运行时才爆发。
 *
 * 契约（路线图 §2）：
 *   - 关键环节（迁移 / schema 对齐 / 执行器 / 事件派发）未就绪 → readiness=false 且**不接单**；
 *   - 可选集成失败 → 降级（degraded），不影响 ready；
 *   - 初始（还没跑完迁移）必须是**未就绪**：宁可不接单，也不能接了一半才发现库不对。
 */

function markAllReady(store: ReadinessStore): void {
  store.recordMigration(true);
  store.recordSchemaDrift([]);
  store.recordExecutor(true);
  store.recordOutbox(true);
}

/** 造一个可被任何 Agent 认领的通用任务 */
async function setupClaimable() {
  const { db, dispose } = createTestDb();
  await db.insert(agents).values({ agentId: "rdy-a", name: "Agent A", system: "dsh" });
  const agentRow = db.select().from(agents).all()[0] as { id: number };
  await db.insert(tasks).values({
    taskId: "TG-RDY01",
    name: "就绪前不得被认领",
    agentId: null,
    description: "readiness",
    priority: 0,
    input: "{}",
    status: "queued",
    lifecycleStatus: "queued",
  } as never);
  const taskRow = db.select().from(tasks).all()[0] as { id: number };
  return { db, dispose, agentId: agentRow.id, taskId: taskRow.id };
}

describe("就绪状态判定", () => {
  it("初始状态是未就绪：还没跑完迁移就必须拒绝接单", () => {
    const store = createReadinessStore();
    const snap = store.snapshot();
    expect(snap.ready).toBe(false);
    expect(snap.reasons.length).toBeGreaterThan(0);
  });

  it("四个关键环节都就绪后 ready=true", () => {
    const store = createReadinessStore();
    markAllReady(store);
    const snap = store.snapshot();
    expect(snap.ready).toBe(true);
    expect(snap.reasons).toEqual([]);
  });

  it("迁移失败 → 不就绪，并给出可读原因", () => {
    const store = createReadinessStore();
    markAllReady(store);
    store.recordMigration(false, "no such table: tasks");
    const snap = store.snapshot();
    expect(snap.ready).toBe(false);
    expect(snap.reasons.join("\n")).toMatch(/迁移/);
    expect(snap.reasons.join("\n")).toMatch(/no such table: tasks/);
  });

  it("schema 与代码不一致（补列被跳过）→ 不就绪，并点名是哪一列", () => {
    const store = createReadinessStore();
    markAllReady(store);
    store.recordSchemaDrift([{ table: "tasks", column: "created_at", reason: "非默认值/非常量" }]);
    const snap = store.snapshot();
    expect(snap.ready).toBe(false);
    const text = snap.reasons.join("\n");
    expect(text).toMatch(/tasks\.created_at/);
  });

  it("执行器与事件派发未就绪 → 不就绪", () => {
    const store = createReadinessStore();
    markAllReady(store);
    store.recordExecutor(false, "Task Runner start failed");
    expect(store.snapshot().ready).toBe(false);

    const store2 = createReadinessStore();
    markAllReady(store2);
    store2.recordOutbox(false, "dispatcher start failed");
    const snap2 = store2.snapshot();
    expect(snap2.ready).toBe(false);
    expect(snap2.reasons.join("\n")).toMatch(/派发|outbox/i);
  });

  it("可选集成失败只降级，不影响 ready", () => {
    const store = createReadinessStore();
    markAllReady(store);
    store.recordDegraded("mysql-import", "DATABASE_URL not set");
    store.recordDegraded("github", "appId missing");
    const snap = store.snapshot();
    expect(snap.ready).toBe(true);
    expect(snap.degraded).toHaveLength(2);
    expect(snap.degraded.join("\n")).toMatch(/mysql-import/);
  });
});

describe("不接单：就绪闸门", () => {
  it("未就绪时认领被拒，任务保持 queued 且 Agent 不被置为 busy", async () => {
    const { db, dispose, agentId, taskId } = await setupClaimable();
    readiness.reset();

    const result = await claimNextTask(db, agentId);

    expect(result.task).toBeNull();
    expect(result.reason).toBe("not_ready");

    const taskRow = db.select().from(tasks).all()[0] as { id: number; status: string; agentId: number | null };
    expect(taskRow.status).toBe("queued");
    expect(taskRow.agentId).toBeNull();

    const agentRow = db.select().from(agents).all()[0] as { id: number; status: string };
    expect(agentRow.status).not.toBe("busy");
    expect(taskId).toBeGreaterThan(0);
    dispose();
  });

  it("就绪后同一任务可被正常认领（闸门不误伤正常流程）", async () => {
    const { db, dispose, agentId } = await setupClaimable();
    readiness.reset();
    markAllReady(readiness);

    const result = await claimNextTask(db, agentId);

    expect(result.reason).toBeUndefined();
    expect(result.task).not.toBeNull();
    const taskRow = db.select().from(tasks).all()[0] as { status: string; agentId: number | null };
    expect(taskRow.status).toBe("running");
    expect(taskRow.agentId).toBe(agentId);
    dispose();
  });
});
