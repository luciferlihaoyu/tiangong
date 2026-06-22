// Shared types for taskboard components

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
  status: string;
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
  boardStatus: string | null;
  boardLabels: string | null;
  boardNotes: string | null;
  sourceUrl: string | null;
  reviewerId: number | null;
  reviewResult: string | null;
  claimedAt: string | null;
  readyAt: string | null;
  reviewAt: string | null;
  blockedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskMessage {
  id: number;
  taskId: number;
  threadId: number | null;
  fromAgentId: number | null;
  toAgentId: number | null;
  eventType: string;
  content: string | null;
  metadata: unknown;
  createdAt: string;
}

export interface TaskArtifact {
  id: number;
  taskId: number;
  agentId: number | null;
  type: string;
  name: string | null;
  content: string | null;
  jsonPayload: unknown;
  mimeType: string | null;
  createdAt: string;
}

export interface TaskDetail {
  id: number;
  taskId: string;
  name: string;
  agentId: number | null;
  status: string;
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
  boardStatus: string | null;
  boardLabels: string[] | null;
  boardNotes: string | null;
  sourceUrl: string | null;
  reviewerId: number | null;
  reviewResult: string | null;
  claimedAt: string | null;
  readyAt: string | null;
  reviewAt: string | null;
  blockedAt: string | null;
  createdAt: string;
  updatedAt: string;
  threadMessages: TaskMessage[];
  artifacts: TaskArtifact[];
}

export const BOARD_STATUSES = [
  "triage",
  "backlog",
  "todo",
  "ready",
  "running",
  "review",
  "blocked",
  "done",
  "failed",
  "cancelled",
] as const;

export type BoardStatus = (typeof BOARD_STATUSES)[number];

// 调色板：降低饱和度，统一天宫主题 teal accent
// 参考 taste-skill: 最大1个强调色，饱和度<80%，中性底色
const STATUS_PALETTE: Record<BoardStatus, { dot: string; header: string }> = {
  triage: { dot: "var(--text-muted)", header: "var(--text-muted)" },
  backlog: { dot: "var(--text-secondary)", header: "var(--text-secondary)" },
  todo: { dot: "var(--text-primary)", header: "var(--text-primary)" },
  ready: { dot: "#5b8def", header: "#5b8def" },
  running: { dot: "#5b8def", header: "#5b8def" },
  review: { dot: "#b8944a", header: "#b8944a" },
  blocked: { dot: "#b84a42", header: "#b84a42" },
  done: { dot: "#4a9a6e", header: "#4a9a6e" },
  failed: { dot: "#7a7a7a", header: "#7a7a7a" },
  cancelled: { dot: "#5a5a5a", header: "#5a5a5a" },
};

export const BOARD_STATUS_CONFIG: Record<
  BoardStatus,
  { label: string; color: string; headerColor: string; borderColor: string; bgColor: string }
> = Object.fromEntries(
  BOARD_STATUSES.map((s) => {
    const p = STATUS_PALETTE[s];
    return [
      s,
      {
        label: s.charAt(0).toUpperCase() + s.slice(1),
        color: p.dot,
        headerColor: p.header,
        borderColor: p.dot + "22",
        bgColor: p.dot + "08",
      },
    ];
  })
) as Record<BoardStatus, { label: string; color: string; headerColor: string; borderColor: string; bgColor: string }>;

export const PRIORITY_LABELS: Record<number, string> = {
  0: "普通",
  1: "低",
  2: "中",
  3: "高",
  4: "紧急",
  5: "最高",
};

export const PRIORITY_COLORS: Record<number, string> = {
  0: "var(--text-muted)",
  1: "var(--text-secondary)",
  2: "var(--accent-cyan)",
  3: "var(--accent-gold)",
  4: "var(--accent-red)",
  5: "var(--accent-red)",
};

export function fmtTime(iso: string) {
  const d = new Date(iso);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function parseLabels(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((s) => typeof s === "string");
  } catch {}
  return [];
}

export interface StatusAction {
  label: string;
  to: BoardStatus;
  api: "claim" | "submit" | "approve" | "requestChanges" | "reject" | "block" | "unblock" | "updateStatus";
  needsReason?: boolean;
  needsAgent?: boolean;
}

export const STATUS_ACTIONS: Record<BoardStatus, StatusAction[]> = {
  triage: [
    { label: "→ Backlog", to: "backlog", api: "updateStatus" },
    { label: "→ Cancelled", to: "cancelled", api: "updateStatus" },
  ],
  backlog: [
    { label: "→ Todo", to: "todo", api: "updateStatus" },
    { label: "→ Triage", to: "triage", api: "updateStatus" },
    { label: "→ Cancelled", to: "cancelled", api: "updateStatus" },
  ],
  todo: [
    { label: "→ Ready", to: "ready", api: "updateStatus" },
    { label: "→ Backlog", to: "backlog", api: "updateStatus" },
    { label: "→ Cancelled", to: "cancelled", api: "updateStatus" },
  ],
  ready: [
    { label: "▶ Claim", to: "running", api: "claim", needsAgent: true },
    { label: "→ Blocked", to: "blocked", api: "block", needsReason: true },
    { label: "→ Backlog", to: "backlog", api: "updateStatus" },
    { label: "→ Cancelled", to: "cancelled", api: "updateStatus" },
  ],
  running: [
    { label: "✓ Submit", to: "review", api: "submit" },
    { label: "→ Blocked", to: "blocked", api: "block", needsReason: true },
    { label: "→ Failed", to: "failed", api: "updateStatus" },
    { label: "→ Cancelled", to: "cancelled", api: "updateStatus" },
  ],
  review: [
    { label: "✓ Approve", to: "done", api: "approve" },
    { label: "↻ Request Changes", to: "running", api: "requestChanges" },
    { label: "✗ Reject", to: "failed", api: "reject" },
    { label: "→ Blocked", to: "blocked", api: "block", needsReason: true },
    { label: "→ Cancelled", to: "cancelled", api: "updateStatus" },
  ],
  blocked: [
    { label: "↻ Unblock", to: "todo", api: "unblock" },
    { label: "→ Todo", to: "todo", api: "updateStatus" },
    { label: "→ Ready", to: "ready", api: "updateStatus" },
    { label: "→ Running", to: "running", api: "updateStatus" },
    { label: "→ Cancelled", to: "cancelled", api: "updateStatus" },
  ],
  done: [],
  failed: [
    { label: "↻ Reopen", to: "triage", api: "updateStatus" },
  ],
  cancelled: [],
};
