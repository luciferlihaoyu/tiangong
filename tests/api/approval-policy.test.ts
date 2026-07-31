import { describe, expect, it } from "vitest";

import { createApprovalRequest, evaluateApproval } from "../../api/lib/approval-policy";

const highRiskCases = [
  { action: "github push main", riskType: "github_push" },
  { action: "merge pull request", riskType: "github_merge" },
  { action: "create github release", riskType: "github_release" },
  { action: "deploy zeabur service", riskType: "zeabur_deploy" },
  { action: "restart zeabur service", riskType: "zeabur_restart" },
  { action: "delete zeabur service", riskType: "zeabur_delete_service" },
  { action: "delete storage object", riskType: "storage_delete" },
  { action: "update New API channel budget", riskType: "newapi_write" },
  { action: "rotate MCP key", riskType: "mcp_key_change" },
  { action: "send external email", riskType: "external_send" },
  { action: "call webhook endpoint", riskType: "webhook_call" },
] as const;

describe("Approval policy", () => {
  it.each(highRiskCases)("requires approval for $riskType", (riskCase) => {
    // Given
    const input = { action: riskCase.action, target: "target:example" };

    // When
    const decision = evaluateApproval(input);

    // Then
    expect(decision.approvalRequired).toBe(true);
    expect(decision.riskTypes).toContain(riskCase.riskType);
    expect(decision.decision).toBe("requires_approval");
  });

  it("allows low-risk read actions without approval", () => {
    // Given
    const input = { action: "read task status", target: "task:TG-1" };

    // When
    const decision = evaluateApproval(input);

    // Then
    expect(decision.approvalRequired).toBe(false);
    expect(decision.riskTypes).toEqual([]);
    expect(decision.decision).toBe("allowed");
  });

  it("creates a pending approval request with immutable action coordinates", () => {
    // Given
    const input = {
      riskType: "github_push",
      requestedByTaskId: "TG-123456",
      requestedByAgentId: "opencode:main",
      target: "github:owner/repo#main",
      preview: "diff:sha256:abcdef",
    } as const;

    // When
    const request = createApprovalRequest(input);

    // Then
    expect(request).toEqual({ ...input, decision: "pending" });
  });
});
