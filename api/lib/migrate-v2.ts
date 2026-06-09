/**
 * V2 Migration — 为已有表添加新列
 * 使用 ALTER TABLE ADD COLUMN IF NOT EXISTS（MySQL 8.0+ 不支持 IF NOT EXISTS for columns）
 * 改用 try/catch 逐个添加，重复列报错忽略
 */
import mysql from "mysql2/promise";
import { env } from "./env";

const MIGRATIONS: { table: string; col: string; def: string }[] = [
  // agents 表新增字段
  { table: "agents", col: "source", def: "VARCHAR(50) DEFAULT 'custom'" },
  { table: "agents", col: "model", def: "VARCHAR(100)" },
  { table: "agents", col: "role", def: "VARCHAR(100)" },
  { table: "agents", col: "manages", def: "TEXT" },
  { table: "agents", col: "reports_to", def: "BIGINT" },
  { table: "agents", col: "org_id", def: "BIGINT" },
  { table: "agents", col: "department_id", def: "BIGINT" },
  { table: "agents", col: "current_task", def: "TEXT" },
  { table: "agents", col: "capabilities", def: "TEXT" },
  { table: "agents", col: "budget_cents", def: "INT DEFAULT 0" },
  { table: "agents", col: "spent_cents", def: "INT DEFAULT 0" },
  { table: "agents", col: "last_heartbeat", def: "TIMESTAMP NULL" },
  { table: "agents", col: "source_api_key", def: "VARCHAR(255)" },
  { table: "agents", col: "source_endpoint", def: "VARCHAR(500)" },

  // tasks 表新增字段
  { table: "tasks", col: "priority", def: "INT DEFAULT 0" },
  { table: "tasks", col: "input", def: "TEXT" },
  { table: "tasks", col: "output", def: "TEXT" },
  { table: "tasks", col: "error", def: "TEXT" },
  { table: "tasks", col: "retry_count", def: "INT DEFAULT 0" },
  { table: "tasks", col: "max_retries", def: "INT DEFAULT 3" },
  { table: "tasks", col: "timeout_ms", def: "INT DEFAULT 300000" },
  { table: "tasks", col: "parent_task_id", def: "BIGINT" },
];

export async function migrateV2() {
  console.log("migrate-v2: DATABASE_URL present =", !!env.databaseUrl);
  if (!env.databaseUrl) {
    console.log("DATABASE_URL not set, skipping v2 migration");
    return;
  }

  let conn: mysql.Connection | null = null;
  try {
    conn = await mysql.createConnection(env.databaseUrl);
    console.log("Database connected, running v2 migrations...");

    let added = 0;
    let skipped = 0;

    for (const { table, col, def } of MIGRATIONS) {
      const sql = `ALTER TABLE \`${table}\` ADD COLUMN \`${col}\` ${def}`;
      try {
        await conn.execute(sql);
        console.log(`  ✅ ${table}.${col} added`);
        added++;
      } catch (e: any) {
        if (e.code === "ER_DUP_FIELDNAME" || e.message?.includes("Duplicate column")) {
          console.log(`  ⏭️  ${table}.${col} already exists`);
          skipped++;
        } else {
          console.warn(`  ⚠️  ${table}.${col} failed:`, e.message?.slice(0, 80));
        }
      }
    }

    // 创建新表（如果不存在）
    const newTables = [
      `CREATE TABLE IF NOT EXISTS organizations (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        description TEXT,
        goals TEXT,
        budget INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS departments (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        description TEXT,
        org_id BIGINT NOT NULL,
        lead_agent_id BIGINT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS task_dependencies (
        id INT AUTO_INCREMENT PRIMARY KEY,
        task_id BIGINT NOT NULL,
        depends_on_task_id BIGINT NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    ];

    for (const sql of newTables) {
      try {
        await conn.execute(sql);
        console.log(`  ✅ New table created`);
      } catch (e: any) {
        console.warn(`  ⚠️  New table failed:`, e.message?.slice(0, 80));
      }
    }

    console.log(`V2 migration completed: ${added} columns added, ${skipped} skipped`);
  } catch (e: any) {
    console.warn("V2 migration failed:", e.message);
  } finally {
    if (conn) await conn.end();
  }
}
