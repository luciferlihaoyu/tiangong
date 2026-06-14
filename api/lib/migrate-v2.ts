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

  // messages 表新增字段 (WebSocket 实时通信)
  { table: "messages", col: "status", def: "ENUM('sent','delivered','read','acked','expired') DEFAULT 'sent' NOT NULL" },
  { table: "messages", col: "read_at", def: "TIMESTAMP NULL" },
  { table: "messages", col: "conversation_id", def: "BIGINT UNSIGNED NULL" },

  // P8.1: 可靠消息总线新字段
  { table: "messages", col: "correlation_id", def: "VARCHAR(64)" },
  { table: "messages", col: "idempotency_key", def: "VARCHAR(128)" },
  { table: "messages", col: "task_id", def: "BIGINT UNSIGNED NULL" },
  { table: "messages", col: "parent_message_id", def: "BIGINT UNSIGNED NULL" },
  { table: "messages", col: "expires_at", def: "TIMESTAMP NULL" },
  { table: "messages", col: "acked_at", def: "TIMESTAMP NULL" },
  { table: "messages", col: "delivered_at", def: "TIMESTAMP NULL" },
  { table: "messages", col: "retry_count", def: "INT DEFAULT 0 NOT NULL" },
  { table: "messages", col: "priority", def: "INT DEFAULT 0 NOT NULL" },
];

export async function migrateV2(force = false): Promise<string[]> {
  const logs: string[] = [];
  console.log("migrate-v2: DATABASE_URL present =", !!env.databaseUrl);
  if (!env.databaseUrl) {
    logs.push("DATABASE_URL not set, skipping v2 migration");
    console.log("DATABASE_URL not set, skipping v2 migration");
    return logs;
  }

  let conn: mysql.Connection | null = null;
  try {
    conn = await mysql.createConnection(env.databaseUrl);
    logs.push("Database connected");
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
          logs.push(`${table}.${col}: ${e.message?.slice(0, 80)}`);
          console.warn(`  ⚠️  ${table}.${col} failed:`, e.message?.slice(0, 80));
        }
      }
    }

    // 修复 organizations 表：如果 budget 列存在但 budget_cents 不存在，改名
    try {
      await conn.execute(`ALTER TABLE organizations CHANGE COLUMN budget budget_cents INT DEFAULT 0`);
      logs.push("organizations: budget → budget_cents renamed");
    } catch (e: any) {
      // 忽略（可能已经正确或者表不存在）
    }

    // 创建新表（如果不存在）
    const newTables = [
      `CREATE TABLE IF NOT EXISTS conversations (
        id INT AUTO_INCREMENT PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        type ENUM('mission','meeting','test','ad_hoc') DEFAULT 'ad_hoc' NOT NULL,
        status ENUM('active','archived') DEFAULT 'active' NOT NULL,
        participants TEXT,
        summary TEXT,
        created_by BIGINT UNSIGNED,
        archived_at TIMESTAMP NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS organizations (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        description TEXT,
        goals TEXT,
        budget_cents INT DEFAULT 0,
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
        const tableName = sql.match(/CREATE TABLE IF NOT EXISTS (\w+)/)?.[1] || "unknown";
        if (force) {
          try { await conn.execute(`DROP TABLE IF EXISTS \`${tableName}\``); } catch {}
          const createSql = sql.replace("IF NOT EXISTS ", "");
          await conn.execute(createSql);
          logs.push(`New table ${tableName}: FORCE RECREATED`);
        } else {
          await conn.execute(sql);
          logs.push(`New table ${tableName}: OK`);
        }
      } catch (e: any) {
        const tableName = sql.match(/CREATE TABLE IF NOT EXISTS (\w+)/)?.[1] || "unknown";
        logs.push(`New table ${tableName}: ${e.message?.slice(0, 80)}`);
        console.warn(`  ⚠️  New table failed:`, e.message?.slice(0, 80));
      }
    }

    // P8.1: migrate type enum to include 'ack' value
    try {
      await conn.execute(
        `ALTER TABLE messages MODIFY COLUMN type ENUM('command','response','broadcast','system','ack') DEFAULT 'command' NOT NULL`
      );
      logs.push("messages.type: ENUM updated to include 'ack'");
      console.log("  ✅ messages.type ENUM updated");
    } catch (e: any) {
      logs.push(`messages.type ENUM: ${e.message?.slice(0, 80)}`);
      console.warn("  ⚠️ messages.type ENUM update failed:", e.message?.slice(0, 80));
    }

    // P8.1: migrate status enum to include 'acked' and 'expired' values
    try {
      await conn.execute(
        `ALTER TABLE messages MODIFY COLUMN status ENUM('sent','delivered','read','acked','expired') DEFAULT 'sent' NOT NULL`
      );
      logs.push("messages.status: ENUM updated to include 'acked','expired'");
      console.log("  ✅ messages.status ENUM updated");
    } catch (e: any) {
      logs.push(`messages.status ENUM: ${e.message?.slice(0, 80)}`);
      console.warn("  ⚠️ messages.status ENUM update failed:", e.message?.slice(0, 80));
    }

    // P8.1: add unique index for idempotency (from_agent, idempotency_key)
    try {
      await conn.execute(
        `CREATE UNIQUE INDEX uq_messages_idempotency ON messages (from_agent, idempotency_key)`
      );
      logs.push("messages: uq_messages_idempotency index created");
      console.log("  ✅ messages uq_messages_idempotency index created");
    } catch (e: any) {
      if (e.code === "ER_DUP_KEYNAME" || e.message?.includes("Duplicate key name")) {
        logs.push("messages: uq_messages_idempotency index already exists");
        console.log("  ⏭️  messages uq_messages_idempotency index already exists");
      } else {
        logs.push(`messages uq index: ${e.message?.slice(0, 80)}`);
        console.warn("  ⚠️ messages uq index failed:", e.message?.slice(0, 80));
      }
    }

    logs.push(`V2 migration completed: ${added} columns added, ${skipped} skipped`);
    console.log(`V2 migration completed: ${added} columns added, ${skipped} skipped`);
  } catch (e: any) {
    logs.push(`Connection failed: ${e.message}`);
    console.warn("V2 migration failed:", e.message);
  } finally {
    if (conn) await conn.end();
  }
  return logs;
}
