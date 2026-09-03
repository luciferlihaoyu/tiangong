import { describe, expect, it } from "vitest";

import { isAgentAllowedByRouting } from "../../api/lib/task-claim";
import { createTaskMetadata } from "../../api/lib/task-metadata";
/** 构造带完整 metadata 的 envelope（对齐 createTaskMetadata 输出，否则 TaskMetadataSchema 全必填解析失败） */
function envelopeWithRouting(patch: { selectedAgentId?: string; candidateAgentIds?: string[] }) {
  const full = createTaskMetadata({ routing: patch });
  return JSON.stringify({ payload: "任务载荷", metadata: full });
}

import { applyRequestedAgentToInput, parseTaskMetadata } from "../../api/lib/task-metadata";

/**
 * P-claim-routing 认领归属保护测试：
 * 用户指定"让 dsh 做"的任务（通用任务 + routing.selectedAgentId=dsh），
 * 不得被其他空闲 agent（如美成子）认领。
 */
describe("isAgentAllowedByRouting（认领归属保护）", () => {
  it("无 input / 无 metadata → 通用任务，任何 agent 可认领", () => {
    expect(isAgentAllowedByRouting(null, "meichengzi")).toBe(true);
    expect(isAgentAllowedByRouting("  ", "meichengzi")).toBe(true);
    expect(isAgentAllowedByRouting("plain text task", "meichengzi")).toBe(true);
  });

  it("声明 selectedAgentId=dsh → 仅 dsh 可认领，其他 agent 不可", () => {
    const input = envelopeWithRouting({ selectedAgentId: "dsh" });
    expect(isAgentAllowedByRouting(input, "dsh")).toBe(true);
    expect(isAgentAllowedByRouting(input, "meichengzi")).toBe(false);
    expect(isAgentAllowedByRouting(input, "nvwa")).toBe(false);
  });

  it("声明 candidateAgentIds → 候选列表内可认领，列表外不可", () => {
    const input = envelopeWithRouting({ candidateAgentIds: ["dsh", "opencode:main"] });
    expect(isAgentAllowedByRouting(input, "dsh")).toBe(true);
    expect(isAgentAllowedByRouting(input, "opencode:main")).toBe(true);
    expect(isAgentAllowedByRouting(input, "meichengzi")).toBe(false);
  });

  it("selectedAgentId 与 candidateAgentIds 同时声明 → 匹配任一即可", () => {
    const input = envelopeWithRouting({ selectedAgentId: "dsh", candidateAgentIds: ["nvwa"] });
    expect(isAgentAllowedByRouting(input, "dsh")).toBe(true);
    expect(isAgentAllowedByRouting(input, "nvwa")).toBe(true);
    expect(isAgentAllowedByRouting(input, "meichengzi")).toBe(false);
  });

  it("selectedAgentId 是虚拟池（human:admin）→ 对真实 agent 不可认领", () => {
    const input = envelopeWithRouting({ selectedAgentId: "human:admin" });
    expect(isAgentAllowedByRouting(input, "meichengzi")).toBe(false);
    expect(isAgentAllowedByRouting(input, "dsh")).toBe(false);
  });

  it("agent 无身份（null/undefined）→ 不拦截（防御）", () => {
    const input = envelopeWithRouting({ selectedAgentId: "dsh" });
    expect(isAgentAllowedByRouting(input, null)).toBe(true);
    expect(isAgentAllowedByRouting(input, undefined)).toBe(true);
  });
});

describe("applyRequestedAgentToInput（创建端归属声明）", () => {
  it("requestedAgentId 为空 → input 原样返回", () => {
    expect(applyRequestedAgentToInput("hello", undefined)).toBe("hello");
    expect(applyRequestedAgentToInput("hello", null)).toBe("hello");
    expect(applyRequestedAgentToInput("hello", "  ")).toBe("hello");
    expect(applyRequestedAgentToInput(null, undefined)).toBeNull();
  });

  it("input 为空 + 指定 dsh → 生成纯 metadata envelope", () => {
    const out = applyRequestedAgentToInput(null, "dsh");
    const metadata = parseTaskMetadata(out);
    expect(metadata?.routing.selectedAgentId).toBe("dsh");
  });

  it("input 为纯文本 + 指定 dsh → payload 保留 + metadata 附加", () => {
    const out = applyRequestedAgentToInput("检查天宫 GitHub", "dsh");
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!);
    expect(parsed.payload).toBe("检查天宫 GitHub");
    const metadata = parseTaskMetadata(out);
    expect(metadata?.routing.selectedAgentId).toBe("dsh");
  });

  it("input 已是 JSON 对象 + 指定 dsh → 原字段保留 + metadata 附加", () => {
    const out = applyRequestedAgentToInput(JSON.stringify({ url: "github.com" }), "dsh");
    const parsed = JSON.parse(out!);
    expect(parsed.url).toBe("github.com");
    const metadata = parseTaskMetadata(out);
    expect(metadata?.routing.selectedAgentId).toBe("dsh");
  });

  it("input 已带 metadata + 指定 dsh → 合并而非覆盖其它字段", () => {
    const existing = JSON.stringify({
      metadata: createTaskMetadata({ routing: { approvalRequired: true, riskTypes: ["github_push"] } }),
    });
    const out = applyRequestedAgentToInput(existing, "dsh");
    const metadata = parseTaskMetadata(out);
    expect(metadata?.routing.selectedAgentId).toBe("dsh");
    expect(metadata?.routing.approvalRequired).toBe(true);
  });
});

describe("安全边界（既有任务不被误拦的回归保护）", () => {
  it("input 是普通 JSON 对象（非 envelope）→ parse 返回 null → 通用放行", () => {
    const input = JSON.stringify({ url: "github.com/owner/repo", branch: "main" });
    expect(isAgentAllowedByRouting(input, "meichengzi")).toBe(true);
    expect(isAgentAllowedByRouting(input, "dsh")).toBe(true);
  });

  it("input 是半截 metadata（缺必填字段）→ parse 失败 → 通用放行", () => {
    const input = JSON.stringify({ metadata: { routing: { selectedAgentId: "dsh" } } });
    expect(isAgentAllowedByRouting(input, "meichengzi")).toBe(true);
  });

  it("input 是数组 → 通用放行", () => {
    expect(isAgentAllowedByRouting("[1,2,3]", "meichengzi")).toBe(true);
  });

  it("input 是空对象 → 通用放行", () => {
    expect(isAgentAllowedByRouting("{}", "meichengzi")).toBe(true);
  });

  it("input 非法 JSON 文本 → parseTaskMetadata 内部兜底 → 通用放行", () => {
    expect(isAgentAllowedByRouting("{broken json", "meichengzi")).toBe(true);
  });
});
