import { eq } from "drizzle-orm";
import * as schema from "@db/schema";
import type { InsertUser } from "@db/schema";
import { getDb } from "./connection";

export async function findUserByUsername(username: string) {
  const rows = await getDb()
    .select()
    .from(schema.users)
    .where(eq(schema.users.username, username))
    .limit(1);
  return rows.at(0);
}

export async function upsertUser(data: InsertUser) {
  const values = { ...data };
  const updateSet: Partial<InsertUser> = {
    lastSignInAt: new Date(),
    ...data,
  };

  await getDb()
    .insert(schema.users)
    .values(values)
    // S1 (PLAN_SQLITE_MIGRATION): S2 will replace the MySQL-specific
    // `onDuplicateKeyUpdate` with SQLite's `onConflictDoUpdate({ target,
    // set })` against `schema.users.username`. The fake-db tests mock
    // `getDb` entirely, so this path is not exercised in S1.
    // @ts-expect-error -- MySQL-only API; S2 will rewrite to onConflictDoUpdate.
    .onDuplicateKeyUpdate({ set: updateSet });
}
