import { initTRPC } from "@trpc/server";
import { verifyToken } from "./local-auth-router";

// Context for each request
export async function createContext(opts: { req: Request }) {
  let user: { id: number; role: string } | null = null;

  // Try to get user from Bearer token
  const authHeader = opts.req.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const payload = await verifyToken(authHeader.slice(7));
    if (payload) {
      user = { id: Number(payload.sub), role: payload.role };
    }
  }

  return { req: opts.req, user };
}

type Context = Awaited<ReturnType<typeof createContext>>;

const t = initTRPC.context<Context>().create();

export const router = t.router;
export const createRouter = router;
export const publicProcedure = t.procedure;

// Public query - no auth required
export const publicQuery = publicProcedure;

// Authed query - requires login
export const authedQuery = publicProcedure.use(async ({ ctx, next }) => {
  if (!ctx.user) {
    throw new Error("请先登录");
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});

// Admin query - requires admin role
export const adminQuery = publicProcedure.use(async ({ ctx, next }) => {
  if (!ctx.user) {
    throw new Error("请先登录");
  }
  if (ctx.user.role !== "admin") {
    throw new Error("需要管理员权限");
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});
