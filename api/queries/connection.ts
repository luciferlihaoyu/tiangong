import path from "node:path";
import fs from "node:fs";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { env } from "../lib/env";
import * as schema from "@db/schema";
import * as relations from "@db/relations";
import { nodeSqliteAdapter } from "../lib/node-sqlite-adapter";

const fullSchema = { ...schema, ...relations };

let instance: ReturnType<typeof drizzle<typeof fullSchema>> | null = null;

/**
 * Test/QA harness seam (Todo 20): replaces the singleton with an in-memory
 * fake so end-to-end HTTP QA can run without a database. Production never
 * calls this; the runtime path is unaffected when unused.
 *
 * Type signature preserved across the MySQL→SQLite dialect switch so
 * existing fake-db fixtures (tests/api/helpers/fake-db.ts) keep working
 * without modification.
 */
export function setDbInstance(db: unknown): void {
  instance = db as ReturnType<typeof drizzle<typeof fullSchema>>;
}

/**
 * Resolve a SQLite file path from the legacy `DATABASE_URL` value.
 *
 * Pre-S1 deployments used `mysql://user:pass@host:port/db` for MySQL. After
 * the SQLite switch (S1) we ignore the MySQL DSN and fall back to a
 * volume-persisted file path so existing env files keep working without
 * operator action. The fallback lives under `TIANGONG_ARTIFACT_ROOT`
 * (default `/app/data/tiangong-artifacts`, the Zeabur-persisted artifact
 * volume — see `zeabur.json` mountPaths) as `tiangong.db`. Artifact GC only
 * sweeps the `by-sha/` and `gc/` subdirectories, so the db file at the
 * volume root is never touched by cleanup.
 *
 * Explicit non-DSN `DATABASE_URL` values (plain file paths) pass through.
 */
export function resolveDbPath(databaseUrl: string): string {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL not configured. Set it in environment variables.");
  }
  if (databaseUrl.startsWith("mysql://") || databaseUrl.startsWith("mysql2://")) {
    const artifactRoot = env.artifactRoot ?? "/app/data/tiangong-artifacts";
    return path.resolve(artifactRoot, "tiangong.db");
  }
  return databaseUrl;
}

/**
 * Ensure the directory for the resolved SQLite path exists. node:sqlite
 * will not create parent directories on its own; this keeps the runtime
 * self-contained.
 */
function ensureParentDir(filePath: string): void {
  const parent = path.dirname(filePath);
  if (parent && !fs.existsSync(parent)) {
    fs.mkdirSync(parent, { recursive: true });
  }
}

export function getDb() {
  if (!instance) {
    const dbPath = resolveDbPath(env.databaseUrl);
    ensureParentDir(dbPath);
    // Lazy require so vitest can mock the sqlite layer in fake-db tests
    // without paying the cost of opening a real database on module load.
    // node:sqlite is built into Node 22+ so this stays a single line.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const sqlite = new DatabaseSync(dbPath);
    instance = drizzle(nodeSqliteAdapter(sqlite), { schema: fullSchema });
  }
  return instance;
}
