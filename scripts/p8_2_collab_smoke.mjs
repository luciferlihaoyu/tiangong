#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";

const checks = [
  ["api/router.ts", /collab:\s*collaborationRouter/],
  ["api/collaboration-router.ts", /delegate:\s*publicQuery/],
  ["api/collaboration-router.ts", /status:\s*publicQuery/],
  ["api/collaboration-router.ts", /summary:\s*publicQuery/],
  ["api/collaboration-router.ts", /unblockReady:\s*publicQuery/],
  ["api/collaboration-router.ts", /idempotencyKey/],
  ["api/collaboration-router.ts", /correlationId/],
  ["TIANGONG_P8_2_COLLABORATION_ORCHESTRATION_SPEC.md", /collab\.delegate/],
  ["TIANGONG_P8_3_COLLABORATION_COMMAND_CENTER_SPEC.md", /collab_summary/],
  ["api/lib/collaboration-events.ts", /export\s+async\s+function\s+unblockReadyCollabTasks/],
  ["api/lib/collaboration-events.ts", /export\s+async\s+function\s+buildCollabSummary/],
  ["api/lib/collaboration-events.ts", /export\s+async\s+function\s+emitCollabSummaryForTask/],
  ["api/lib/collaboration-events.ts", /type:\s*"collab_summary"/],
  ["api/lib/collaboration-events.ts", /type:\s*"collab_unblocked"/],
  ["api/task-router.ts", /emitCollabSummaryForTask/],
  ["api/orchestration-router.ts", /emitCollabSummaryForTask/],
  ["api/lib/task-runner.ts", /emitCollabSummaryForTask/],
  ["src/pages/TaskCenter.tsx", /function CollaborationPanel/],
  ["src/pages/TaskCenter.tsx", /parseSubtaskLines/],
  ["src/pages/TaskCenter.tsx", /trpc\.collab\.delegate\.useMutation/],
  ["src/pages/TaskCenter.tsx", /trpc\.collab\.status\.useQuery/],
  ["src/pages/TaskCenter.tsx", /trpc\.collab\.summary\.useQuery/],
  ["src/pages/TaskCenter.tsx", /trpc\.collab\.unblockReady\.useMutation/],
  ["src/pages/TaskCenter.tsx", /collab_summary/],
  ["src/pages/TaskCenter.tsx", /collab_unblocked/],
  ["src/pages/TaskCenter.tsx", /collab_delegation_message/],
];

let failed = false;
for (const [file, pattern] of checks) {
  if (!existsSync(file)) {
    console.error(`missing: ${file}`);
    failed = true;
    continue;
  }
  const content = readFileSync(file, "utf8");
  if (!pattern.test(content)) {
    console.error(`pattern not found in ${file}: ${pattern}`);
    failed = true;
  } else {
    console.log(`ok: ${file} ${pattern}`);
  }
}

if (failed) process.exit(1);
console.log("P8 collaboration smoke checks passed");
