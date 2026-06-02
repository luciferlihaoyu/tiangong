import type { Hono } from "hono";
import type { HttpBindings } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

type App = Hono<{ Bindings: HttpBindings }>;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function serveStaticFiles(app: App) {
  // Resolve absolute path to the public directory
  // boot.js is at dist/boot.js, public is at dist/public/
  const publicPath = path.resolve(__dirname, "public");

  app.use("*", serveStatic({
    root: publicPath,
  }));

  // Fallback: serve index.html for SPA routes
  app.notFound((c) => {
    const accept = c.req.header("accept") ?? "";
    if (!accept.includes("text/html")) {
      return c.json({ error: "Not Found" }, 404);
    }
    const indexPath = path.resolve(publicPath, "index.html");
    if (fs.existsSync(indexPath)) {
      const content = fs.readFileSync(indexPath, "utf-8");
      return c.html(content);
    }
    return c.json({ error: "index.html not found", publicPath }, 500);
  });
}
