import { z } from "zod";

import { type ApprovalRiskType, type TaskType } from "../contracts/platform";
import { evaluateApproval } from "./approval-policy";

export const RoutingInputSchema = z.object({
  goal: z.string().min(1).max(4000),
  title: z.string().min(1).max(255).optional(),
  description: z.string().min(1).max(4000).optional(),
});

export type RoutingInput = Readonly<z.infer<typeof RoutingInputSchema>>;
export type RoutingCandidate = Readonly<{
  taskType: TaskType;
  selectedAgentId: string;
  reasonCode: string;
}>;
export type RoutingDecision = RoutingCandidate &
  Readonly<{
    approvalRequired: boolean;
    riskTypes: readonly ApprovalRiskType[];
  }>;

type KeywordRoute = RoutingCandidate & Readonly<{ keywords: readonly string[] }>;

const fallbackRoute: RoutingCandidate = {
  taskType: "triage_task",
  selectedAgentId: "tiangong-manager",
  reasonCode: "fallback:triage",
};

const keywordRoutes: readonly KeywordRoute[] = [
  {
    taskType: "coding_task",
    selectedAgentId: "opencode:main",
    reasonCode: "keyword:coding",
    keywords: ["code", "coding", "bug", "test", "tests", "typescript", "开发", "实现", "代码", "测试", "部署"],
  },
  {
    taskType: "knowledge_task",
    selectedAgentId: "tiangong:xuanji-connector",
    reasonCode: "keyword:knowledge",
    keywords: ["knowledge", "import", "ingest", "retrieval", "search", "memory", "导入", "知识库", "检索", "沉淀"],
  },
  {
    taskType: "research_task",
    selectedAgentId: "openclaw:research",
    reasonCode: "keyword:research",
    keywords: ["research", "analyze", "analysis", "report", "资料", "调研", "分析", "报告"],
  },
  {
    taskType: "writing_task",
    selectedAgentId: "openclaw:writing",
    reasonCode: "keyword:writing",
    keywords: ["write", "copy", "summarize", "summary", "edit", "release notes", "文案", "总结", "润色", "公告"],
  },
  {
    taskType: "media_task",
    selectedAgentId: "openclaw:media-video",
    reasonCode: "keyword:media-video",
    keywords: ["video", "storyboard", "视频", "分镜"],
  },
  {
    taskType: "media_task",
    selectedAgentId: "openclaw:media-image",
    reasonCode: "keyword:media-image",
    keywords: ["image", "poster", "logo", "图片", "海报", "生图"],
  },
] as const;

export function decideTaskRoute(input: RoutingInput): RoutingDecision {
  const parsed = RoutingInputSchema.parse(input);
  const text = inputText(parsed);
  const approval = evaluateApproval({ action: text });

  if (approval.approvalRequired) {
    return {
      taskType: "approval_task",
      selectedAgentId: "human:admin",
      reasonCode: "risk:approval-required",
      approvalRequired: true,
      riskTypes: approval.riskTypes,
    };
  }

  const route = routingCandidatesForText(text)[0] ?? fallbackRoute;
  return { ...route, approvalRequired: false, riskTypes: [] };
}

export function findRoutingCandidates(input: RoutingInput): readonly RoutingCandidate[] {
  const parsed = RoutingInputSchema.parse(input);
  const candidates = routingCandidatesForText(inputText(parsed));
  return candidates.length > 0 ? candidates : [fallbackRoute];
}

function routingCandidatesForText(text: string): readonly RoutingCandidate[] {
  return keywordRoutes
    .filter((route) => route.keywords.some((keyword) => text.includes(keyword)))
    .map(({ taskType, selectedAgentId, reasonCode }) => ({ taskType, selectedAgentId, reasonCode }));
}

function inputText(input: RoutingInput): string {
  return [input.goal, input.title ?? "", input.description ?? ""].join(" ").toLowerCase();
}
