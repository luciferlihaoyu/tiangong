/**
 * TaskCenter 共享类型 — 自 src/pages/TaskCenter.tsx 逐段搬迁（原 L39-84），行为保持。
 */
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../api/router";

export interface Agent {
  id: number;
  agentId: string;
  name: string;
  source: string;
  model: string | null;
  role: string | null;
  capabilities: string | null;
  status: "online" | "busy" | "idle";
  departmentId: number | null;
}

export interface Task {
  id: number;
  taskId: string;
  name: string;
  agentId: number | null;
  status: "pending" | "queued" | "running" | "done" | "failed";
  lifecycleStatus: string | null;
  progress: number;
  description: string | null;
  priority: number;
  input: string | null;
  output: string | null;
  error: string | null;
  retryCount: number;
  maxRetries: number;
  parentTaskId: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface Conversation {
  id: number;
  title: string;
  status: string;
}

type RouterOutputs = inferRouterOutputs<AppRouter>;
export type CollabStatus = RouterOutputs["collab"]["status"];
export type CollabSummary = RouterOutputs["collab"]["summary"];
export type CollabSubtask = CollabStatus["subtasks"][number];
