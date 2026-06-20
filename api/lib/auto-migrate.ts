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
    \`system\` VARCHAR(30) NOT NULL,
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
    agent_card TEXT,
    openclaw_agent VARCHAR(100),
    can_modify_tiangong_core ENUM('true','false') DEFAULT 'false',
    can_send_external_message ENUM('true','false') DEFAULT 'false',
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
    expected_output_schema TEXT,
    output_valid ENUM('true','false','unknown') DEFAULT 'unknown',
    lifecycle_status VARCHAR(30) DEFAULT 'created',
    dispatcher_agent_id BIGINT UNSIGNED,
    claimed_at TIMESTAMP NULL,
    dispatched_at TIMESTAMP NULL,
    accepted_at TIMESTAMP NULL,
    completed_at TIMESTAMP NULL,
    failed_at TIMESTAMP NULL,
    timeout_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS task_dependencies (
    id INT AUTO_INCREMENT PRIMARY KEY,
    task_id BIGINT NOT NULL,
    depends_on_task_id BIGINT NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // P8.1: messages 完整定义（含可靠协作字段）
  `CREATE TABLE IF NOT EXISTS messages (
    id INT AUTO_INCREMENT PRIMARY KEY,
    from_agent BIGINT UNSIGNED NOT NULL,
    to_agent BIGINT UNSIGNED NOT NULL,
    content TEXT NOT NULL,
    type ENUM('command','response','broadcast','system','ack') DEFAULT 'command' NOT NULL,
    status ENUM('sent','delivered','read','acked','expired') DEFAULT 'sent' NOT NULL,
    read_at TIMESTAMP NULL,
    conversation_id BIGINT UNSIGNED NULL,
    correlation_id VARCHAR(64),
    idempotency_key VARCHAR(128),
    task_id BIGINT UNSIGNED NULL,
    parent_message_id BIGINT UNSIGNED NULL,
    expires_at TIMESTAMP NULL,
    acked_at TIMESTAMP NULL,
    delivered_at TIMESTAMP NULL,
    retry_count INT DEFAULT 0 NOT NULL,
    priority INT DEFAULT 0 NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
    UNIQUE KEY uq_messages_idempotency (from_agent, idempotency_key)
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

  // P9: Token 用量监测表（不存 key/secret/prompt/response）
  `CREATE TABLE IF NOT EXISTS token_usage (
    id INT AUTO_INCREMENT PRIMARY KEY,
    model VARCHAR(100) NOT NULL,
    provider VARCHAR(50) DEFAULT 'unknown',
    prompt_tokens INT DEFAULT 0 NOT NULL,
    completion_tokens INT DEFAULT 0 NOT NULL,
    total_tokens INT DEFAULT 0 NOT NULL,
    call_count INT DEFAULT 1 NOT NULL,
    cost_cents INT DEFAULT 0 NOT NULL,
    task_id BIGINT UNSIGNED NULL,
    agent_id BIGINT UNSIGNED NULL,
    started_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,



  // P11: GitHub App integration tables
  `CREATE TABLE IF NOT EXISTS github_integrations (
    id INT AUTO_INCREMENT PRIMARY KEY,
    app_id VARCHAR(20),
    installation_id VARCHAR(20),
    owner VARCHAR(100),
    active ENUM('true','false') DEFAULT 'true',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS github_repos (
    id INT AUTO_INCREMENT PRIMARY KEY,
    owner VARCHAR(100) NOT NULL,
    name VARCHAR(100) NOT NULL,
    full_name VARCHAR(255) NOT NULL,
    default_branch VARCHAR(100) DEFAULT 'main',
    installation_id BIGINT UNSIGNED NULL,
    active ENUM('true','false') DEFAULT 'true',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS github_repo_permissions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    agent_id BIGINT UNSIGNED NOT NULL,
    repo_id BIGINT UNSIGNED NOT NULL,
    permission_level ENUM('read','push','admin') DEFAULT 'read' NOT NULL,
    active ENUM('true','false') DEFAULT 'true',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS github_pull_requests (
    id INT AUTO_INCREMENT PRIMARY KEY,
    repo_id BIGINT UNSIGNED NOT NULL,
    pr_number INT NOT NULL,
    title VARCHAR(500) NOT NULL,
    body TEXT,
    branch_name VARCHAR(255),
    base_branch VARCHAR(255),
    head_sha VARCHAR(40),
    author_agent_id BIGINT UNSIGNED NULL,
    status ENUM('pending','approved','rejected','merged','closed') DEFAULT 'pending' NOT NULL,
    approved_by BIGINT UNSIGNED NULL,
    approved_at TIMESTAMP NULL,
    merged_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS github_audit_log (
    id INT AUTO_INCREMENT PRIMARY KEY,
    pr_id BIGINT UNSIGNED NULL,
    action ENUM('approve','reject','merge','register','revoke') NOT NULL,
    agent_id BIGINT UNSIGNED NULL,
    reason TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS task_threads (
    id INT AUTO_INCREMENT PRIMARY KEY,
    task_id BIGINT UNSIGNED NOT NULL,
    title VARCHAR(255),
    status ENUM('open','closed','archived') DEFAULT 'open' NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS task_messages (
    id INT AUTO_INCREMENT PRIMARY KEY,
    task_id BIGINT UNSIGNED NOT NULL,
    thread_id BIGINT UNSIGNED,
    from_agent_id BIGINT UNSIGNED,
    to_agent_id BIGINT UNSIGNED,
    event_type ENUM('dispatch','ack','progress','working','result','error','timeout','cancel','system') DEFAULT 'system' NOT NULL,
    content TEXT,
    metadata TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS task_artifacts (
    id INT AUTO_INCREMENT PRIMARY KEY,
    task_id BIGINT UNSIGNED NOT NULL,
    agent_id BIGINT UNSIGNED,
    type VARCHAR(50) NOT NULL,
    name VARCHAR(255),
    content TEXT,
    json_payload TEXT,
    mime_type VARCHAR(100),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS mailbox_messages (
    id INT AUTO_INCREMENT PRIMARY KEY,
    task_id BIGINT UNSIGNED NULL,
    thread_id BIGINT UNSIGNED NULL,
    from_agent_id BIGINT UNSIGNED NULL,
    from_mailbox_id VARCHAR(20) NOT NULL,
    to_agent_id BIGINT UNSIGNED NOT NULL,
    to_mailbox_id VARCHAR(20) NOT NULL,
    type ENUM('direct','mention','question','review_request','subtask','handoff','result_notice') DEFAULT 'direct' NOT NULL,
    status ENUM('unread','acknowledged','working','replied','resolved','failed') DEFAULT 'unread' NOT NULL,
    subject VARCHAR(255),
    body TEXT,
    payload_json TEXT,
    reply_to_message_id BIGINT UNSIGNED NULL,
    artifact_id BIGINT UNSIGNED NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
    acknowledged_at TIMESTAMP NULL,
    replied_at TIMESTAMP NULL,
    resolved_at TIMESTAMP NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

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
];

export async function autoMigrate(force = false): Promise<string[]> {
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
        const tableName = sql.match(/CREATE TABLE IF NOT EXISTS (\w+)/)?.[1] || "unknown";
        if (force) {
          // Force recreate: drop then create
          try { await conn.execute(`DROP TABLE IF EXISTS \`${tableName}\``); } catch {}
          const createSql = sql.replace("IF NOT EXISTS ", "");
          await conn.execute(createSql);
          logs.push(`Table ${tableName}: FORCE RECREATED`);
        } else {
          await conn.execute(sql);
          logs.push(`Table ${tableName}: OK`);
        }
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
