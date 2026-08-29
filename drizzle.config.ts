import { defineConfig } from "drizzle-kit";

// S1（SQLite 迁移）：DATABASE_URL 现在承载 SQLite 文件路径。
// 旧值若是 mysql:// DSN，按运行时同款逻辑（api/queries/connection.ts 的
// resolveDbPath）落到持久卷上的 tiangong.db，保证 drizzle-kit 与应用一致。
const raw = process.env.DATABASE_URL;
if (!raw) {
  throw new Error("DATABASE_URL is required to run drizzle commands");
}
const url =
  raw.startsWith("mysql://") || raw.startsWith("mysql2://")
    ? `${process.env.TIANGONG_ARTIFACT_ROOT ?? "/app/data/tiangong-artifacts"}/tiangong.db`
    : raw;

export default defineConfig({
  schema: "./db/schema.ts",
  out: "./db/migrations",
  dialect: "sqlite",
  dbCredentials: {
    url,
  },
});
