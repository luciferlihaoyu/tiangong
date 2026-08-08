import { getDb } from "../../queries/connection";

/** Drizzle MySQL client type shared by all sweepers. */
export type Db = ReturnType<typeof getDb>;
