// §3-4 可靠投递：终态归档/通知动作的补偿执行 sweeper。
// 每 60s tick 一次（与其它 sweeper 同节奏），领取到期的 task_finalize_actions 执行；
// 归档/通知失败按退避重试、耗尽进死信——不再"进程内尽力而为、失败即丢"。

import { runDueFinalizeActions } from "../finalize-actions";

export async function sweepFinalizeActions(db: unknown, now: Date): Promise<void> {
  const summary = await runDueFinalizeActions(db as never, now);
  if (summary.claimed > 0) {
    console.log(
      `[finalize-actions] sweep claimed=${summary.claimed} done=${summary.done} retried=${summary.retried} dead_letter=${summary.deadLettered}`,
    );
  }
}
