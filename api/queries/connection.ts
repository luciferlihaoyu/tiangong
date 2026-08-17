import { drizzle } from "drizzle-orm/mysql2";
import { env } from "../lib/env";
import * as schema from "@db/schema";
import * as relations from "@db/relations";

const fullSchema = { ...schema, ...relations };

let instance: ReturnType<typeof drizzle<typeof fullSchema>> | null = null;

/**
 * Test/QA harness seam (Todo 20): replaces the singleton with an in-memory
 * fake so end-to-end HTTP QA can run without a database. Production never
 * calls this; the runtime path is unaffected when unused.
 */
export function setDbInstance(db: unknown): void {
  instance = db as ReturnType<typeof drizzle<typeof fullSchema>>;
}

export function getDb() {
  if (!instance) {
    if (!env.databaseUrl) {
      throw new Error("DATABASE_URL not configured. Set it in environment variables.");
    }
    instance = drizzle(env.databaseUrl, {
      mode: "planetscale",
      schema: fullSchema,
    });
  }
  return instance;
}
