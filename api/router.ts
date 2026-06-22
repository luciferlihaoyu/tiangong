import { localAuthRouter } from "./local-auth-router";
import { agentRouter } from "./agent-router";
import { taskRouter } from "./task-router";
import { messageRouter } from "./message-router";
import { systemRouter } from "./system-router";
import { orgRouter } from "./org-router";
import { orchestrationRouter } from "./orchestration-router";
import { mcpRouter } from "./mcp/mcp-router";
import { conversationRouter } from "./conversation-router";
import { collaborationRouter } from "./collaboration-router";
import { usageRouter } from "./usage-router";
import { pricingRouter } from "./pricing-router";
import { guardRouter } from "./guard-router";
import { opsRouter } from "./ops-router";
import { fusionRouter } from "./fusion-router";
import { planRouter } from "./plan-router";
import { githubRouter } from "./github-router";
import { a2aRouter } from "./a2a-router";
import { mailboxRouter } from "./mailbox-router";
import { taskboardRouter } from "./taskboard-router";
import { createRouter, publicQuery } from "./middleware";

export const appRouter = createRouter({
  ping: publicQuery.query(() => ({ ok: true, ts: Date.now() })),
  auth: localAuthRouter,
  agent: agentRouter,
  task: taskRouter,
  message: messageRouter,
  system: systemRouter,
  org: orgRouter,
  orch: orchestrationRouter,
  mcp: mcpRouter,
  conversation: conversationRouter,
  collab: collaborationRouter,
  usage: usageRouter,
  pricing: pricingRouter,
  guard: guardRouter,
  ops: opsRouter,
  fusion: fusionRouter,
  plan: planRouter,
  github: githubRouter,
  a2a: a2aRouter,
  mailbox: mailboxRouter,
  taskboard: taskboardRouter,
});

export type AppRouter = typeof appRouter;
