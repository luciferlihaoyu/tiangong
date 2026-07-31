import { describe, expect, it } from "vitest";

import { TaskMetadataSchema } from "../../api/contracts/platform";
import {
  assertTaskType,
  createTaskMetadata,
  createTraceId,
  getArtifactRefs,
  getKnowledgeRefs,
  mergeTaskMetadata,
  parseTaskMetadata,
} from "../../api/lib/task-metadata";

describe("Task metadata", () => {
  it("merges metadata without dropping existing references when routing changes", () => {
    // Given
    const existingMetadata = createTaskMetadata({
      traceId: "trc_existing_00000001",
      taskType: "research_task",
      origin: {
        system: "openclaw",
        channel: "feishu",
        conversationRef: "feishu:chat:message",
      },
      routing: {
        selectedAgentId: "openclaw:research",
        reasonCode: "keyword:research",
      },
      policies: {
        modelPolicyRef: "newapi-policy:research",
        knowledgePolicyRef: "xuanji-policy:project-read",
      },
      knowledgeRefs: [
        {
          source: "xuanji",
          ref: "xuanji:doc:1",
          title: "Architecture Notes",
        },
      ],
      artifactRefs: [
        {
          storage: "tos",
          ref: "tos://bucket/report.md",
          artifactType: "document",
        },
      ],
    });
    const rawInput = JSON.stringify({ metadata: existingMetadata, payload: { goal: "audit" } });

    // When
    const mergedInput = mergeTaskMetadata(rawInput, {
      taskType: "coding_task",
      routing: {
        selectedAgentId: "opencode:main",
        reasonCode: "keyword:coding",
      },
      policies: {
        approvalPolicyRef: "approval:github-write",
      },
    });
    const metadata = parseTaskMetadata(mergedInput);

    // Then
    expect(metadata).toMatchObject({
      traceId: "trc_existing_00000001",
      taskType: "coding_task",
      origin: { system: "openclaw", channel: "feishu" },
      routing: { selectedAgentId: "opencode:main", reasonCode: "keyword:coding" },
      policies: {
        modelPolicyRef: "newapi-policy:research",
        knowledgePolicyRef: "xuanji-policy:project-read",
        approvalPolicyRef: "approval:github-write",
      },
    });
    expect(getKnowledgeRefs(mergedInput)).toHaveLength(1);
    expect(getArtifactRefs(mergedInput)).toHaveLength(1);
  });

  it("creates schema-valid metadata when a trace is generated", () => {
    // Given
    const traceId = createTraceId({
      timestamp: new Date("2026-07-31T00:00:00.000Z"),
      entropy: "abcdef12",
    });

    // When
    const metadata = createTaskMetadata({
      traceId,
      taskType: "triage_task",
      origin: { system: "system" },
    });

    // Then
    expect(traceId).toMatch(/^trc_[0-9a-z]+_[0-9a-z]{8}$/);
    expect(TaskMetadataSchema.parse(metadata)).toEqual(metadata);
    expect(metadata.knowledgeRefs).toEqual([]);
    expect(metadata.artifactRefs).toEqual([]);
  });

  it("preserves raw task input as payload when metadata is attached", () => {
    // Given
    const rawInput = "plain task request";

    // When
    const mergedInput = mergeTaskMetadata(rawInput, {
      traceId: "trc_plain_00000001",
      taskType: "triage_task",
      origin: { system: "human", channel: "dashboard" },
    });
    const metadata = parseTaskMetadata(mergedInput);

    // Then
    expect(metadata?.traceId).toBe("trc_plain_00000001");
    expect(mergedInput).toContain("plain task request");
  });

  it("accepts only registered task types when asserting task type boundaries", () => {
    // Given
    const validTaskType = "coding_task";
    const invalidTaskType = "invalid_task";

    // When
    const taskType = assertTaskType(validTaskType);

    // Then
    expect(taskType).toBe("coding_task");
    expect(() => assertTaskType(invalidTaskType)).toThrow();
  });
});
