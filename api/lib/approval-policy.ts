import { z } from "zod";

import {
  ApprovalRequestSchema,
  type ApprovalRequest,
  type ApprovalRiskType,
} from "../contracts/platform";

const ApprovalPolicyInputSchema = z.object({
  action: z.string().min(1).max(2000),
  target: z.string().min(1).max(500).optional(),
  preview: z.string().min(1).max(5000).optional(),
});

const ApprovalRequestCreateSchema = ApprovalRequestSchema.omit({ decision: true });

type ApprovalPolicyInput = Readonly<z.infer<typeof ApprovalPolicyInputSchema>>;
type ApprovalRequestCreate = Readonly<z.infer<typeof ApprovalRequestCreateSchema>>;
type ApprovalDecision = Readonly<{
  approvalRequired: boolean;
  riskTypes: readonly ApprovalRiskType[];
  decision: "allowed" | "requires_approval";
}>;

type ApprovalRule = Readonly<{
  riskType: ApprovalRiskType;
  matches: (text: string) => boolean;
}>;

const approvalRules: readonly ApprovalRule[] = [
  { riskType: "github_push", matches: (text) => containsAny(text, ["git push", "github push", "push code", "push the code"]) },
  { riskType: "github_merge", matches: (text) => containsAny(text, ["github merge", "merge pull request", "merge pr", "合并 pr", "合并 pull request"]) },
  { riskType: "github_release", matches: (text) => containsAny(text, ["github release", "create release", "publish release", "release tag"]) },
  { riskType: "zeabur_deploy", matches: (text) => containsAll(text, ["zeabur"], ["deploy", "部署", "上线"]) },
  { riskType: "zeabur_restart", matches: (text) => containsAll(text, ["zeabur"], ["restart", "reboot", "重启"]) },
  { riskType: "zeabur_delete_service", matches: (text) => containsAll(text, ["zeabur"], ["delete", "remove", "destroy", "删除"]) },
  { riskType: "storage_delete", matches: (text) => containsAll(text, ["storage", "s3", "tos", "r2", "alist", "object"], ["delete", "remove", "删除"]) },
  { riskType: "newapi_write", matches: (text) => containsAll(text, ["new api", "newapi"], ["write", "update", "create", "delete", "disable", "set", "assign", "budget", "token", "channel"]) },
  { riskType: "mcp_key_change", matches: (text) => containsAll(text, ["mcp"], ["key", "token", "rotate", "change", "update", "delete", "revoke", "create"]) },
  { riskType: "external_send", matches: (text) => containsAny(text, ["send external", "external message", "external email", "send email", "send mail", "发送外部"]) },
  { riskType: "webhook_call", matches: (text) => containsAll(text, ["webhook"], ["call", "trigger", "send", "post", "调用", "触发"]) },
] as const;

export function evaluateApproval(input: ApprovalPolicyInput): ApprovalDecision {
  const parsed = ApprovalPolicyInputSchema.parse(input);
  const text = normalize([parsed.action, parsed.target ?? "", parsed.preview ?? ""].join(" "));
  const riskTypes = approvalRules.filter((rule) => rule.matches(text)).map((rule) => rule.riskType);

  if (riskTypes.length === 0) {
    return { approvalRequired: false, riskTypes: [], decision: "allowed" };
  }

  return { approvalRequired: true, riskTypes, decision: "requires_approval" };
}

export function createApprovalRequest(input: ApprovalRequestCreate): ApprovalRequest {
  const request = ApprovalRequestCreateSchema.parse(input);
  return ApprovalRequestSchema.parse({ ...request, decision: "pending" });
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function containsAny(text: string, terms: readonly string[]): boolean {
  return terms.some((term) => text.includes(term));
}

function containsAll(text: string, requiredGroups: readonly string[], actionTerms: readonly string[]): boolean {
  return requiredGroups.some((term) => text.includes(term)) && actionTerms.some((term) => text.includes(term));
}
