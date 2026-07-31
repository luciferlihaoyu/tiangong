import { z } from "zod";

import { RoutingInputSchema, decideTaskRoute, findRoutingCandidates } from "./routing-policy";
import type { RoutingDecision, RoutingInput } from "./routing-policy";
import type { TaskType } from "../contracts/platform";

const ManagerTriageInputSchema = RoutingInputSchema;

export type SuggestedTask = Readonly<{
  sequence: number;
  taskType: TaskType;
  selectedAgentId: string;
  routingReasonCode: string;
}>;

export type ManagerTriage = Readonly<{
  route: RoutingDecision;
  suggestedTasks: readonly SuggestedTask[];
}>;

export function triageTask(input: RoutingInput): ManagerTriage {
  const parsed = ManagerTriageInputSchema.parse(input);
  const route = decideTaskRoute(parsed);
  const candidates = findRoutingCandidates(parsed);
  const suggestedTasks = candidates.map((candidate, index) => ({
    sequence: index + 1,
    taskType: candidate.taskType,
    selectedAgentId: candidate.selectedAgentId,
    routingReasonCode: candidate.reasonCode,
  }));

  if (route.approvalRequired) {
    return {
      route,
      suggestedTasks: [
        {
          sequence: 1,
          taskType: "approval_task",
          selectedAgentId: "human:admin",
          routingReasonCode: route.reasonCode,
        },
        ...suggestedTasks.map((task) => ({ ...task, sequence: task.sequence + 1 })),
      ],
    };
  }

  return { route, suggestedTasks };
}

export const ManagerTriageSchema = z.object({
  route: z.object({
    taskType: z.string(),
    selectedAgentId: z.string(),
    reasonCode: z.string(),
    approvalRequired: z.boolean(),
    riskTypes: z.array(z.string()),
  }),
  suggestedTasks: z.array(
    z.object({
      sequence: z.number().int().min(1),
      taskType: z.string(),
      selectedAgentId: z.string(),
      routingReasonCode: z.string(),
    })
  ),
});
