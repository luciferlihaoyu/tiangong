#!/usr/bin/env node
/**
 * Mailbox online smoke.
 * Usage:
 *   TIANGONG_BASE_URL=https://tiangg.zeabur.app node scripts/smoke/mailbox-online-smoke.mjs
 *
 * This intentionally writes one small test mailbox exchange.
 */

const baseUrl = (process.env.TIANGONG_BASE_URL || "https://tiangg.zeabur.app").replace(/\/$/, "");
const trpcBase = `${baseUrl}/api/trpc`;
const marker = `mailbox-online-smoke-${Date.now()}`;

let passed = 0;
let failed = 0;

function pass(name, detail = "") {
  passed++;
  console.log(`✅ ${name}${detail ? `: ${detail}` : ""}`);
}

function fail(name, detail = "") {
  failed++;
  console.log(`❌ ${name}${detail ? `: ${detail}` : ""}`);
}

async function trpcGet(path, input) {
  const res = await fetch(`${trpcBase}/${path}?input=${encodeURIComponent(JSON.stringify(input))}`);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    const error = new Error(`${path} HTTP ${res.status}: ${text}`);
    error.status = res.status;
    error.body = text;
    throw error;
  }
  return json.result?.data ?? json;
}

async function trpcPost(path, input) {
  const res = await fetch(`${trpcBase}/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    const error = new Error(`${path} HTTP ${res.status}: ${text}`);
    error.status = res.status;
    error.body = text;
    throw error;
  }
  return json.result?.data ?? json;
}

async function expectError(name, fn, expectedText) {
  try {
    await fn();
    fail(name, "expected error but succeeded");
  } catch (error) {
    if (!expectedText || String(error.body || error.message).includes(expectedText)) {
      pass(name);
    } else {
      fail(name, error.message);
    }
  }
}

try {
  const version = await fetch(`${baseUrl}/api/version?t=${Date.now()}`).then((res) => res.json());
  pass("version endpoint reachable", `${version.shortCommit || "unknown"} ${version.buildTime || ""}`.trim());

  const sent = await trpcPost("mailbox.send", {
    fromMailboxId: "meizhizi",
    toMailboxId: "codemaster",
    type: "direct",
    subject: marker,
    body: "Online Mailbox smoke test message.",
    payload: { marker, smoke: true },
  });
  if (!sent.messageId) throw new Error("send did not return messageId");
  pass("send returns messageId", String(sent.messageId));

  const inbox = await trpcGet("mailbox.inbox", { mailboxId: "codemaster", status: "unread", limit: 50 });
  const found = inbox.find((message) => message.id === sent.messageId || message.subject === marker);
  if (!found) throw new Error("sent message not found in target inbox");
  pass("inbox sees sent message", `id=${found.id}`);

  const messageId = found.id;
  const fetched = await trpcGet("mailbox.get", { messageId, mailboxId: "codemaster" });
  if (fetched.fromMailboxId !== "meizhizi" || fetched.toMailboxId !== "codemaster") {
    throw new Error(`unexpected participants: ${fetched.fromMailboxId} -> ${fetched.toMailboxId}`);
  }
  pass("get enforces participant access");

  const ack = await trpcPost("mailbox.ack", { messageId, mailboxId: "codemaster", note: "online smoke ack" });
  if (ack.status !== "acknowledged") throw new Error(`unexpected ack status ${ack.status}`);
  pass("ack transitions message", ack.status);

  const reply = await trpcPost("mailbox.reply", {
    messageId,
    fromMailboxId: "codemaster",
    body: "online smoke reply ok",
    payload: { marker, reply: true },
  });
  if (!reply.replyMessageId) throw new Error("reply did not return replyMessageId");
  pass("reply returns replyMessageId", String(reply.replyMessageId));

  const resolved = await trpcPost("mailbox.resolve", { messageId, mailboxId: "meizhizi", note: "online smoke resolved" });
  if (resolved.status !== "resolved") throw new Error(`unexpected resolve status ${resolved.status}`);
  pass("resolve transitions message", resolved.status);

  const finalMessage = await trpcGet("mailbox.get", { messageId, mailboxId: "meizhizi" });
  if (finalMessage.status !== "resolved" || !finalMessage.acknowledgedAt || !finalMessage.repliedAt || !finalMessage.resolvedAt) {
    throw new Error(`final state incomplete: ${JSON.stringify({ status: finalMessage.status, acknowledgedAt: finalMessage.acknowledgedAt, repliedAt: finalMessage.repliedAt, resolvedAt: finalMessage.resolvedAt })}`);
  }
  pass("final message has full timestamps");

  await expectError("unknown mailbox rejected", () => trpcGet("mailbox.inbox", { mailboxId: "__missing__", limit: 1 }), "Mailbox not found");
  await expectError("non-participant rejected", () => trpcGet("mailbox.get", { messageId, mailboxId: "yunxiao" }), "Mailbox is not a participant");
} catch (error) {
  fail("online smoke aborted", error.stack || error.message);
}

console.log(`\nMailbox online smoke: ${passed} passed / ${passed + failed} total`);
if (failed > 0) process.exit(1);
