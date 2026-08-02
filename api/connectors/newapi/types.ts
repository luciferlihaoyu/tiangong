import { z } from "zod";

const stringDefaultSchema = z.preprocess((value) => {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}, z.string().default("")).catch("");

const numberDefaultSchema = z.coerce.number().catch(0).default(0);
const integerDefaultSchema = z.coerce.number().int().catch(0).default(0);

const booleanDefaultSchema = z.preprocess((value) => {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") {
      return true;
    }
    if (value.toLowerCase() === "false") {
      return false;
    }
  }
  return undefined;
}, z.boolean().default(false)).catch(false);

export const listAvailableModelsInputSchema = z.object({
  agentId: z.string().min(1).max(100).optional(),
  taskType: z.string().min(1).max(100).optional(),
}).default({});

export const availableModelSchema = z.object({
  id: stringDefaultSchema,
  name: stringDefaultSchema,
  provider: stringDefaultSchema,
  group: stringDefaultSchema,
  enabled: booleanDefaultSchema,
});

export const listAvailableModelsOutputSchema = z.array(availableModelSchema).catch([]).default([]);

export const modelChannelSchema = z.object({
  id: stringDefaultSchema,
  name: stringDefaultSchema,
  status: stringDefaultSchema,
  weight: numberDefaultSchema,
});

export const listModelChannelsOutputSchema = z.array(modelChannelSchema).catch([]).default([]);

export const getUsageSummaryInputSchema = z.object({
  agentId: z.string().min(1).max(100).optional(),
  model: z.string().min(1).max(100).optional(),
  from: z.string().min(1).max(100).optional(),
  to: z.string().min(1).max(100).optional(),
}).default({});

export const usageSummaryByModelSchema = z.object({
  model: stringDefaultSchema,
  totalTokens: integerDefaultSchema,
  promptTokens: integerDefaultSchema,
  completionTokens: integerDefaultSchema,
  callCount: integerDefaultSchema,
  costCents: numberDefaultSchema,
});

export const getUsageSummaryOutputSchema = z.object({
  totalTokens: integerDefaultSchema,
  promptTokens: integerDefaultSchema,
  completionTokens: integerDefaultSchema,
  callCount: integerDefaultSchema,
  costCents: numberDefaultSchema,
  byModel: z.array(usageSummaryByModelSchema).catch([]).default([]),
});

export const channelHealthSchema = z.object({
  channelId: stringDefaultSchema,
  status: stringDefaultSchema,
  failureRate: numberDefaultSchema,
  latencyMs: numberDefaultSchema,
});

export const getChannelHealthOutputSchema = z.array(channelHealthSchema).catch([]).default([]);

export const getModelPolicyInputSchema = z.object({
  agentId: z.string().min(1).max(100),
});

export const getModelPolicyOutputSchema = z.object({
  agentId: stringDefaultSchema,
  modelPolicyRef: stringDefaultSchema,
  allowedModels: z.array(stringDefaultSchema).catch([]).default([]),
  defaultModel: stringDefaultSchema,
  fallbackModels: z.array(stringDefaultSchema).catch([]).default([]),
  monthlyBudgetCents: integerDefaultSchema,
  rpmLimit: integerDefaultSchema,
  tpmLimit: integerDefaultSchema,
});

export type ListAvailableModelsInput = z.infer<typeof listAvailableModelsInputSchema>;
export type ListAvailableModelsOutput = z.infer<typeof listAvailableModelsOutputSchema>;
export type ListModelChannelsOutput = z.infer<typeof listModelChannelsOutputSchema>;
export type GetUsageSummaryInput = z.infer<typeof getUsageSummaryInputSchema>;
export type GetUsageSummaryOutput = z.infer<typeof getUsageSummaryOutputSchema>;
export type GetChannelHealthOutput = z.infer<typeof getChannelHealthOutputSchema>;
export type GetModelPolicyInput = z.infer<typeof getModelPolicyInputSchema>;
export type GetModelPolicyOutput = z.infer<typeof getModelPolicyOutputSchema>;
