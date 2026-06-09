/**
 * 启动时自动建表 — 使用 mysql2 原生连接，不依赖 Drizzle ORM
 */
import mysql from "mysql2/promise";
import { env } from "./env";

const CREATE_TABLES_SQL = [
  `CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(50) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    name VARCHAR(255),
    email VARCHAR(320),
    role ENUM('user','admin') DEFAULT 'user' NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL ON UPDATE CURRENT_TIMESTAMP,
    last_sign_in_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS agents (
    id INT AUTO_INCREMENT PRIMARY KEY,
    agent_id VARCHAR(20) NOT NULL UNIQUE,
    name VARCHAR(50) NOT NULL,
    system VARCHAR(30) NOT NULL,
    status ENUM('online','busy','idle') DEFAULT 'idle' NOT NULL,
    task VARCHAR(255),
    progress INT DEFAULT 0 NOT NULL,
    messages_count INT DEFAULT 0 NOT NULL,
    description TEXT,
    created_by BIGINT UNSIGNED,
    source VARCHAR(50) DEFAULT 'custom',
    model VARCHAR(100),
    role VARCHAR(100),
    manages TEXT,
    reports_to BIGINT,
    org_id BIGINT,
    department_id BIGINT,
    current_task TEXT,
    capabilities TEXT,
    budget_cents INT DEFAULT 0,
    spent_cents INT DEFAULT 0,
    last_heartbeat TIMESTAMP NULL,
    source_api_key VARCHAR(255),
    source_endpoint VARCHAR(500),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS tasks (
    id INT AUTO_INCREMENT PRIMARY KEY,
    task_id VARCHAR(20) NOT NULL UNIQUE,
    name VARCHAR(255) NOT NULL,
    agent_id BIGINT UNSIGNED,
    status ENUM('running','pending','done','failed','queued') DEFAULT 'pending' NOT NULL,
    progress INT DEFAULT 0 NOT NULL,
    description TEXT,
    priority INT DEFAULT 0,
    input TEXT,
    output TEXT,
    error TEXT,
    retry_count INT DEFAULT 0,
    max_retries INT DEFAULT 3,
    timeout_ms INT DEFAULT 300000,
    parent_task_id BIGINT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS task_dependencies (
    id INT AUTO_INCREMENT PRIMARY KEY,
    task_id BIGINT NOT NULL,
    depends_on_task_id BIGINT NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS messages (
    id INT AUTO_INCREMENT PRIMARY KEY,
    from_agent BIGINT UNSIGNED NOT NULL,
    to_agent BIGINT UNSIGNED NOT NULL,
    content TEXT NOT NULL,
    type ENUM('command','response','broadcast','system') DEFAULT 'command' NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS systems (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(50) NOT NULL,
    slug VARCHAR(20) NOT NULL UNIQUE,
    status ENUM('connected','syncing','disconnected') DEFAULT 'disconnected' NOT NULL,
    config TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

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

  `CREATE TABLE IF NOT EXISTS mcp_api_keys (
    id INT AUTO_INCREMENT PRIMARY KEY,
    \`key\` VARCHAR(64) NOT NULL UNIQUE,
    agent_id BIGINT,
    name VARCHAR(100),
    permissions TEXT,
    rate_limit INT DEFAULT 10,
    active ENUM('true','false') DEFAULT 'true',
    last_used_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS mcp_audit_log (
    id INT AUTO_INCREMENT PRIMARY KEY,
    key_id BIGINT,
    tool VARCHAR(100),
    params TEXT,
    result VARCHAR(20),
    error TEXT,
    duration_ms INT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];

export async function autoMigrate(): Promise<string[]> {
  const logs: string[] = [];
  console.log("auto-migrate: DATABASE_URL present =", !!env.databaseUrl);
  if (!env.databaseUrl) {
    logs.push("DATABASE_URL not set, skipping auto-migration");
    console.log("DATABASE_URL not set, skipping auto-migration");
    return logs;
  }

  let conn: mysql.Connection | null = null;
  try {
    conn = await mysql.createConnection(env.databaseUrl);
    logs.push("Database connected");
    console.log("Database connected, running migrations...");

    for (const sql of CREATE_TABLES_SQL) {
      try {
        await conn.execute(sql);
        const tableName = sql.match(/CREATE TABLE IF NOT EXISTS (\w+)/)?.[1] || "unknown";
        logs.push(`Table ${tableName}: OK`);
      } catch (e: any) {
        const tableName = sql.match(/CREATE TABLE IF NOT EXISTS (\w+)/)?.[1] || "unknown";
        logs.push(`Table ${tableName}: ${e.message?.slice(0, 80)}`);
        console.warn("Migration statement warning:", e.message?.slice(0, 100));
      }
    }

    logs.push(`Auto-migration completed: ${CREATE_TABLES_SQL.length} tables checked`);
    console.log(`Auto-migration completed: ${CREATE_TABLES_SQL.length} tables checked`);
  } catch (e: any) {
    logs.push(`Connection failed: ${e.message}`);
    console.warn("Auto-migration failed:", e.message);
  } finally {
    if (conn) await conn.end();
  }
  return logs;
}
