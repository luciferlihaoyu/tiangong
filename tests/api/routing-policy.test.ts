import { describe, expect, it } from "vitest";

import { triageTask } from "../../api/lib/manager-agent";
import { decideTaskRoute } from "../../api/lib/routing-policy";

const routeCases = [
  {
    name: "coding",
    goal: "Fix a TypeScript bug and add unit tests",
    taskType: "coding_task",
    selectedAgentId: "opencode:main",
  },
  {
    name: "research",
    goal: "调研 Zeabur pricing and analyze tradeoffs",
    taskType: "research_task",
    selectedAgentId: "openclaw:research",
  },
  {
    name: "writing",
    goal: "润色公告并总结要点",
    taskType: "writing_task",
    selectedAgentId: "openclaw:writing",
  },
  {
    name: "image media",
    goal: "生成一张 logo 海报",
    taskType: "media_task",
    selectedAgentId: "openclaw:media-image",
  },
  {
    name: "video media",
    goal: "制作视频分镜脚本",
    taskType: "media_task",
    selectedAgentId: "openclaw:media-video",
  },
  {
    name: "knowledge",
    goal: "导入知识库并检索资料",
    taskType: "knowledge_task",
    selectedAgentId: "tiangong:xuanji-connector",
  },
] as const;

describe("Routing policy", () => {
  it.each(routeCases)("routes $name inputs deterministically", (routeCase) => {
    // Given
    const input = { goal: routeCase.goal };

    // When
    const route = decideTaskRoute(input);

    // Then
    expect(route.taskType).toBe(routeCase.taskType);
    expect(route.selectedAgentId).toBe(routeCase.selectedAgentId);
    expect(route.approvalRequired).toBe(false);
    expect(route.riskTypes).toEqual([]);
  });

  it("routes high-risk delivery inputs to approval before execution", () => {
    // Given
    const input = { goal: "Push the code and deploy the Zeabur service" };

    // When
    const route = decideTaskRoute(input);

    // Then
    expect(route.taskType).toBe("approval_task");
    expect(route.selectedAgentId).toBe("human:admin");
    expect(route.approvalRequired).toBe(true);
    expect(route.riskTypes).toEqual(["github_push", "zeabur_deploy"]);
  });

  it("returns manager triage with route and subtask suggestions for mixed goals", () => {
    // Given
    const input = { goal: "Implement the feature, add tests, and summarize the release notes" };

    // When
    const triage = triageTask(input);

    // Then
    expect(triage.route.taskType).toBe("coding_task");
    expect(triage.route.selectedAgentId).toBe("opencode:main");
    expect(triage.suggestedTasks.length).toBeGreaterThanOrEqual(2);
    expect(triage.suggestedTasks.map((task) => task.taskType)).toContain("writing_task");
  });
});
