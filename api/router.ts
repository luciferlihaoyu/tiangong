import { localAuthRouter } from "./local-auth-router";
import { agentRouter } from "./agent-router";
import { taskRouter } from "./task-router";
import { messageRouter } from "./message-router";
import { systemRouter } from "./system-router";
import { orgRouter } from "./org-router";
import { orchestrationRouter } from "./orchestration-router";
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
});

export type AppRouter = typeof appRouter;
