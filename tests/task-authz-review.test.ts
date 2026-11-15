/**
 * 验收/状态写入授权纯函数判定矩阵（task-authz.canReviewTask / canWriteTaskStatus）
 *
 * 背景（2026-11 缺陷修复）：
 *   1) a2a.review 此前挂 adminQuery —— API Key 认证在中间件即 401，connector 的
 *      自动验收永远进不了过程体，"Task reviewed and approved" 审计记录长期缺失；
 *      过程体内那段"API Key 需 admin 角色"的检查因此是死代码。
 *   2) reportTaskProgress 只在 usage/artifacts 时做越权检查，status/lifecycleStatus
 *      对任意合法 Agent Key 敞开——任何 agent 可把别人的任务写成 done/failed。
 *
 * 分层说明（重要）：
 *   canReviewTask 只是**身份判定层**（谁有资格按下验收按钮），高风险任务的
 *   self-approve 防线在**调用方的完成闸门**（checkCompletionGate + parkTaskForApproval）。
 *   执行者对自己高风险任务在判定层拿到 ok:true **不代表能完成**——review 过程体
 *   随后必过闸门，blocked 即停放、绝不落 completed。本文件末尾用真实 SQLite +
 *   真实 a2aRouter 的集成用例锁死这一点：canReviewTask 不能成为 self-approve 后门。
 *
 * apiKeyAgentId 口径与 checkTaskWriteAuthorized / ctx.apiKeyAgentId 一致：
 *   null = 登录用户；-1 = 未绑定 agent 的管理型 Key；> 0 = Key 绑定的 agent。
 */
import { eq } from "drizzle-orm";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTestDb, markSystemReady, type TestDb } from "./api/helpers/test-db";
import * as schema from "@db/schema";

const conn = vi.hoisted(() => ({ getDb: vi.fn() }));
const wsMocks = vi.hoisted(() => ({ broadcastToDashboard: vi.fn(), broadcastToTask: vi.fn(), sendToAgent: vi.fn() }));
const gateMocks = vi.hoisted(() => ({ checkCompletionGate: vi.fn(), parkTaskForApproval: vi.fn() }));
const finalizeMocks = vi.hoisted(() => ({ enqueueTaskFinalize: vi.fn() }));

vi.mock("../api/queries/connection", () => ({ getDb: conn.getDb }));
vi.mock("../api/ws-manager", () => ({ wsManager: wsMocks }));
vi.mock("../api/lib/execution-gate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/lib/execution-gate")>()),
  checkCompletionGate: gateMocks.checkCompletionGate,
  parkTaskForApproval: gateMocks.parkTaskForApproval,
}));
vi.mock("../api/lib/finalize-actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/lib/finalize-actions")>()),
  enqueueTaskFinalize: finalizeMocks.enqueueTaskFinalize,
}));

import { canReviewTask, canWriteTaskStatus, checkTaskWriteAuthorized } from "../api/lib/task-authz";
import { a2aRouter } from "../api/a2a-router";
import { taskboardRouter } from "../api/taskboard-router";
import { reportTaskProgress } from "../api/lib/task-writeback";
import { createCallerFactory } from "../api/middleware";

const createA2aCaller = createCallerFactory(a2aRouter);
const createTaskboardCaller = createCallerFactory(taskboardRouter);

// ─── 判定矩阵输入速记 ───
const actorUserAdmin = { userRole: "admin", apiKeyAgentId: null };
const actorUserNormal = { userRole: "user", apiKeyAgentId: null };
const actorKeyUnbound = { userRole: null, apiKeyAgentId: -1 };
const actorKeyAgent5 = { userRole: null, apiKeyAgentId: 5 };
const actorKeyAgent6 = { userRole: null, apiKeyAgentId: 6 };
const taskOfAgent5 = { agentId: 5 };
const taskUnassigned = { agentId: null };

