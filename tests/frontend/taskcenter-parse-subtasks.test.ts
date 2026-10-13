import { describe, expect, it } from "vitest";
import { parseSubtaskLines } from "../../src/components/taskcenter/CollaborationPanel";

/**
 * parseSubtaskLines 表征测试（行为保持重构钉子）。
 * 用例依据实现现状编写（src/components/taskcenter/CollaborationPanel.tsx）：
 *   text.split("\n") → 每行 trim → filter(Boolean) 丢空行 → 按 "|" 切分并逐段 trim。
 *   - title    = 第一段（可为空串）
 *   - assigneeAgentId = Number(第二段)：段缺失 → NaN；空串 → Number("") === 0
 *   - priority = 第三段非空才 Number，否则 0
 *   - description = 余段以 "|" 重新 join，空串则 undefined
 */
describe("parseSubtaskLines（协作子任务草稿解析）", () => {
  it("完整行：标题 | AgentID | 优先级 | 描述", () => {
    expect(parseSubtaskLines("调研方案 | 12 | 3 | 收集背景和约束")).toEqual([
      { title: "调研方案", assigneeAgentId: 12, priority: 3, description: "收集背景和约束" },
    ]);
  });

  it("多行：跳过空行、容忍首尾空白；缺优先级段时 priority=0 且 description=undefined", () => {
    expect(parseSubtaskLines("\n  任务A | 1 | 4 | 描述A  \n\n任务B | 2\n")).toEqual([
      { title: "任务A", assigneeAgentId: 1, priority: 4, description: "描述A" },
      { title: "任务B", assigneeAgentId: 2, priority: 0, description: undefined },
    ]);
  });

  it("无竖线：title 为整行，第二段缺失 → assigneeAgentId 为 NaN", () => {
    expect(parseSubtaskLines("只写了标题")).toEqual([
      { title: "只写了标题", assigneeAgentId: NaN, priority: 0, description: undefined },
    ]);
  });

  it("Agent 段为空串：Number(\"\") === 0（由 handleDelegate 的 !assigneeAgentId 守卫兜住）", () => {
    expect(parseSubtaskLines("标题 | | 2")).toEqual([
      { title: "标题", assigneeAgentId: 0, priority: 2, description: undefined },
    ]);
  });

  it("描述本身含竖线：余段以 \"|\" 无空格重新拼接回 description", () => {
    expect(parseSubtaskLines("标题 | 7 | 1 | 部分1 | 部分2")).toEqual([
      { title: "标题", assigneeAgentId: 7, priority: 1, description: "部分1|部分2" },
    ]);
  });
});
