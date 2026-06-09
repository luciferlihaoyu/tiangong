import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { serve } from "@hono/node-server";
import type { HttpBindings } from "@hono/node-server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "./router";
import { createContext } from "./middleware";
import { createMcpApp } from "./mcp/transport";
import { env } from "./lib/env";
import { autoMigrate } from "./lib/auto-migrate";
import { migrateV2 } from "./lib/migrate-v2";
import { serveStaticFiles } from "./lib/vite";

const app = new Hono<{ Bindings: HttpBindings }>();

app.use(bodyLimit({ maxSize: 50 * 1024 * 1024 }));

// MCP HTTP Routes (before tRPC to avoid wildcard conflicts)
app.route("/mcp", createMcpApp());

// tRPC handler
app.use("/api/trpc/*", async (c) => {
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req: c.req.raw,
    router: appRouter,
    createContext: ({ req }) => createContext({ req }),
  });
});

// Admin migration endpoint
app.get("/api/admin/migrate", async (c) => {
  const force = c.req.query("force") === "1";
  const results: string[] = [];
  results.push(`DATABASE_URL: ${env.databaseUrl ? "SET (" + env.databaseUrl.substring(0, 20) + "...)" : "NOT SET"}`);
  results.push(`force: ${force}`);
  const amLogs = await autoMigrate(force);
  results.push(...amLogs);
  const mvLogs = await migrateV2(force);
  results.push(...mvLogs);
  return c.json({ ok: true, results });
});

app.all("/api/*", (c) => c.json({ error: "Not Found" }, 404));

export default app;

if (env.isProduction) {
  serveStaticFiles(app);

  // Auto-create tables on startup
  try {
    await autoMigrate();
  } catch (e: any) {
    console.warn("Auto-migration failed:", e.message);
  }

  // V2 migration — add new columns to existing tables
  try {
    await migrateV2();
  } catch (e: any) {
    console.warn("V2 migration failed:", e.message);
  }

  const port = parseInt(process.env.PORT || "3000");
  serve({ fetch: app.fetch, port }, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });
}