describe("canReviewTask — 验收身份判定", () => {
  it("普通登录用户（role=user）验收 → 拒绝（不得把『任何注册用户可批准任务』的洞打开）", () => {
    const r = canReviewTask(actorUserNormal, taskOfAgent5);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("admin");
  });

  it("admin 登录用户验收 → 放行，actorLabel = user:<id>(admin)", () => {
    const r = canReviewTask({ userRole: "admin", userId: 3, apiKeyAgentId: null }, taskOfAgent5);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.actorLabel).toBe("user:3(admin)");
  });

  it("管理型 Key（apiKeyAgentId=-1，未绑定 agent）→ 放行，actorLabel = key:unbound", () => {
    const r = canReviewTask(actorKeyUnbound, taskOfAgent5);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.actorLabel).toBe("key:unbound");
  });

  it("执行者本人（Key 绑定 agent == task.agentId）验收自己的低风险任务 → 放行，actorLabel = agent:<id>(executor)", () => {
    const r = canReviewTask(actorKeyAgent5, taskOfAgent5);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.actorLabel).toBe("agent:5(executor)");
  });

  it("非执行者的 agent Key 验收他人任务 → 拒绝", () => {
    const r = canReviewTask(actorKeyAgent6, taskOfAgent5);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("认领人");
  });

  it("admin 角色的 agent Key 验收任意任务 → 放行，actorLabel = agent:<id>(admin)", () => {
    const r = canReviewTask(actorKeyAgent6, taskOfAgent5, "admin");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.actorLabel).toBe("agent:6(admin)");
  });

  it("非 admin 角色的 agent Key 且非执行者 → 拒绝（actorAgentRole=null 缺省同样拒绝）", () => {
    expect(canReviewTask(actorKeyAgent6, taskOfAgent5, null).ok).toBe(false);
    expect(canReviewTask(actorKeyAgent6, taskOfAgent5, "worker").ok).toBe(false);
  });

  it("无主任务（agentId=null）：执行者分支不成立 → agent Key 拒绝；管理型 Key 仍放行", () => {
    expect(canReviewTask(actorKeyAgent5, taskUnassigned).ok).toBe(false);
    expect(canReviewTask(actorKeyUnbound, taskUnassigned).ok).toBe(true);
  });

  it("既无登录用户又无有效 Key（apiKeyAgentId=null 且 userRole=null）→ 拒绝", () => {
    expect(canReviewTask({ userRole: null, apiKeyAgentId: null }, taskOfAgent5).ok).toBe(false);
  });

  it("admin 登录用户与 agent Key 并存时按登录用户优先（审计标注为人）", () => {
    const r = canReviewTask({ userRole: "admin", userId: 9, apiKeyAgentId: -1 }, taskOfAgent5);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.actorLabel).toBe("user:9(admin)");
  });

  // ─── reviewer 支（2026-11 A2A 编排闭环补全）：执行者交付、验收方接受 ───

  const taskWithReviewer6 = { agentId: 5, reviewerId: 6 };

  it("被指派的验收方 agent Key（task.reviewerId === apiKeyAgentId）验收 → 放行，actorLabel = agent:<id>(reviewer)", () => {
    const r = canReviewTask(actorKeyAgent6, taskWithReviewer6);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.actorLabel).toBe("agent:6(reviewer)");
  });

  it("actorLabel 区分 reviewer 与 executor：同一任务执行者本人验收仍是 (executor)，审计可辨自批/他批", () => {
    const exec = canReviewTask(actorKeyAgent5, taskWithReviewer6);
    expect(exec.ok).toBe(true);
    if (exec.ok) expect(exec.actorLabel).toBe("agent:5(executor)");
    const rev = canReviewTask(actorKeyAgent6, taskWithReviewer6);
    if (rev.ok && exec.ok) expect(rev.actorLabel).not.toBe(exec.actorLabel);
  });

  it("既非执行者也非验收方的第三方 agent Key 验收有 reviewerId 的任务 → 拒绝（越权面不因 reviewer 扩大）", () => {
    const r = canReviewTask({ userRole: null, apiKeyAgentId: 7 }, taskWithReviewer6);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("验收方");
  });

  it("reviewerId 为 null / undefined / 缺省：非执行者 Key 一律拒绝（显式防 null/undefined 混淆误放行）", () => {
    for (const t of [
      { agentId: 5, reviewerId: null },
      { agentId: 5, reviewerId: undefined },
      { agentId: 5 },
    ]) {
      expect(canReviewTask(actorKeyAgent6, t).ok).toBe(false);
    }
  });

  it("无主任务（agentId=null）但指派了 reviewer：reviewer Key 放行 (reviewer)、其他绑定 Key 拒绝", () => {
    const orphanReviewed = { agentId: null, reviewerId: 6 };
    const r = canReviewTask(actorKeyAgent6, orphanReviewed);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.actorLabel).toBe("agent:6(reviewer)");
    expect(canReviewTask(actorKeyAgent5, orphanReviewed).ok).toBe(false);
  });

  it("判定顺序人在前：普通登录用户 + reviewer Key 并存仍拒绝（以人为准，不因 Key 是 reviewer 放宽）", () => {
    const normalUser = canReviewTask({ userRole: "user", userId: 4, apiKeyAgentId: 6 }, taskWithReviewer6);
    expect(normalUser.ok).toBe(false);
  });

  it("管理型 Key（-1）在有 reviewerId 的任务上仍按管理位放行", () => {
    const r = canReviewTask(actorKeyUnbound, taskWithReviewer6);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.actorLabel).toBe("key:unbound");
  });

  // ─── 兜底分支锁定（绊马索）：apiKeyAgentId 落在定义域之外 ───
  // 代码事实（已开码核实 canReviewTask 函数体分支顺序）：userRole 两支都要求
  // apiKeyAgentId === null 才可能提前返回；随后 -1 走管理位放行、>0 走绑定 agent
  // 三支判定。apiKeyAgentId = 0 / -2 时以上分支全部不中（0 非 null、非 -1，且
  // `actor.apiKeyAgentId > 0` 为假），只能落到函数末尾的兜底拒绝。
  // 故意用最恶劣输入：若有人把该兜底"顺手放宽"成放行，本组用例立刻变红。
  it.each([0, -2])("越界 apiKeyAgentId=%i + userRole=null → 兜底拒绝（reason 含『无法识别』）", (badId) => {
    const r = canReviewTask({ userRole: null, apiKeyAgentId: badId }, taskOfAgent5);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("无法识别");
  });
});

