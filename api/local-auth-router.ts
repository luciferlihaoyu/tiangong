import { z } from "zod";
import { createRouter, publicQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { users } from "@db/schema";
import { eq } from "drizzle-orm";
import { SignJWT, jwtVerify } from "jose";
import { hashPassword, verifyPassword } from "./lib/password";

// JWT secret from APP_SECRET env
const SECRET = new TextEncoder().encode(
  process.env.APP_SECRET || "tiangong-default-secret-key-change-me"
);

async function createToken(userId: number, role: string): Promise<string> {
  return new SignJWT({ sub: String(userId), role })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(SECRET);
}

export async function verifyToken(token: string) {
  try {
    const { payload } = await jwtVerify(token, SECRET, { clockTolerance: 60 });
    return payload as { sub: string; role: string };
  } catch {
    return null;
  }
}

// Get admin credentials from env
function getAdminCreds() {
  return {
    username: process.env.ADMIN_USER || "admin",
    password: process.env.ADMIN_PASSWORD || "admin",
  };
}

export const localAuthRouter = createRouter({
  // Login with username + password
  login: publicQuery
    .input(
      z.object({
        username: z.string().min(1).max(50),
        password: z.string().min(1).max(100),
      })
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const { username, password } = input;

      // Check against env admin credentials first
      const adminCreds = getAdminCreds();
      if (username === adminCreds.username && password === adminCreds.password) {
        // Find or create admin user in DB
        let user = await db.select().from(users).where(eq(users.username, username)).then(rows => rows[0]);
        if (!user) {
          const hashed = await hashPassword(password);
          await db.insert(users).values({
            username,
            passwordHash: hashed,
            name: "管理员",
            role: "admin",
          });
          user = await db.select().from(users).where(eq(users.username, username)).then(rows => rows[0]);
        }
        if (!user) return { success: false, error: "创建用户失败" };

        // Update last sign in
        await db.update(users).set({ lastSignInAt: new Date() }).where(eq(users.id, user.id));

        const token = await createToken(user.id, user.role);
        return { success: true, token, user: { id: user.id, name: user.name || user.username, role: user.role } };
      }

      // Check database users
      const user = await db.select().from(users).where(eq(users.username, username)).then(rows => rows[0]);
      if (!user) return { success: false, error: "用户名或密码错误" };

      const valid = await verifyPassword(password, user.passwordHash);
      if (!valid) return { success: false, error: "用户名或密码错误" };

      await db.update(users).set({ lastSignInAt: new Date() }).where(eq(users.id, user.id));

      const token = await createToken(user.id, user.role);
      return { success: true, token, user: { id: user.id, name: user.name || user.username, role: user.role } };
    }),

  // Register new user (admin only can register)
  register: publicQuery
    .input(
      z.object({
        username: z.string().min(3).max(50),
        password: z.string().min(4).max(100),
        name: z.string().optional(),
        role: z.enum(["user", "admin"]).default("user"),
      })
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const existing = await db.select().from(users).where(eq(users.username, input.username)).then(rows => rows[0]);
      if (existing) return { success: false, error: "用户名已存在" };

      const hashed = await hashPassword(input.password);
      await db.insert(users).values({
        username: input.username,
        passwordHash: hashed,
        name: input.name || input.username,
        role: input.role,
      });
      return { success: true };
    }),

  // Get current user from token
  me: publicQuery.query(async ({ ctx }) => {
    const authHeader = ctx.req.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) return null;

    const token = authHeader.slice(7);
    const payload = await verifyToken(token);
    if (!payload) return null;

    const db = getDb();
    const user = await db.select().from(users).where(eq(users.id, Number(payload.sub))).then(rows => rows[0]);
    if (!user) return null;

    return {
      id: user.id,
      username: user.username,
      name: user.name || user.username,
      role: user.role,
    };
  }),

  // List all users (admin)
  list: publicQuery.query(async () => {
    const db = getDb();
    return db.select({
      id: users.id,
      username: users.username,
      name: users.name,
      role: users.role,
      createdAt: users.createdAt,
      lastSignInAt: users.lastSignInAt,
    }).from(users);
  }),

  // Change password
  changePassword: publicQuery
    .input(z.object({
      oldPassword: z.string(),
      newPassword: z.string().min(4),
    }))
    .mutation(async ({ input, ctx }) => {
      const authHeader = ctx.req.headers.get("authorization");
      if (!authHeader?.startsWith("Bearer ")) return { success: false, error: "未登录" };

      const payload = await verifyToken(authHeader.slice(7));
      if (!payload) return { success: false, error: "登录已过期" };

      const db = getDb();
      const user = await db.select().from(users).where(eq(users.id, Number(payload.sub))).then(rows => rows[0]);
      if (!user) return { success: false, error: "用户不存在" };

      const valid = await verifyPassword(input.oldPassword, user.passwordHash);
      if (!valid) return { success: false, error: "原密码错误" };

      const hashed = await hashPassword(input.newPassword);
      await db.update(users).set({ passwordHash: hashed }).where(eq(users.id, user.id));
      return { success: true };
    }),

  // Logout (client-side only, but we keep this for consistency)
  logout: publicQuery.mutation(() => {
    return { success: true };
  }),
});
