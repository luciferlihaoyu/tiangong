#!/usr/bin/env node
/**
 * Mailbox static smoke.
 * Verifies the minimal contract without touching production DB.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "../..");

let passed = 0;
let failed = 0;

function check(name, ok, detail = "") {
  if (ok) {
    passed++;
    console.log(`✅ ${name}`);
  } else {
    failed++;
    console.log(`❌ ${name}`);
    if (detail) console.log(`   ${detail}`);
  }
}

const schema = readFileSync(resolve(root, "db/schema.ts"), "utf-8");
const router = readFileSync(resolve(root, "api/mailbox-router.ts"), "utf-8");
const appRouter = readFileSync(resolve(root, "api/router.ts"), "utf-8");

check("schema defines mailbox_messages", schema.includes("mailbox_messages"));
check("mailbox uses stable from/to mailbox ids", schema.includes("from_mailbox_id") && schema.includes("to_mailbox_id"));
check("mailbox id length matches agents.agentId", schema.includes('fromMailboxId: varchar("from_mailbox_id", { length: 20 })') && schema.includes('toMailboxId: varchar("to_mailbox_id", { length: 20 })'));
check("mailbox supports core message types", ["direct", "mention", "question", "review_request", "subtask", "handoff", "result_notice"].every((value) => schema.includes(`\"${value}\"`)));
check("mailbox supports lifecycle statuses", ["unread", "acknowledged", "working", "replied", "resolved", "failed"].every((value) => schema.includes(`\"${value}\"`)));
check("router resolves mailbox through agents.agentId", router.includes("eq(agents.agentId, normalized)") && router.includes("resolveMailbox"));
check("router rejects unknown mailbox", router.includes("Mailbox not found"));
check("router does not route by displayName", !router.includes("displayName") && !router.includes("agents.name"));
check("router has send/inbox/get/ack/reply/resolve", ["send:", "inbox:", "get:", "ack:", "reply:", "resolve:"].every((value) => router.includes(value)));
check("router has v0.2 mention/subtask/handoff endpoints", ["mention:", "createSubtask:", "handoff:"].every((value) => router.includes(value)));
check("ack requires recipient mailbox", router.includes("assertRecipient") && router.includes("Mailbox is not the recipient"));
check("get/resolve enforce participant access", router.includes("assertParticipant") && router.includes("Mailbox is not a participant"));
check("reply creates reverse message", router.includes("replyToMessageId: message.id") && router.includes("toMailboxId: toAgent.agentId"));
check("task-linked operations write taskMessages audit", router.includes("recordMailboxEvent") && router.includes("taskMessages") && router.includes('channel: "mailbox"'));
check("subtask creates child task and mailbox message", router.includes("parentTaskId") && router.includes("subtask_created") && router.includes("childTaskKey"));
check("handoff reassigns task and records dispatch", router.includes("Only the current task assignee can hand off") && router.includes("lifecycleStatus: \"dispatched\"") && router.includes("previousAgentId"));
check("mention requires a real task", router.includes("Mention:") && router.includes("Task not found"));
check("router broadcasts mailbox events", router.includes("mailbox_message_sent") && router.includes("mailbox_message_replied"));
check("app router registers mailbox", appRouter.includes("mailboxRouter") && appRouter.includes("mailbox:"));

console.log(`\nMailbox static smoke: ${passed} passed / ${passed + failed} total`);
if (failed > 0) process.exit(1);
