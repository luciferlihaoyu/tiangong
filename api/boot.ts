import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { HttpBindings } from "@hono/node-server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "./router";
import { createContext } from "./middleware";
import { createMcpApp } from "./mcp/transport";
import { env } from "./lib/env";

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

app.all("/api/*", (c) => c.json({ error: "Not Found" }, 404));

export default app;

if (env.isProduction) {
  const { serve } = await import("@hono/node-server");
  const { serveStaticFiles } = await import("./lib/vite");
  serveStaticFiles(app);

  // Auto-create tables on startup
  if (env.databaseUrl) {
    try {
      const { getDb } = await import("./queries/connection");
      const db = getDb();
      // Use drizzle-kit push programmatically — or just test connection
      await db.execute("SELECT 1");
      console.log("Database connected successfully");
    } catch (e: any) {
      console.warn("Database connection failed:", e.message);
    }
  }

  const port = parseInt(process.env.PORT || "3000");
  serve({ fetch: app.fetch, port }, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });
}
