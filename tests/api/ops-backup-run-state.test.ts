/**
 * C-2（2026-11-16）：**手动备份必须让运维面板"看见这一跑"**。
 *
 * 缺陷原貌（AGENTS.md 已记为"面板空白"，本用例把它钉成可执行判据）：
 * `ops.backupRun` 有意绕开 sweeper 的节流判断直调 `runBackupJob`，跑完只 `return report`，
 * **从不回写模块级 state**；而 `ops.backupStatus` 的 `lastRunAt/lastReport` 读的正是那个 state
 * （`api/lib/sweepers/db-backup.ts` 的 `backupSweepState()`）。于是手动备份成功之后，
 * 面板仍显示 `lastRunAt: null`——人看不见就等于没发生，接着要么重复触发、要么误判链条已断。
 *
 * 修法口径：状态写入收敛成**单一入口** `noteBackupRun(now, report)`，
 * 定时 sweeper 与手动端点都只经它写。所以本文件两条用例测的是"两条路都必须留痕"，
 * 而不是"手动那条特殊"——只测手动那条的话，把 sweeper 的写入删掉照样全绿（误绿）。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// 只替身 `runBackupJob`（真跑会拷生产库）；其余导出保持原样，
// 这样 createBackupUploader / backupDir / backupSweepState / state 全是真的。
const jobMocks = vi.hoisted(() => ({ runBackupJob: vi.fn() }));

vi.mock("../../api/lib/db-backup", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/lib/db-backup")>()),
  runBackupJob: jobMocks.runBackupJob,
}));

// tests/setup.ts 全局只替身了 getDb，而备份链路要 `resolveDbPath(env.databaseUrl)`
// （快照已由上面的 runBackupJob 替身，这里的路径参数不会被真打开）。
// 本文件的覆盖按 vitest 规则晚于 setup 生效，与其他 suite 覆盖 getDb 的做法同形。
vi.mock("../../api/queries/connection", () => ({
  getDb: vi.fn(() => {
    throw new Error("C-2 用例不该碰库");
  }),
  resolveDbPath: (raw: string) => raw || "/tmp/ops-backup-run-state.db",
}));

import { createCallerFactory } from "../../api/middleware";
import { opsRouter } from "../../api/ops-router";
import { backupSweepState, sweepDbBackup } from "../../api/lib/sweepers/db-backup";
import { markSystemReady } from "./helpers/test-db";
import type { BackupJobReport } from "../../api/lib/db-backup";

const callerOf = createCallerFactory(opsRouter);
const CTX = { user: { id: 1, role: "admin" }, apiKeyAgentId: null } as never;

function report(detail: string): BackupJobReport {
  return { ok: true, detail, uploadedTo: undefined, pruned: { kept: [], removed: [] } };
}

beforeEach(() => {
  jobMocks.runBackupJob.mockReset();
});

describe("C-2 备份运行状态：两条路都必须留痕", () => {
  it("手动 ops.backupRun 跑完后，面板状态必须反映这一跑（修复前 lastRunAt 恒 null）", async () => {
    const r = report("手动演练：快照已生成");
    jobMocks.runBackupJob.mockResolvedValue(r);

    const before = backupSweepState();
    expect(before.lastRunAt).toBe(null); // 起点必须干净，否则下面的断言是撞运气

    const caller = callerOf(CTX);
    const returned = await caller.backupRun();

    const after = backupSweepState();
    expect(returned.detail).toBe("手动演练：快照已生成"); // 返回值语义不变（没顺手改契约）
    expect(after.lastReport?.detail).toBe("手动演练：快照已生成");
    expect(after.lastRunAt).not.toBe(null);
    // 手动端点与 sweeper 共用入口后，同一时刻写出的 ISO 必须可解析且非空
    expect(Number.isNaN(Date.parse(String(after.lastRunAt)))).toBe(false);
    expect(after.skippedReason).toBe(null);
  });

  it("定时 sweeper 真跑一轮同样经单一入口留痕（删掉它的写入就必须变红，防误绿）", async () => {
    markSystemReady(); // 未就绪会被跳过，那样 lastRunAt 不写、用例假绿
    const r = report("定时：快照已生成并通过校验");
    jobMocks.runBackupJob.mockResolvedValue(r);

    const now = new Date("2026-11-16T12:00:00Z");
    await sweepDbBackup(undefined, now);

    const state = backupSweepState();
    expect(state.lastRunAt).toBe(now.toISOString()); // 与传入的 now 严格相等：证明走的是同一入口
    expect(state.lastReport?.detail).toBe("定时：快照已生成并通过校验");
    expect(jobMocks.runBackupJob).toHaveBeenCalledTimes(1);
  });

  it("绊马索：未就绪时 sweeper 只记 skippedReason，**不得**把 lastRunAt 推进", async () => {
    // 故意构造未就绪：readiness 是进程内单例，前一条用例已 markSystemReady，
    // 这里用 recordExecutor(false) 把它推翻。保留此用例是为了钉住
    // "跳过的一轮不算跑过"——若有人把 noteBackupRun 提到跳过分支之前，这条立刻变红。
    const { readiness } = await import("../../api/lib/readiness");
    readiness.recordExecutor(false);
    jobMocks.runBackupJob.mockClear();

    const now = new Date("2026-11-16T13:00:00Z");
    await sweepDbBackup(undefined, now);

    const state = backupSweepState();
    expect(state.lastRunAt).not.toBe(now.toISOString());
    expect(state.skippedReason).toMatch(/未就绪/);
    expect(jobMocks.runBackupJob).not.toHaveBeenCalled();
  });
});
