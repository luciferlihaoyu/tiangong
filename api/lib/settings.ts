/**
 * system_settings KV 读写助手
 */
import { getDb } from "../queries/connection";
import { systemSettings } from "@db/schema";
import { eq } from "drizzle-orm";

export async function getSetting(key: string): Promise<string | null> {
  const db = getDb();
  const row = await db
    .select()
    .from(systemSettings)
    .where(eq(systemSettings.key, key))
    .then((rows) => rows[0]);
  return row?.value ?? null;
}

export async function setSetting(key: string, value: string, category = "general"): Promise<void> {
  const db = getDb();
  const existing = await db
    .select({ key: systemSettings.key })
    .from(systemSettings)
    .where(eq(systemSettings.key, key))
    .then((rows) => rows[0]);
  if (existing) {
    await db.update(systemSettings).set({ value, category }).where(eq(systemSettings.key, key));
  } else {
    await db.insert(systemSettings).values({ key, value, category });
  }
}