describe("canWriteTaskStatus — 状态写入身份判定（堵 reportTaskProgress 越权面）", () => {
  it("登录用户（任意角色）→ 放行（沿用 checkTaskWriteAuthorized 的管理位口径）", () => {
    expect(canWriteTaskStatus(actorUserAdmin, taskOfAgent5).ok).toBe(true);
    expect(canWriteTaskStatus(actorUserNormal, taskOfAgent5).ok).toBe(true);
  });

  it("管理型 Key（-1）→ 放行", () => {
    expect(canWriteTaskStatus(actorKeyUnbound, taskOfAgent5).ok).toBe(true);
  });

  it("执行者本人回写自己任务的状态（connector 提交结果并 done）→ 放行", () => {
    expect(canWriteTaskStatus(actorKeyAgent5, taskOfAgent5).ok).toBe(true);
  });

  it("非执行者的 agent Key 改写他人任务状态 → 拒绝（真越权面）", () => {
    const r = canWriteTaskStatus(actorKeyAgent6, taskOfAgent5);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("认领人");
  });

  it("admin 角色的 agent Key → 放行（与 canReviewTask 同口径）", () => {
    expect(canWriteTaskStatus(actorKeyAgent6, taskOfAgent5, "admin").ok).toBe(true);
  });

  it("无主任务（agentId=null）+ 绑定 agent Key → 拒绝（内建 Runner 走系统通道，不受影响）", () => {
    expect(canWriteTaskStatus(actorKeyAgent5, taskUnassigned).ok).toBe(false);
  });

  it("匿名（无 user 无 Key）→ 拒绝", () => {
    expect(canWriteTaskStatus({ userRole: null, apiKeyAgentId: null }, taskOfAgent5).ok).toBe(false);
  });

  // ─── 契约锁定（2026-11 reviewer 扩权时明确）：验收与改状态是两种权限 ───

  it("reviewer 身份不扩状态写入面：被指派为 reviewerId 的 agent Key 用 canWriteTaskStatus 写他人任务状态 → 拒绝（即使带 reviewerId 字段传入）", () => {
    // 视图里带着 reviewerId —— canWriteTaskStatus 必须零引用它
    const r = canWriteTaskStatus(actorKeyAgent6, { agentId: 5, reviewerId: 6 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("认领人");
  });

  it("有意不对称契约：admin 角色 agent 且非执行者 —— canWriteTaskStatus 放行、checkTaskWriteAuthorized 拒绝（勿『顺手统一』）", () => {
    expect(canWriteTaskStatus(actorKeyAgent6, taskOfAgent5, "admin").ok).toBe(true);
    const artifactAuthz = checkTaskWriteAuthorized(6, { agentId: 5 });
    expect(artifactAuthz.ok).toBe(false);
    if (!artifactAuthz.ok) expect(artifactAuthz.error).toContain("认领人");
  });

  // ─── 兜底分支锁定（绊马索）：apiKeyAgentId 落在定义域之外 ───
  // 代码事实（已开码核实 canWriteTaskStatus 函数体分支顺序）：null → 登录用户放行、
  // -1 → 管理位放行、>0 → admin 角色/执行者判定。0 / -2 三支全不中
  // （0 非 null、非 -1，且 `actor.apiKeyAgentId > 0` 为假），只能落到末尾兜底拒绝。
  // 故意用最恶劣输入：若有人把该兜底"顺手放宽"成放行，本组用例立刻变红。
  it.each([0, -2])("越界 apiKeyAgentId=%i + userRole=null → 兜底拒绝（reason 含『无法识别』）", (badId) => {
    const r = canWriteTaskStatus({ userRole: null, apiKeyAgentId: badId }, { agentId: 1, reviewerId: null });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("无法识别");
  });
});

// ─── 集成形状：证明 canReviewTask 不是 self-approve 后门 ───
// 分层：判定层对"执行者验收自己的任务"一律放行（这是修复缺陷 1 的前提），
// 但 review 过程体在 approved=true 分支必须先过 checkCompletionGate；
// 高风险任务即使执行者亲自验收也会被 parkTaskForApproval 拦下、绝不落 completed。
// 这里用真实 SQLite + 真实 a2aRouter 复现该链路（gate mock 成 blocked，模拟
// execution-gate 对 decision=pending 高风险任务的真实判定——判定逻辑本身已由
// tests/api/execution-gate.test.ts 覆盖，此处只验证接线顺序不可被绕过）。
let testDb: TestDb;

beforeEach(() => {
  testDb = createTestDb();
  markSystemReady();
  conn.getDb.mockReturnValue(testDb.db);
  wsMocks.broadcastToDashboard.mockReset();
  gateMocks.checkCompletionGate.mockReset();
  gateMocks.parkTaskForApproval.mockReset().mockResolvedValue(undefined as never);
  finalizeMocks.enqueueTaskFinalize.mockReset().mockResolvedValue(undefined as never);
});

afterEach(() => {
  testDb.dispose();
});

async function seedExecutorAndSubmittedTask(): Promise<{ agentId: number; taskId: number }> {
  const [agentRow] = await testDb.db
    .insert(schema.agents)
    .values({ agentId: `a-rv-${Math.random().toString(36).slice(2, 7)}`, name: "执行者", system: "openclaw", status: "online" })
    .returning({ id: schema.agents.id });
  const [taskRow] = await testDb.db
    .insert(schema.tasks)
    .values({
      taskId: `T-RV-${Math.random().toString(36).slice(2, 7)}`,
      name: "高风险部署",
      description: "deploy production",
      agentId: agentRow.id,
      status: "running",
      boardStatus: "running",
      lifecycleStatus: "submitted",
    })
    .returning({ id: schema.tasks.id });
  return { agentId: agentRow.id, taskId: taskRow.id };
}

describe("a2a.review 集成形状：执行者验收高风险任务仍被闸门拦截", () => {
  it("executor Key 验收自己的高风险任务 → success:false，停放且不落 completed、不触发归档", async () => {
    const { agentId, taskId } = await seedExecutorAndSubmittedTask();
    gateMocks.checkCompletionGate.mockReturnValue({
      status: "blocked",
      reason: "Task requires human approval before completion (zeabur_deploy)",
      riskTypes: ["zeabur_deploy"],
    });

    // 执行者本人的 API Key（无登录用户）——正是 connector 自动验收的真实形态
    const caller = createA2aCaller({
      req: new Request("http://localhost"),
      user: null,
      apiKeyAgentId: agentId,
      servicePrincipal: null,
    } as never);

    const result = await caller.review({ taskId, approved: true, note: "Connector auto-approved" });

    expect(result.success).toBe(false);
    expect(String((result as { error?: string }).error)).toContain("requires human approval");
    expect(gateMocks.checkCompletionGate).toHaveBeenCalled();
    expect(gateMocks.parkTaskForApproval).toHaveBeenCalled();
    expect(finalizeMocks.enqueueTaskFinalize).not.toHaveBeenCalled();
    const row = await testDb.db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).then((r) => r[0]);
    expect(row.lifecycleStatus).not.toBe("completed");
    expect(row.status).not.toBe("done");
  });

  it("executor Key 验收自己的低风险任务（闸门放行）→ success:true，审计事件写明 actorLabel", async () => {
    const { agentId, taskId } = await seedExecutorAndSubmittedTask();
    gateMocks.checkCompletionGate.mockReturnValue({ status: "allowed" });

    const caller = createA2aCaller({
      req: new Request("http://localhost"),
      user: null,
      apiKeyAgentId: agentId,
      servicePrincipal: null,
    } as never);

    const result = await caller.review({ taskId, approved: true });
    expect(result.success).toBe(true);

    const row = await testDb.db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).then((r) => r[0]);
    expect(row.lifecycleStatus).toBe("completed");
    expect(row.status).toBe("done");

    const events = await testDb.db
      .select()
      .from(schema.taskMessages)
      .where(eq(schema.taskMessages.taskId, taskId));
    const reviewEvent = events.find((e) => String(e.content ?? "").includes("reviewed and approved"));
    expect(reviewEvent).toBeTruthy();
    expect(String(reviewEvent?.content)).toContain(`agent:${agentId}(executor)`);
    expect(JSON.parse(String(reviewEvent?.metadata)).actorLabel).toBe(`agent:${agentId}(executor)`);
    expect(finalizeMocks.enqueueTaskFinalize).toHaveBeenCalled();
  });

  it("非执行者的 agent Key 验收他人任务 → 判定层拒绝，不落任何状态变更", async () => {
    const { taskId } = await seedExecutorAndSubmittedTask();
    gateMocks.checkCompletionGate.mockReturnValue({ status: "allowed" });

    const caller = createA2aCaller({
      req: new Request("http://localhost"),
      user: null,
      apiKeyAgentId: 999_999,
      servicePrincipal: null,
    } as never);

    const result = await caller.review({ taskId, approved: true });
    expect(result.success).toBe(false);
    expect(gateMocks.checkCompletionGate).not.toHaveBeenCalled();
    const row = await testDb.db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).then((r) => r[0]);
    expect(row.lifecycleStatus).toBe("submitted");
  });
});

