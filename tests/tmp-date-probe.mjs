import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(":memory:");
const r = db
  .prepare(
    `SELECT DATE(1757736000) AS sec, DATE(1757736000000) AS ms, DATE(NULL) AS nul,
            datetime(1757736000, 'unixepoch') AS dt, sqlite_version() AS v`,
  )
  .all();
console.log(JSON.stringify(r, null, 2));
