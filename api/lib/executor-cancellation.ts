const runningExecutors = new Map<number, AbortController>();

export function registerExecutor(taskId: number): AbortSignal {
  const controller = new AbortController();
  runningExecutors.set(taskId, controller);
  return controller.signal;
}

export function unregisterExecutor(taskId: number): void {
  runningExecutors.delete(taskId);
}

export function requestExecutorCancellation(taskId: number): boolean {
  const controller = runningExecutors.get(taskId);
  if (!controller) return false;
  controller.abort("task_cancel_requested");
  return true;
}