// ─── reviewer 扩权（2026-11 A2A 编排闭环补全）的集成形状 ───
// 覆盖：真实 taskboard.submit 落库 reviewerId → reviewer Key 经 a2a.review 验收闭环；
// reviewer 高风险负例（闸门必拦，证明扩 reviewer 没开出 self-approve 后门）；
// reviewer 无状态写入权限（reportTaskProgress / taskboard.progress 两个入口都锁）。
async function seedOrchestratedPair(): Promise<{ dispatcherId: number; executorId: number; childId: number }> {
  const mkAgent = async (label: string) => {
    const [row] = await testDb.db
      .insert(schema.agents)
      .values({ agentId: `a-${label}-${Math.random().toString(36).slice(2, 7)}`, name: label, system: "openclaw", status: "online" })
      .returning({ id: schema.agents.id });
    return row.id;
  };
  const dispatcherId = await mkAgent("dispatcher");
  const executorId = await mkAgent("executor");
  const rand = Math.random().toString(36).slice(2, 7);
  const [parentRow] = await testDb.db
    .insert(schema.tasks)
    .values({
      taskId: `T-ORP-${rand}`,
      name: "编排父任务",
      description: "orchestration parent",
      agentId: dispatcherId,
      status: "running",
      boardStatus: "running",
      lifecycleStatus: "working",
    })
    .returning({ id: schema.tasks.id });
  const [childRow] = await testDb.db
    .insert(schema.tasks)
    .values({
      taskId: `T-ORC-${rand}`,
      name: "子任务交付",
      description: "subtask for review",
      agentId: executorId,
      parentTaskId: parentRow.id,
      status: "running",
      boardStatus: "running",
      lifecycleStatus: "working",
    })
    .returning({ id: schema.tasks.id });
  return { dispatcherId, executorId, childId: childRow.id };
}

