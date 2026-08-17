export const EXTERNAL_STATES = {
  created: { status: "pending", approvalRequired: false, runState: "created", terminal: false },
  queued: { status: "queued", approvalRequired: false, runState: "queued", terminal: false },
  approval_pending: { status: "pending", approvalRequired: true, runState: "approval_pending", terminal: false },
  running: { status: "running", approvalRequired: false, runState: "running", terminal: false },
  submitted: { status: "running", approvalRequired: false, runState: "submitted", terminal: false },
  cancel_requested: { status: "running", approvalRequired: false, runState: "cancel_requested", terminal: false },
  completed: { status: "done", approvalRequired: false, runState: "completed", terminal: true },
  failed: { status: "failed", approvalRequired: false, runState: "failed", terminal: true },
  cancelled: { status: "failed", approvalRequired: false, runState: "cancelled", terminal: true },
} as const;

export type ExternalStateName = keyof typeof EXTERNAL_STATES;
export type ExternalStateActor = "service_principal" | "approver" | "worker" | "sweeper";

type ExternalTransition = Readonly<{
  from: ExternalStateName;
  to: ExternalStateName;
  actor: ExternalStateActor;
}>;

export const EXTERNAL_STATE_TRANSITIONS = [
  { from: "created", to: "queued", actor: "worker" },
  { from: "created", to: "approval_pending", actor: "worker" },
  { from: "created", to: "cancelled", actor: "service_principal" },
  { from: "queued", to: "approval_pending", actor: "worker" },
  { from: "approval_pending", to: "queued", actor: "approver" },
  { from: "approval_pending", to: "cancelled", actor: "service_principal" },
  { from: "queued", to: "running", actor: "worker" },
  { from: "queued", to: "cancelled", actor: "service_principal" },
  { from: "running", to: "submitted", actor: "worker" },
  { from: "submitted", to: "completed", actor: "worker" },
  { from: "running", to: "failed", actor: "worker" },
  { from: "submitted", to: "failed", actor: "worker" },
  { from: "running", to: "cancel_requested", actor: "service_principal" },
  { from: "submitted", to: "cancel_requested", actor: "service_principal" },
  { from: "cancel_requested", to: "cancelled", actor: "worker" },
  { from: "running", to: "queued", actor: "sweeper" },
  { from: "submitted", to: "queued", actor: "sweeper" },
  { from: "cancel_requested", to: "cancelled", actor: "sweeper" },
  { from: "running", to: "failed", actor: "sweeper" },
  { from: "submitted", to: "failed", actor: "sweeper" },
] as const satisfies readonly ExternalTransition[];

const transitionKeys = new Set<string>(
  EXTERNAL_STATE_TRANSITIONS.map(({ from, to, actor }) => `${from}\u0000${to}\u0000${actor}`),
);

export function canExternalTransition(from: ExternalStateName, to: ExternalStateName, actor: ExternalStateActor): boolean {
  return transitionKeys.has(`${from}\u0000${to}\u0000${actor}`);
}

export function isExternalTerminalState(state: ExternalStateName): boolean {
  return EXTERNAL_STATES[state].terminal;
}

export function externalStateOf(input: Readonly<{
  status: string;
  lifecycleStatus: string | null;
  approvalRequired: boolean;
}>): ExternalStateName | null {
  if (input.lifecycleStatus === "cancel_requested") return "cancel_requested";
  if (input.lifecycleStatus === "cancelled") return "cancelled";
  if (input.lifecycleStatus === "completed" || input.status === "done") return "completed";
  if (input.status === "failed") return "failed";
  if (input.approvalRequired) return "approval_pending";
  if (input.lifecycleStatus === "submitted") return "submitted";
  if (input.status === "running") return "running";
  if (input.status === "queued") return "queued";
  if (input.lifecycleStatus === "created" && input.status === "pending") return "created";
  return null;
}
