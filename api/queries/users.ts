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

  // S2 (PLAN_SQLITE_MIGRATION): SQLite's `onConflictDoUpdate` mirrors MySQL's
  // `ON DUPLICATE KEY UPDATE` semantics. We target the unique `username` column
  // (the conflict resolution key in the MySQL version). The fake-db test
  // harness still mocks `getDb` entirely, so this path is exercised in
  // production by the login flow.
  await getDb()
    .insert(schema.users)
    .values(values)
    .onConflictDoUpdate({ target: schema.users.username, set: updateSet });
}
