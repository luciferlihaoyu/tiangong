import { and, eq, gt, lte } from "drizzle-orm";
import { taskExecutionSlots, tiangongTaskLimits } from "@db/schema";
import { getDb } from "../queries/connection";

const DEFAULT_MAX_CONCURRENT_TASKS = 8;

type AcquireSlotInput = Readonly<{
  taskId: number;
  principalKey: string;
  workspaceSlug: string;
  leaseToken: string;
  now: Date;
  expiresAt: Date;
  maxConcurrentTasks?: number;
}>;

export type AcquireSlotResult =
  | Readonly<{ acquired: true }>
  | Readonly<{ acquired: false; reason: "concurrency_limit" }>;

export async function acquireTaskSlot(input: AcquireSlotInput): Promise<AcquireSlotResult> {
  const db = getDb();
  return db.transaction(async (tx) => {
    await tx.delete(taskExecutionSlots).where(and(
      eq(taskExecutionSlots.principalKey, input.principalKey),
      eq(taskExecutionSlots.workspaceSlug, input.workspaceSlug),
      lte(taskExecutionSlots.expiresAt, input.now),
    ));
    const configured = await tx.select().from(tiangongTaskLimits).where(and(
      eq(tiangongTaskLimits.principalKey, input.principalKey),
      eq(tiangongTaskLimits.workspaceSlug, input.workspaceSlug),
    )).limit(1).then((rows) => rows[0]);
    const maximum = input.maxConcurrentTasks ?? configured?.maxConcurrentTasks ?? DEFAULT_MAX_CONCURRENT_TASKS;
    const active = await tx.select().from(taskExecutionSlots).where(and(
      eq(taskExecutionSlots.principalKey, input.principalKey),
      eq(taskExecutionSlots.workspaceSlug, input.workspaceSlug),
      gt(taskExecutionSlots.expiresAt, input.now),
    ));
    if (active.length >= maximum) return { acquired: false, reason: "concurrency_limit" };
    await tx.insert(taskExecutionSlots).values({
      taskId: input.taskId,
      principalKey: input.principalKey,
      workspaceSlug: input.workspaceSlug,
      leaseToken: input.leaseToken,
      acquiredAt: input.now,
      expiresAt: input.expiresAt,
    });
    return { acquired: true };
  });
}

export async function releaseTaskSlot(taskId: number, leaseToken: string): Promise<void> {
  await getDb().delete(taskExecutionSlots).where(and(
    eq(taskExecutionSlots.taskId, taskId),
    eq(taskExecutionSlots.leaseToken, leaseToken),
  ));
}