describe("reviewer 验收闭环：真实 submit 落库 reviewerId → a2a.review 放行", () => {
  it("taskboard.submit 按「父任务 agentId」指派验收方；随后派发方 Key 走 a2a.review 验收成功，审计 actorLabel=(reviewer)", async () => {
    const { dispatcherId, executorId, childId } = await seedOrchestratedPair();
    gateMocks.checkCompletionGate.mockReturnValue({ status: "allowed" });

    // 执行者提交交付（真实 submit 过程会算 reviewerId = 父任务 agentId 并落库）
    const tbCaller = createTaskboardCaller({
      req: new Request("http://localhost"),
      user: null,
      apiKeyAgentId: executorId,
      servicePrincipal: null,
    } as never);
    const submitted = await tbCaller.submit({ taskId: childId, agentId: executorId, output: "交付完成" });
    expect(submitted.success).toBe(true);

    const afterSubmit = await testDb.db.select().from(schema.tasks).where(eq(schema.tasks.id, childId)).then((r) => r[0]);
    expect(afterSubmit.reviewerId).toBe(dispatcherId);

    // 生命周期推进到 submitted——正是编排里"交付待验收"的真实形态
    const a2aExec = createA2aCaller({
      req: new Request("http://localhost"),
      user: null,
      apiKeyAgentId: executorId,
      servicePrincipal: null,
    } as never);
    const sr = await a2aExec.submitResult({ taskId: childId, agentId: executorId, output: "交付完成" });
    expect(sr.success).toBe(true);

    // 派发方（被指派的验收方，非执行者、非 admin 角色）验收——本轮修复的核心通路
    const a2aDispatcher = createA2aCaller({
      req: new Request("http://localhost"),
      user: null,
      apiKeyAgentId: dispatcherId,
      servicePrincipal: null,
    } as never);
    const reviewed = await a2aDispatcher.review({ taskId: childId, approved: true });
    expect(reviewed.success).toBe(true);

    const row = await testDb.db.select().from(schema.tasks).where(eq(schema.tasks.id, childId)).then((r) => r[0]);
    expect(row.lifecycleStatus).toBe("completed");
    expect(row.status).toBe("done");

    const events = await testDb.db
      .select()
      .from(schema.taskMessages)
      .where(eq(schema.taskMessages.taskId, childId));
    const reviewEvent = events.find((e) => String(e.content ?? "").includes("reviewed and approved"));
    expect(reviewEvent).toBeTruthy();
    expect(String(reviewEvent?.content)).toContain(`agent:${dispatcherId}(reviewer)`);
    expect(JSON.parse(String(reviewEvent?.metadata)).actorLabel).toBe(`agent:${dispatcherId}(reviewer)`);
  });

  it("reviewer 验收高风险任务 → 判定层放行但被 checkCompletionGate 拦住，停放且不落 completed（扩 reviewer 未开 self-approve 后门）", async () => {
    const { dispatcherId, executorId, childId } = await seedOrchestratedPair();
    gateMocks.checkCompletionGate.mockReturnValue({
      status: "blocked",
      reason: "Task requires human approval before completion (zeabur_deploy)",
      riskTypes: ["zeabur_deploy"],
    });

    const tbCaller = createTaskboardCaller({
      req: new Request("http://localhost"),
      user: null,
      apiKeyAgentId: executorId,
      servicePrincipal: null,
    } as never);
    await tbCaller.submit({ taskId: childId, agentId: executorId });

    const a2aExec = createA2aCaller({
      req: new Request("http://localhost"),
      user: null,
      apiKeyAgentId: executorId,
      servicePrincipal: null,
    } as never);
    await a2aExec.submitResult({ taskId: childId, agentId: executorId });

    const a2aDispatcher = createA2aCaller({
      req: new Request("http://localhost"),
      user: null,
      apiKeyAgentId: dispatcherId,
      servicePrincipal: null,
    } as never);
    const reviewed = await a2aDispatcher.review({ taskId: childId, approved: true });

    // 能走到闸门（判定层已放行），但被闸门锁下——与 executor 高风险负例同构
    expect(gateMocks.checkCompletionGate).toHaveBeenCalled();
    expect(reviewed.success).toBe(false);
    expect(String((reviewed as { error?: string }).error)).toContain("requires human approval");
    expect(gateMocks.parkTaskForApproval).toHaveBeenCalled();
    expect(finalizeMocks.enqueueTaskFinalize).not.toHaveBeenCalled();
    const row = await testDb.db.select().from(schema.tasks).where(eq(schema.tasks.id, childId)).then((r) => r[0]);
    expect(row.lifecycleStatus).not.toBe("completed");
    expect(row.status).not.toBe("done");
  });

  it("reviewerId 为 null 的任务（无父无派发方）：非执行者 Key 验收 → 判定层拒绝，不落状态变更", async () => {
    const { taskId } = await seedExecutorAndSubmittedTask(); // 无 parentTaskId/dispatcherAgentId → reviewerId 保持 null
    gateMocks.checkCompletionGate.mockReturnValue({ status: "allowed" });

    const caller = createA2aCaller({
      req: new Request("http://localhost"),
      user: null,
      apiKeyAgentId: 999_999,
      servicePrincipal: null,
    } as never);
    const result = await caller.review({ taskId, approved: true });
    expect(result.success).toBe(false);
    const row0 = await testDb.db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).then((r) => r[0]);
    expect(row0.reviewerId).toBeNull();
    expect(gateMocks.checkCompletionGate).not.toHaveBeenCalled();
    const row = await testDb.db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).then((r) => r[0]);
    expect(row.lifecycleStatus).toBe("submitted");
  });
});

