/**
 * 启动时自动建表 — 使用 mysql2 原生连接，不依赖 Drizzle ORM
 */
import mysql from "mysql2/promise";
import { readFileSync } from "node:fs";
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
    worker_lease_token VARCHAR(64) NULL,
    worker_lease_generation INT NOT NULL DEFAULT 0,
    worker_lease_expires_at TIMESTAMP NULL,
    cancel_requested_at TIMESTAMP NULL,
    cancel_acknowledged_at TIMESTAMP NULL,
    origin_system VARCHAR(32) NULL,
    external_ref VARCHAR(255) NULL,
    idempotency_key VARCHAR(128) NULL,
    canonical_request_hash VARCHAR(64) NULL,
    canonical_request_hash_version VARCHAR(32) NULL,
    state_revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
    task_retain_until TIMESTAMP NULL,
    idempotency_retain_until TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_tasks_origin_external_ref (origin_system, external_ref),
    UNIQUE KEY uq_tasks_origin_idempotency_key (origin_system, idempotency_key)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS tiangong_task_limits (
    id INT AUTO_INCREMENT PRIMARY KEY,
    principal_key VARCHAR(255) NOT NULL,
    workspace_slug VARCHAR(100) NOT NULL,
    max_concurrent_tasks INT NOT NULL DEFAULT 8,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_tiangong_task_limits_principal_workspace (principal_key, workspace_slug)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS task_execution_slots (
    id INT AUTO_INCREMENT PRIMARY KEY,
    task_id BIGINT UNSIGNED NOT NULL,
    principal_key VARCHAR(255) NOT NULL,
    workspace_slug VARCHAR(100) NOT NULL,
    lease_token VARCHAR(64) NOT NULL,
    acquired_at TIMESTAMP NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    UNIQUE KEY uq_task_execution_slots_task (task_id),
    KEY idx_task_execution_slots_scope (principal_key, workspace_slug, expires_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS tiangong_worker_leases (
    id INT AUTO_INCREMENT PRIMARY KEY,
    lease_token VARCHAR(64) NOT NULL UNIQUE,
    worker_id VARCHAR(128) NOT NULL,
    principal_key VARCHAR(255) NOT NULL,
    workspace_slug VARCHAR(100) NOT NULL,
    generation INT NOT NULL,
    issued_at TIMESTAMP NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    revoked_at TIMESTAMP NULL,
    KEY idx_tiangong_worker_leases_worker_scope (worker_id, principal_key, workspace_slug, expires_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS task_outbox_events (
    id INT AUTO_INCREMENT PRIMARY KEY,
    event_id VARCHAR(36) NOT NULL UNIQUE,
    task_id BIGINT UNSIGNED NOT NULL,
    task_public_id VARCHAR(20) NOT NULL,
    external_ref VARCHAR(255) NOT NULL,
    origin_system VARCHAR(32) NOT NULL,
    workspace_slug VARCHAR(100) NOT NULL,
    project_slug VARCHAR(100) NOT NULL,
    event_type ENUM('state','approval','terminal') NOT NULL,
    status VARCHAR(30) NOT NULL,
    lifecycle_status VARCHAR(30),
    board_status VARCHAR(20),
    review_result VARCHAR(30),
    state_revision BIGINT UNSIGNED NOT NULL,
    trace_id VARCHAR(64) NOT NULL,
    payload_digest VARCHAR(64) NOT NULL,
    manifest_identity VARCHAR(64) NULL,
    key_id VARCHAR(64) NOT NULL,
    attempts INT NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMP NOT NULL,
    first_attempt_at TIMESTAMP NULL,
    delivered_at TIMESTAMP NULL,
    dead_letter_at TIMESTAMP NULL,
    last_error_code VARCHAR(64),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_task_outbox_task_revision (task_id, state_revision),
    KEY idx_task_outbox_due (next_attempt_at, delivered_at, dead_letter_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS tiangong_provider_identity (
    provider_instance_id VARCHAR(64) PRIMARY KEY,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS tiangong_artifact_limits (
    id INT AUTO_INCREMENT PRIMARY KEY,
    principal_key VARCHAR(255) NOT NULL,
    workspace_slug VARCHAR(100) NOT NULL,
    storage_quota_bytes BIGINT UNSIGNED NOT NULL,
    retention_seconds INT NOT NULL,
    gc_grace_seconds INT NOT NULL,
    gc_reaper_concurrency INT NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_tiangong_artifact_limits_scope (principal_key, workspace_slug)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS staged_objects (
    stage_id VARCHAR(128) PRIMARY KEY,
    expected_sha256 VARCHAR(64) NOT NULL,
    expected_size BIGINT UNSIGNED NOT NULL,
    expected_mime VARCHAR(255) NOT NULL,
    generation_id INT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
    owner_principal VARCHAR(255) NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    state ENUM('staging','verified','sealed','abandoned') DEFAULT 'staging' NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS sealed_artifact_descriptors (
    id INT AUTO_INCREMENT PRIMARY KEY,
    artifact_uuid VARCHAR(36) NOT NULL,
    task_id BIGINT UNSIGNED NOT NULL,
    task_public_id VARCHAR(20) NOT NULL,
    external_ref VARCHAR(255) NOT NULL,
    task_revision BIGINT UNSIGNED NOT NULL,
    creator_agent_id BIGINT UNSIGNED NULL,
    owner_principal VARCHAR(255) NOT NULL,
    workspace_slug VARCHAR(100) NOT NULL,
    project_slug VARCHAR(100) NOT NULL,
    provider_instance_id VARCHAR(64) NOT NULL,
    sha256 VARCHAR(64) NOT NULL,
    generation_id INT NOT NULL,
    size BIGINT UNSIGNED NOT NULL,
    mime VARCHAR(255) NOT NULL,
    stored_path VARCHAR(500) NOT NULL,
    sealed_at TIMESTAMP NOT NULL,
    retain_until TIMESTAMP NOT NULL,
    UNIQUE KEY uq_sealed_artifact_task_uuid (task_id, artifact_uuid),
    KEY idx_sealed_artifact_task_revision (task_id, task_revision)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS sealed_artifact_manifests (
    id INT AUTO_INCREMENT PRIMARY KEY,
    task_id BIGINT UNSIGNED NOT NULL UNIQUE,
    task_public_id VARCHAR(20) NOT NULL,
    external_ref VARCHAR(255) NOT NULL,
    task_revision BIGINT UNSIGNED NOT NULL,
    provider_instance_id VARCHAR(64) NOT NULL,
    manifest_identity VARCHAR(64) NOT NULL UNIQUE,
    canonical_manifest TEXT NOT NULL,
    sealed_at TIMESTAMP NOT NULL
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

  // Todo 20: Beidou-to-Tiangong service keys — verifier-only storage.
  // The plaintext token is NEVER stored; only the full 32-byte
  // HMAC-SHA-256(server_pepper, token) verifier + key_id + 6-byte key prefix.
  `CREATE TABLE IF NOT EXISTS tiangong_service_keys (
    id INT AUTO_INCREMENT PRIMARY KEY,
    key_id VARCHAR(64) NOT NULL UNIQUE,
    verifier VARCHAR(64) NOT NULL,
    key_prefix VARCHAR(12) NOT NULL,
    origin_system VARCHAR(32) NOT NULL DEFAULT 'beidou',
    workspace_slug VARCHAR(100) NOT NULL,
    project_slug VARCHAR(100) NOT NULL,
    scopes TEXT NOT NULL,
    issued_at TIMESTAMP NOT NULL,
    rotation_window_end TIMESTAMP NULL,
    revoked_at TIMESTAMP NULL,
    revoked_reason VARCHAR(100),
    version INT NOT NULL DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_tiangong_service_keys_key_id (key_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // Todo 20: service key auth audit — key_id, originSystem and a one-way
  // redacted token prefix only; never the token or verifier.
  `CREATE TABLE IF NOT EXISTS service_key_audit_log (
    id INT AUTO_INCREMENT PRIMARY KEY,
    key_id VARCHAR(64),
    origin_system VARCHAR(32),
    token_prefix VARCHAR(12),
    decision ENUM('authenticated','denied') NOT NULL,
    reason VARCHAR(100),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // P13: Model pricing table
  `CREATE TABLE IF NOT EXISTS model_pricing (
    model VARCHAR(100) PRIMARY KEY,
    provider VARCHAR(50) DEFAULT 'unknown',
    input_price DECIMAL(10,8) NOT NULL DEFAULT 0,
    output_price DECIMAL(10,8) NOT NULL DEFAULT 0,
    cached_input_price DECIMAL(10,8),
    currency VARCHAR(3) DEFAULT 'USD',
    notes TEXT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // P13: Token 用量监测表（含缓存区分 + 汇率）
  `CREATE TABLE IF NOT EXISTS token_usage (
    id INT AUTO_INCREMENT PRIMARY KEY,
    model VARCHAR(100) NOT NULL,
    provider VARCHAR(50) DEFAULT 'unknown',
    prompt_tokens INT DEFAULT 0 NOT NULL,
    completion_tokens INT DEFAULT 0 NOT NULL,
    total_tokens INT DEFAULT 0 NOT NULL,
    cached_prompt_tokens INT DEFAULT 0,
    uncached_prompt_tokens INT DEFAULT 0,
    call_count INT DEFAULT 1 NOT NULL,
    cost_cents INT DEFAULT 0 NOT NULL,
    currency VARCHAR(3) DEFAULT 'USD',
    exchange_rate DECIMAL(10,6) DEFAULT 1.0,
    cost_display DECIMAL(12,4) DEFAULT 0,
    task_id BIGINT UNSIGNED NULL,
    agent_id BIGINT UNSIGNED NULL,
    session_key VARCHAR(128),
    source VARCHAR(20) DEFAULT 'manual',
    trace_id VARCHAR(64),
    started_at TIMESTAMP NULL,
    high_cost_model ENUM('true','false') DEFAULT 'false',
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
    mailbox_type ENUM('direct','mention','question','review_request','subtask','handoff','result_notice') DEFAULT 'direct' NOT NULL,
    mailbox_status ENUM('unread','acknowledged','working','replied','resolved','failed') DEFAULT 'unread' NOT NULL,
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

  // Phase 1: General audit/event ledger
  `CREATE TABLE IF NOT EXISTS audit_events (
    id INT AUTO_INCREMENT PRIMARY KEY,
    event VARCHAR(50) NOT NULL,
    actor_user_id BIGINT UNSIGNED NOT NULL,
    workspace_id BIGINT UNSIGNED NULL,
    project_id BIGINT UNSIGNED NULL,
    target_user_id BIGINT UNSIGNED NULL,
    entity_type VARCHAR(50) NOT NULL,
    entity_id BIGINT UNSIGNED NULL,
    metadata TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
    prev_hash VARCHAR(64) NULL,
    hash VARCHAR(64) NULL,
    KEY idx_audit_events_created_at (created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // Phase 1: Connector registry foundation (metadata-only, no secrets in rows)
  `CREATE TABLE IF NOT EXISTS connector_registry (
    id INT AUTO_INCREMENT PRIMARY KEY,
    workspace_id BIGINT UNSIGNED NOT NULL,
    project_id BIGINT UNSIGNED NULL,
    name VARCHAR(100) NOT NULL,
    slug VARCHAR(100) NOT NULL,
    connector_type ENUM('opencode','xuanji','s3') NOT NULL,
    status ENUM('draft','active','disabled') DEFAULT 'draft' NOT NULL,
    endpoint VARCHAR(500) NULL,
    config TEXT NULL,
    secret_ref_id BIGINT UNSIGNED NULL,
    created_by BIGINT UNSIGNED NOT NULL,
    updated_by BIGINT UNSIGNED NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_connector_registry_workspace_project_slug (workspace_id, project_id, slug)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // Phase 1: Artifact registry metadata abstraction (no file contents, no storage clients)
  `CREATE TABLE IF NOT EXISTS artifact_registry (
    id INT AUTO_INCREMENT PRIMARY KEY,
    workspace_id BIGINT UNSIGNED NOT NULL,
    project_id BIGINT UNSIGNED NULL,
    task_id BIGINT UNSIGNED NULL,
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(100) NOT NULL,
    artifact_type ENUM('file','image','document','log','data') NOT NULL,
    status ENUM('draft','active','archived','deleted') DEFAULT 'draft' NOT NULL,
    mime_type VARCHAR(100) NULL,
    size_bytes BIGINT NULL,
    checksum_sha256 VARCHAR(64) NULL,
    storage_backref_type ENUM('connector','inline','external') NULL,
    storage_backref_id VARCHAR(100) NULL,
    metadata TEXT NULL,
    created_by BIGINT UNSIGNED NOT NULL,
    updated_by BIGINT UNSIGNED NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_artifact_registry_workspace_project_slug (workspace_id, project_id, slug)
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

async function migrateMailboxColumns(conn: mysql.Connection, logs: string[]) {
  const columnPairs = [
    {
      oldName: "type",
      newName: "mailbox_type",
      definition: "ENUM('direct','mention','question','review_request','subtask','handoff','result_notice') DEFAULT 'direct' NOT NULL",
    },
    {
      oldName: "status",
      newName: "mailbox_status",
      definition: "ENUM('unread','acknowledged','working','replied','resolved','failed') DEFAULT 'unread' NOT NULL",
    },
  ];

  for (const column of columnPairs) {
    try {
      await conn.execute(
        `ALTER TABLE mailbox_messages CHANGE COLUMN \`${column.oldName}\` \`${column.newName}\` ${column.definition}`
      );
      logs.push(`mailbox_messages.${column.oldName} -> ${column.newName}: OK`);
    } catch (e: any) {
      if (e?.code === "ER_BAD_FIELD_ERROR") {
        logs.push(`mailbox_messages.${column.newName}: already OK`);
      } else {
        logs.push(`mailbox_messages.${column.oldName} migration: ${e.message?.slice(0, 80)}`);
        console.warn("Mailbox column migration warning:", e.message?.slice(0, 100));
      }
    }
  }
}

async function migrateP13Columns(conn: mysql.Connection, logs: string[]) {
  const p13Columns = [
    { name: "cached_prompt_tokens", def: "INT DEFAULT 0" },
    { name: "uncached_prompt_tokens", def: "INT DEFAULT 0" },
    { name: "currency", def: "VARCHAR(3) DEFAULT 'USD'" },
    { name: "exchange_rate", def: "DECIMAL(10,6) DEFAULT 1.0" },
    { name: "cost_display", def: "DECIMAL(12,4) DEFAULT 0" },
  ];

  for (const col of p13Columns) {
    try {
      await conn.execute(
        `ALTER TABLE token_usage ADD COLUMN \`${col.name}\` ${col.def}`
      );
      logs.push(`token_usage.${col.name}: ADDED`);
    } catch (e: any) {
      if (e?.code === "ER_DUP_FIELD_NAME" || e?.message?.includes("Duplicate column")) {
        logs.push(`token_usage.${col.name}: already exists`);
      } else {
        logs.push(`token_usage.${col.name}: ${e.message?.slice(0, 80)}`);
      }
    }
  }
}

async function migrateExternalTaskIdentity(conn: mysql.Connection, logs: string[]) {
  const columns = [
    { name: "origin_system", def: "VARCHAR(32) NULL" },
    { name: "external_ref", def: "VARCHAR(255) NULL" },
    { name: "idempotency_key", def: "VARCHAR(128) NULL" },
    { name: "canonical_request_hash", def: "VARCHAR(64) NULL" },
    { name: "canonical_request_hash_version", def: "VARCHAR(32) NULL" },
    { name: "state_revision", def: "BIGINT UNSIGNED NOT NULL DEFAULT 1" },
    { name: "task_retain_until", def: "TIMESTAMP NULL" },
    { name: "idempotency_retain_until", def: "TIMESTAMP NULL" },
    { name: "worker_lease_token", def: "VARCHAR(64) NULL" },
    { name: "worker_lease_generation", def: "INT NOT NULL DEFAULT 0" },
    { name: "worker_lease_expires_at", def: "TIMESTAMP NULL" },
    { name: "cancel_requested_at", def: "TIMESTAMP NULL" },
    { name: "cancel_acknowledged_at", def: "TIMESTAMP NULL" },
  ] as const;
  for (const column of columns) {
    try {
      await conn.execute(`ALTER TABLE tasks ADD COLUMN \`${column.name}\` ${column.def}`);
      logs.push(`tasks.${column.name}: ADDED`);
    } catch (error: any) {
      if (error?.code === "ER_DUP_FIELD_NAME" || error?.message?.includes("Duplicate column")) {
        logs.push(`tasks.${column.name}: already exists`);
      } else {
        throw error;
      }
    }
  }
  const indexes = [
    { name: "uq_tasks_origin_external_ref", columns: "origin_system, external_ref" },
    { name: "uq_tasks_origin_idempotency_key", columns: "origin_system, idempotency_key" },
  ] as const;
  for (const indexDef of indexes) {
    try {
      await conn.execute(`ALTER TABLE tasks ADD UNIQUE KEY \`${indexDef.name}\` (${indexDef.columns})`);
      logs.push(`tasks.${indexDef.name}: ADDED`);
    } catch (error: any) {
      if (error?.code === "ER_DUP_KEYNAME" || error?.message?.includes("Duplicate key name")) {
        logs.push(`tasks.${indexDef.name}: already exists`);
      } else {
        throw error;
      }
    }
  }
}

async function seedModelPricing(conn: mysql.Connection, logs: string[]) {
  const seeds = [
    { model: "deepseek-v4-flash", provider: "deepseek-official", input_price: 0.0003, output_price: 0.0006, cached_input_price: 0.000075 },
    { model: "deepseek-reasoner", provider: "deepseek-official", input_price: 0.002, output_price: 0.008, cached_input_price: 0.0005 },
    { model: "deepseek-v3.2", provider: "zeabur-ai", input_price: 0.0005, output_price: 0.0015 },
    { model: "deepseek-v4-pro", provider: "deepseek-official", input_price: 0.002, output_price: 0.008, cached_input_price: 0.0005 },
    { model: "kimi-for-coding", provider: "kimi-code", input_price: 0.004, output_price: 0.012 },
    { model: "MiniMax-M3", provider: "minimax-cn", input_price: 0.002, output_price: 0.008 },
    { model: "MiniMax-M2.7", provider: "minimax-cn", input_price: 0.001, output_price: 0.004 },
    { model: "claude-opus-4-8", provider: "anthropic", input_price: 0.015, output_price: 0.075, cached_input_price: 0.0075 },
    { model: "claude-fable-5", provider: "anthropic", input_price: 0.003, output_price: 0.015, cached_input_price: 0.0003 },
    { model: "ark-code-latest", provider: "volcengine-plan", input_price: 0.002, output_price: 0.008 },
    { model: "qwen3.6-plus", provider: "bailian", input_price: 0.002, output_price: 0.008 },
    { model: "doubao-seedream-5-0-260128", provider: "volcengine", input_price: 0.008, output_price: 0.024 },
    { model: "gpt-4o", provider: "openai", input_price: 0.005, output_price: 0.015, cached_input_price: 0.0025 },
    { model: "openclaw-connector", provider: "openclaw", input_price: 0.001, output_price: 0.002 },
    { model: "mock-executor", provider: "tiangong-mock", input_price: 0, output_price: 0 },
  ];

  let inserted = 0;
  let skipped = 0;
  for (const s of seeds) {
    try {
      await conn.execute(
        `INSERT INTO model_pricing (model, provider, input_price, output_price, cached_input_price) VALUES (?, ?, ?, ?, ?)`,
        [s.model, s.provider, s.input_price, s.output_price, s.cached_input_price ?? null]
      );
      inserted++;
    } catch (e: any) {
      if (e?.code === "ER_DUP_ENTRY" || e?.message?.includes("Duplicate entry")) {
        skipped++;
      } else {
        logs.push(`pricing seed ${s.model}: ${e.message?.slice(0, 80)}`);
      }
    }
  }
  logs.push(`Model pricing seeded: ${inserted} inserted, ${skipped} skipped`);
}

/**
 * Seed MCP API keys from environment variables.
 * Only inserts if the mcp_api_keys table is empty.
 * Environment variables:
 *   TIANGONG_MEIZHIZI_MCP_KEY - MCP Key for agent 1 (美智子)
 *   TIANGONG_CODEMASTER_MCP_KEY - MCP Key for agent 2 (编程大师)
 */
async function migrateAgentMcpToken(conn: mysql.Connection, logs: string[]) {
  try {
    await conn.execute(
      `ALTER TABLE agents ADD COLUMN mcp_token VARCHAR(100) NULL`
    );
    logs.push("agents.mcp_token: ADDED");
  } catch (e: any) {
    if (e?.code === "ER_DUP_FIELD_NAME" || e?.message?.includes("Duplicate column")) {
      logs.push("agents.mcp_token: already exists");
    } else {
      logs.push(`agents.mcp_token: ${e.message?.slice(0, 80)}`);
    }
  }
}

async function syncAgentMcpTokens(conn: mysql.Connection, logs: string[]) {
  // Build token map from env vars and secrets file
  const tokenMap = new Map<number, string>(); // agentId -> token

  // 1. From env vars: TIANGONG_<NAME>_MCP_KEY (need to map name to agentId)
  const envKeyMap: Record<string, number> = {
    MEIZHIZI: 1,
    CODEMASTER: 2,
    SHANGGUAN: 4,
    QIONGXIAO: 6,
    YUNXIAO: 7,
    WEIZI: 8,
    MEICHENGZI: 9,
    JINGWEI: 10,
    BIXIAO: 12,
    XIHE: 13,
    HOUTU: 14,
    ERIYI: 15,
  };
  for (const [name, id] of Object.entries(envKeyMap)) {
    const val = process.env[`TIANGONG_${name}_MCP_KEY`];
    if (val) tokenMap.set(id, val.trim());
  }

  // 2. From secrets file (local/dev)
  try {
    const raw = readFileSync("/home/node/.openclaw/secrets/tiangong-openclaw-agents.json", "utf-8");
    const data = JSON.parse(raw);
    const agentList = Array.isArray(data) ? data : data.agents || [];
    for (const a of agentList) {
      if (a.agentId && a.token) tokenMap.set(Number(a.agentId), String(a.token).trim());
    }
  } catch {
    // secrets file may not exist
  }

  if (tokenMap.size === 0) {
    logs.push("MCP token sync: no tokens found, skipping");
    return;
  }

  let updated = 0;
  for (const [agentId, token] of tokenMap) {
    try {
      await conn.execute(
        `UPDATE agents SET mcp_token = ? WHERE id = ?`,
        [token, agentId]
      );
      updated++;
    } catch (e: any) {
      logs.push(`MCP token sync agent ${agentId}: ${e.message?.slice(0, 60)}`);
    }
  }
  logs.push(`MCP token sync: ${updated}/${tokenMap.size} agents updated`);
}

async function seedMcpKeys(conn: mysql.Connection, logs: string[]) {
  // MCP Keys 从环境变量读取，不再硬编码
  // 环境变量：TIANGONG_MEIZHIZI_MCP_KEY, TIANGONG_CODEMASTER_MCP_KEY 等
  const keyDefs = [
    { envVar: "TIANGONG_MEIZHIZI_MCP_KEY", agentId: 1, name: "美智子 Connector" },
    { envVar: "TIANGONG_CODEMASTER_MCP_KEY", agentId: 2, name: "编程大师 Connector" },
  ];
  const keys = keyDefs
    .filter(d => process.env[d.envVar])
    .map(d => ({ key: process.env[d.envVar]!, agentId: d.agentId, name: d.name }));

  if (keys.length === 0) {
    logs.push("MCP keys: no env vars set, skipping");
    return;
  }

  try {
    // Check if keys already exist
    const existing = await conn.execute("SELECT COUNT(*) as cnt FROM mcp_api_keys");
    const count = (existing as any)[0]?.[0]?.cnt ?? 0;
    if (count > 0) {
      logs.push(`MCP keys: ${count} already exist, skipping`);
      return;
    }

    let inserted = 0;
    for (const k of keys) {
      await conn.execute(
        "INSERT IGNORE INTO mcp_api_keys (`key`, agent_id, name, active, rate_limit) VALUES (?, ?, ?, 'true', 10)",
        [k.key, k.agentId, k.name]
      );
      inserted++;
    }

    logs.push(`MCP keys seeded: ${inserted} inserted`);
  } catch (e: any) {
    logs.push(`MCP keys seed failed: ${e.message?.slice(0, 80)}`);
  }
}

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

    await migrateMailboxColumns(conn, logs);
    await migrateP13Columns(conn, logs);
    await migrateExternalTaskIdentity(conn, logs);
    await migrateAgentMcpToken(conn, logs);
    await seedModelPricing(conn, logs);

    // Seed MCP API keys from environment variables
    await seedMcpKeys(conn, logs);

    // Sync agent MCP tokens from secrets file (local) or env vars
    await syncAgentMcpTokens(conn, logs);

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