describe("reviewer 不扩状态写入面（第 4 点契约，真实入口锁定）", () => {
  it("reviewer Key 用 reportTaskProgress 写别人（执行者）任务的状态 → 拒绝且状态原样不动", async () => {
    const { dispatcherId, executorId, childId } = await seedOrchestratedPair();
    const tbCaller = createTaskboardCaller({
      req: new Request("http://localhost"),
      user: null,
      apiKeyAgentId: executorId,
      servicePrincipal: null,
    } as never);
    await tbCaller.submit({ taskId: childId, agentId: executorId });
    const before = await testDb.db.select().from(schema.tasks).where(eq(schema.tasks.id, childId)).then((r) => r[0]);
    expect(before.reviewerId).toBe(dispatcherId); // 前提成立：该 Key 确实是本任务的验收方

    // MCP report_progress 同一事实源：reviewer Key 试图把别人的任务写成 done
    const res = await reportTaskProgress(
      testDb.db as never,
      { id: childId, progress: 100, status: "done" } as never,
      { apiKeyAgentId: dispatcherId } as never
    );
    expect(res.success).toBe(false);
    expect(String((res as { error?: string }).error)).toContain("认领人");
    const row = await testDb.db.select().from(schema.tasks).where(eq(schema.tasks.id, childId)).then((r) => r[0]);
    expect(row.status).toBe("running");
    expect(row.stateRevision).toBe(before.stateRevision);
  });

  it("reviewer Key 走 taskboard.progress 入口写别人任务状态 → 同样拒绝（两入口共用 canWriteTaskStatus，不放宽）", async () => {
    const { dispatcherId, executorId, childId } = await seedOrchestratedPair();
    const tbExec = createTaskboardCaller({
      req: new Request("http://localhost"),
      user: null,
      apiKeyAgentId: executorId,
      servicePrincipal: null,
    } as never);
    await tbExec.submit({ taskId: childId, agentId: executorId });

    const tbDispatcher = createTaskboardCaller({
      req: new Request("http://localhost"),
      user: null,
      apiKeyAgentId: dispatcherId,
      servicePrincipal: null,
    } as never);
    const res = await tbDispatcher.progress({ taskId: childId, progress: 100, status: "done" });
    expect(res.success).toBe(false);
    expect(String((res as { error?: string }).error)).toContain("认领人");
    const row = await testDb.db.select().from(schema.tasks).where(eq(schema.tasks.id, childId)).then((r) => r[0]);
    expect(row.status).toBe("running");
  });
});
