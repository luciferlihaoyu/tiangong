/**
 * 启动时自动建表 — SQLite 方言
 *
 * S2 (PLAN_SQLITE_MIGRATION): DDL 已从 MySQL 切到 SQLite。列名、主键、唯一键
 * 与 db/schema.ts 一致；时间戳列用 INTEGER（unixepoch 缺省），与 drizzle
 * `integer({mode:"timestamp"})` 语义对齐；JSON 用 TEXT；ENUM 用 TEXT + CHECK。
 *
 * 运行机制：启动时在 node:sqlite DatabaseSync 上批量 exec（见 api/boot.ts）。
 * 通过 Drizzle 路径读写时，列类型亲和性由 SQLite 负责；drizzle 在 INSERT
 * 时把 Date 转成 epoch 秒整数（unixepoch 同语义）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import fs from "node:fs";
import { env } from "./env";

const CREATE_TABLES_SQL: string[] = [
  // ─── users ───
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    name TEXT,
    email TEXT,
    role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    last_sign_in_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,

  // ─── agents ───
  `CREATE TABLE IF NOT EXISTS agents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    "system" TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('online','busy','idle')),
    task TEXT,
    progress INTEGER NOT NULL DEFAULT 0,
    messages_count INTEGER NOT NULL DEFAULT 0,
    description TEXT,
    created_by INTEGER,
    source TEXT DEFAULT 'custom',
    model TEXT,
    role TEXT,
    manages TEXT,
    reports_to INTEGER,
    org_id INTEGER,
    department_id INTEGER,
    current_task TEXT,
    capabilities TEXT,
    budget_cents INTEGER DEFAULT 0,
    spent_cents INTEGER DEFAULT 0,
    last_heartbeat INTEGER,
    source_api_key TEXT,
    source_endpoint TEXT,
    agent_card TEXT,
    openclaw_agent TEXT,
    can_modify_tiangong_core TEXT DEFAULT 'false' CHECK (can_modify_tiangong_core IN ('true','false')),
    can_send_external_message TEXT DEFAULT 'false' CHECK (can_send_external_message IN ('true','false')),
    mcp_token TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,

  // ─── tasks ───
  `CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    agent_id INTEGER,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('running','pending','done','failed','queued')),
    progress INTEGER NOT NULL DEFAULT 0,
    description TEXT,
    priority INTEGER DEFAULT 0,
    input TEXT,
    output TEXT,
    error TEXT,
    retry_count INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 3,
    timeout_ms INTEGER DEFAULT 300000,
    parent_task_id INTEGER,
    expected_output_schema TEXT,
    output_valid TEXT DEFAULT 'unknown' CHECK (output_valid IN ('true','false','unknown')),
    lifecycle_status TEXT DEFAULT 'created',
    dispatcher_agent_id INTEGER,
    claimed_at INTEGER,
    dispatched_at INTEGER,
    accepted_at INTEGER,
    completed_at INTEGER,
    failed_at INTEGER,
    timeout_at INTEGER,
    -- Phase 2: Taskboard status machine (board_status ... blocked_at, 与 schema.ts 对齐)
    board_status TEXT DEFAULT 'triage',
    board_labels TEXT,
    board_notes TEXT,
    source_url TEXT,
    last_heartbeat_at INTEGER,
    heartbeat_interval_ms INTEGER DEFAULT 300000,
    reviewer_id INTEGER,
    review_result TEXT,
    triaged_at INTEGER,
    backlogged_at INTEGER,
    ready_at INTEGER,
    review_at INTEGER,
    blocked_at INTEGER,
    worker_lease_token TEXT,
    worker_lease_generation INTEGER NOT NULL DEFAULT 0,
    worker_lease_expires_at INTEGER,
    cancel_requested_at INTEGER,
    cancel_acknowledged_at INTEGER,
    origin_system TEXT,
    external_ref TEXT,
    idempotency_key TEXT,
    canonical_request_hash TEXT,
    canonical_request_hash_version TEXT,
    state_revision INTEGER NOT NULL DEFAULT 1,
    task_retain_until INTEGER,
    idempotency_retain_until INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  // tasks 唯一索引（与 schema.ts uq_tasks_origin_* 对齐；保留原名以兼容守卫测试）
  `CREATE UNIQUE INDEX uq_tasks_origin_external_ref ON tasks(origin_system, external_ref)`,
  `CREATE UNIQUE INDEX uq_tasks_origin_idempotency_key ON tasks(origin_system, idempotency_key)`,

  // ─── tiangong_task_limits ───
  `CREATE TABLE IF NOT EXISTS tiangong_task_limits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    principal_key TEXT NOT NULL,
    workspace_slug TEXT NOT NULL,
    max_concurrent_tasks INTEGER NOT NULL DEFAULT 8,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE UNIQUE INDEX uq_tiangong_task_limits_principal_workspace ON tiangong_task_limits(principal_key, workspace_slug)`,

  // ─── task_execution_slots ───
  `CREATE TABLE IF NOT EXISTS task_execution_slots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    principal_key TEXT NOT NULL,
    workspace_slug TEXT NOT NULL,
    lease_token TEXT NOT NULL,
    acquired_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE UNIQUE INDEX uq_task_execution_slots_task ON task_execution_slots(task_id)`,
  `CREATE INDEX idx_task_execution_slots_scope ON task_execution_slots(principal_key, workspace_slug, expires_at)`,

  // ─── tiangong_worker_leases ───
  `CREATE TABLE IF NOT EXISTS tiangong_worker_leases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lease_token TEXT NOT NULL UNIQUE,
    worker_id TEXT NOT NULL,
    principal_key TEXT NOT NULL,
    workspace_slug TEXT NOT NULL,
    generation INTEGER NOT NULL,
    issued_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER
  )`,
  `CREATE INDEX idx_tiangong_worker_leases_worker_scope ON tiangong_worker_leases(worker_id, principal_key, workspace_slug, expires_at)`,

  // ─── task_outbox_events ───
  `CREATE TABLE IF NOT EXISTS task_outbox_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    task_id INTEGER NOT NULL,
    task_public_id TEXT NOT NULL,
    external_ref TEXT NOT NULL,
    origin_system TEXT NOT NULL,
    workspace_slug TEXT NOT NULL,
    project_slug TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN ('state','approval','terminal')),
    status TEXT NOT NULL,
    lifecycle_status TEXT,
    board_status TEXT,
    review_result TEXT,
    state_revision INTEGER NOT NULL,
    trace_id TEXT NOT NULL,
    payload_digest TEXT NOT NULL,
    manifest_identity TEXT,
    key_id TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL,
    first_attempt_at INTEGER,
    delivered_at INTEGER,
    dead_letter_at INTEGER,
    last_error_code TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE UNIQUE INDEX uq_task_outbox_task_revision ON task_outbox_events(task_id, state_revision)`,
  `CREATE INDEX idx_task_outbox_due ON task_outbox_events(next_attempt_at, delivered_at, dead_letter_at)`,

  // ─── tiangong_provider_identity ───
  `CREATE TABLE IF NOT EXISTS tiangong_provider_identity (
    provider_instance_id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,

  // ─── tiangong_artifact_limits ───
  `CREATE TABLE IF NOT EXISTS tiangong_artifact_limits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    principal_key TEXT NOT NULL,
    workspace_slug TEXT NOT NULL,
    storage_quota_bytes INTEGER NOT NULL,
    retention_seconds INTEGER NOT NULL,
    gc_grace_seconds INTEGER NOT NULL,
    gc_reaper_concurrency INTEGER NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE UNIQUE INDEX uq_tiangong_artifact_limits_scope ON tiangong_artifact_limits(principal_key, workspace_slug)`,

  // ─── staged_objects ───
  `CREATE TABLE IF NOT EXISTS staged_objects (
    stage_id TEXT PRIMARY KEY,
    expected_sha256 TEXT NOT NULL,
    expected_size INTEGER NOT NULL,
    expected_mime TEXT NOT NULL,
    generation_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    owner_principal TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'staging' CHECK (state IN ('staging','verified','sealed','abandoned'))
  )`,

  // ─── sealed_artifact_descriptors ───
  `CREATE TABLE IF NOT EXISTS sealed_artifact_descriptors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    artifact_uuid TEXT NOT NULL,
    task_id INTEGER NOT NULL,
    task_public_id TEXT NOT NULL,
    external_ref TEXT NOT NULL,
    task_revision INTEGER NOT NULL,
    creator_agent_id INTEGER,
    owner_principal TEXT NOT NULL,
    workspace_slug TEXT NOT NULL,
    project_slug TEXT NOT NULL,
    provider_instance_id TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    generation_id INTEGER NOT NULL,
    size INTEGER NOT NULL,
    mime TEXT NOT NULL,
    stored_path TEXT NOT NULL,
    sealed_at INTEGER NOT NULL,
    retain_until INTEGER NOT NULL
  )`,
  `CREATE UNIQUE INDEX uq_sealed_artifact_task_uuid ON sealed_artifact_descriptors(task_id, artifact_uuid)`,
  `CREATE INDEX idx_sealed_artifact_task_revision ON sealed_artifact_descriptors(task_id, task_revision)`,

  // ─── sealed_artifact_manifests ───
  `CREATE TABLE IF NOT EXISTS sealed_artifact_manifests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL UNIQUE,
    task_public_id TEXT NOT NULL,
    external_ref TEXT NOT NULL,
    task_revision INTEGER NOT NULL,
    provider_instance_id TEXT NOT NULL,
    manifest_identity TEXT NOT NULL UNIQUE,
    canonical_manifest TEXT NOT NULL,
    sealed_at INTEGER NOT NULL
  )`,

  // ─── task_dependencies ───
  `CREATE TABLE IF NOT EXISTS task_dependencies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    depends_on_task_id INTEGER NOT NULL
  )`,

  // ─── messages (P8.1) ───
  `CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_agent INTEGER NOT NULL,
    to_agent INTEGER NOT NULL,
    content TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'command' CHECK (type IN ('command','response','broadcast','system','ack')),
    status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','delivered','read','acked','expired')),
    read_at INTEGER,
    conversation_id INTEGER,
    correlation_id TEXT,
    idempotency_key TEXT,
    task_id INTEGER,
    parent_message_id INTEGER,
    expires_at INTEGER,
    acked_at INTEGER,
    delivered_at INTEGER,
    retry_count INTEGER NOT NULL DEFAULT 0,
    priority INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE UNIQUE INDEX uq_messages_idempotency ON messages(from_agent, idempotency_key)`,

  // ─── systems ───
  `CREATE TABLE IF NOT EXISTS systems (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'disconnected' CHECK (status IN ('connected','syncing','disconnected')),
    config TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,

  // ─── organizations ───
  `CREATE TABLE IF NOT EXISTS organizations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    goals TEXT,
    budget_cents INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,

  // ─── departments ───
  `CREATE TABLE IF NOT EXISTS departments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    org_id INTEGER NOT NULL,
    lead_agent_id INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,

  // ─── mcp_api_keys ───
  `CREATE TABLE IF NOT EXISTS mcp_api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    "key" TEXT NOT NULL UNIQUE,
    agent_id INTEGER,
    name TEXT,
    permissions TEXT,
    rate_limit INTEGER DEFAULT 10,
    active TEXT DEFAULT 'true' CHECK (active IN ('true','false')),
    last_used_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,

  // ─── mcp_audit_log ───
  `CREATE TABLE IF NOT EXISTS mcp_audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key_id INTEGER,
    tool TEXT,
    params TEXT,
    result TEXT,
    error TEXT,
    duration_ms INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,

  // ─── tiangong_service_keys (Todo 20) ───
  `CREATE TABLE IF NOT EXISTS tiangong_service_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key_id TEXT NOT NULL UNIQUE,
    verifier TEXT NOT NULL,
    key_prefix TEXT NOT NULL,
    origin_system TEXT NOT NULL DEFAULT 'beidou',
    workspace_slug TEXT NOT NULL,
    project_slug TEXT NOT NULL,
    scopes TEXT NOT NULL,
    issued_at INTEGER NOT NULL,
    rotation_window_end INTEGER,
    revoked_at INTEGER,
    revoked_reason TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE UNIQUE INDEX uq_tiangong_service_keys_key_id ON tiangong_service_keys(key_id)`,

  // ─── service_key_audit_log (Todo 20) ───
  `CREATE TABLE IF NOT EXISTS service_key_audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key_id TEXT,
    origin_system TEXT,
    token_prefix TEXT,
    decision TEXT NOT NULL CHECK (decision IN ('authenticated','denied')),
    reason TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,

  // ─── model_pricing (P13) ───
  `CREATE TABLE IF NOT EXISTS model_pricing (
    model TEXT PRIMARY KEY,
    provider TEXT DEFAULT 'unknown',
    input_price TEXT NOT NULL DEFAULT '0',
    output_price TEXT NOT NULL DEFAULT '0',
    cached_input_price TEXT,
    currency TEXT DEFAULT 'USD',
    notes TEXT,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,

  // ─── system_settings ───
  `CREATE TABLE IF NOT EXISTS system_settings (
    "key" TEXT PRIMARY KEY,
    value TEXT,
    category TEXT DEFAULT 'general',
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,

  // ─── token_usage (P9 + P13) ───
  `CREATE TABLE IF NOT EXISTS token_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    model TEXT NOT NULL,
    provider TEXT DEFAULT 'unknown',
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    cached_prompt_tokens INTEGER DEFAULT 0,
    uncached_prompt_tokens INTEGER DEFAULT 0,
    call_count INTEGER NOT NULL DEFAULT 1,
    cost_cents INTEGER NOT NULL DEFAULT 0,
    cost_micros INTEGER NOT NULL DEFAULT 0,
    currency TEXT DEFAULT 'USD',
    exchange_rate TEXT DEFAULT '1.0',
    cost_display TEXT DEFAULT '0',
    task_id INTEGER,
    agent_id INTEGER,
    session_key TEXT,
    source TEXT DEFAULT 'manual',
    trace_id TEXT,
    started_at INTEGER,
    high_cost_model TEXT DEFAULT 'false' CHECK (high_cost_model IN ('true','false')),
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,

  // ─── model_allowlist (Phase 2) ───
  `CREATE TABLE IF NOT EXISTS model_allowlist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id INTEGER NOT NULL,
    model TEXT NOT NULL,
    reason TEXT,
    created_by TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,

  // ─── high_cost_model_auth (Phase 2) ───
  `CREATE TABLE IF NOT EXISTS high_cost_model_auth (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id INTEGER NOT NULL,
    model TEXT NOT NULL,
    reason TEXT NOT NULL,
    authorized_by TEXT NOT NULL,
    expires_at INTEGER,
    active TEXT DEFAULT 'true' CHECK (active IN ('true','false')),
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,

  // ─── P11: GitHub App integration ───
  `CREATE TABLE IF NOT EXISTS github_integrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    app_id TEXT,
    installation_id TEXT,
    owner TEXT,
    active TEXT DEFAULT 'true' CHECK (active IN ('true','false')),
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,

  `CREATE TABLE IF NOT EXISTS github_repos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner TEXT NOT NULL,
    name TEXT NOT NULL,
    full_name TEXT NOT NULL,
    default_branch TEXT DEFAULT 'main',
    installation_id INTEGER,
    active TEXT DEFAULT 'true' CHECK (active IN ('true','false')),
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,

  `CREATE TABLE IF NOT EXISTS github_repo_permissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id INTEGER NOT NULL,
    repo_id INTEGER NOT NULL,
    permission_level TEXT NOT NULL DEFAULT 'read' CHECK (permission_level IN ('read','push','admin')),
    active TEXT DEFAULT 'true' CHECK (active IN ('true','false')),
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,

  `CREATE TABLE IF NOT EXISTS github_pull_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_id INTEGER NOT NULL,
    pr_number INTEGER NOT NULL,
    title TEXT NOT NULL,
    body TEXT,
    branch_name TEXT,
    base_branch TEXT,
    head_sha TEXT,
    author_agent_id INTEGER,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','merged','closed')),
    approved_by INTEGER,
    approved_at INTEGER,
    merged_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,

  `CREATE TABLE IF NOT EXISTS github_audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pr_id INTEGER,
    action TEXT NOT NULL CHECK (action IN ('approve','reject','merge','register','revoke')),
    agent_id INTEGER,
    reason TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,

  // ─── task_threads (A2A-lite v0.1) ───
  `CREATE TABLE IF NOT EXISTS task_threads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    title TEXT,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','archived')),
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,

  // ─── task_messages (A2A-lite v0.1) ───
  `CREATE TABLE IF NOT EXISTS task_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    thread_id INTEGER,
    from_agent_id INTEGER,
    to_agent_id INTEGER,
    event_type TEXT NOT NULL DEFAULT 'system' CHECK (event_type IN ('dispatch','ack','progress','working','result','error','timeout','cancel','system')),
    content TEXT,
    metadata TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,

  // ─── task_artifacts (A2A-lite v0.1) ───
  `CREATE TABLE IF NOT EXISTS task_artifacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    agent_id INTEGER,
    type TEXT NOT NULL,
    name TEXT,
    content TEXT,
    json_payload TEXT,
    mime_type TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,

  // ─── mailbox_messages (A2A-lite v0.1) ───
  // 列名直接用 mailbox_type / mailbox_status（与 db/schema.ts 对齐）；
  // 旧版"type/status"在 MySQL 阶段已通过迁移脚本改名为新名（V2 历史路径）。
  `CREATE TABLE IF NOT EXISTS mailbox_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER,
    thread_id INTEGER,
    from_agent_id INTEGER,
    from_mailbox_id TEXT NOT NULL,
    to_agent_id INTEGER NOT NULL,
    to_mailbox_id TEXT NOT NULL,
    mailbox_type TEXT NOT NULL DEFAULT 'direct' CHECK (mailbox_type IN ('direct','mention','question','review_request','subtask','handoff','result_notice')),
    mailbox_status TEXT NOT NULL DEFAULT 'unread' CHECK (mailbox_status IN ('unread','acknowledged','working','replied','resolved','failed')),
    subject TEXT,
    body TEXT,
    payload_json TEXT,
    reply_to_message_id INTEGER,
    artifact_id INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    acknowledged_at INTEGER,
    replied_at INTEGER,
    resolved_at INTEGER,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,

  // ─── audit_events (Phase 1) ───
  `CREATE TABLE IF NOT EXISTS audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event TEXT NOT NULL,
    actor_user_id INTEGER NOT NULL,
    workspace_id INTEGER,
    project_id INTEGER,
    target_user_id INTEGER,
    entity_type TEXT NOT NULL,
    entity_id INTEGER,
    metadata TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    prev_hash TEXT,
    hash TEXT
  )`,
  `CREATE INDEX idx_audit_events_created_at ON audit_events(created_at)`,

  // ─── connector_registry (Phase 1) ───
  `CREATE TABLE IF NOT EXISTS connector_registry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL,
    project_id INTEGER,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    connector_type TEXT NOT NULL CHECK (connector_type IN ('opencode','xuanji','s3')),
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','disabled')),
    endpoint TEXT,
    config TEXT,
    secret_ref_id INTEGER,
    created_by INTEGER NOT NULL,
    updated_by INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE UNIQUE INDEX uq_connector_registry_workspace_project_slug ON connector_registry(workspace_id, project_id, slug)`,

  // ─── artifact_registry (Phase 1) ───
  `CREATE TABLE IF NOT EXISTS artifact_registry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL,
    project_id INTEGER,
    task_id INTEGER,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    artifact_type TEXT NOT NULL CHECK (artifact_type IN ('file','image','document','log','data')),
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','archived','deleted')),
    mime_type TEXT,
    size_bytes INTEGER,
    checksum_sha256 TEXT,
    storage_backref_type TEXT CHECK (storage_backref_type IN ('connector','inline','external')),
    storage_backref_id TEXT,
    metadata TEXT,
    created_by INTEGER NOT NULL,
    updated_by INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE UNIQUE INDEX uq_artifact_registry_workspace_project_slug ON artifact_registry(workspace_id, project_id, slug)`,

  // ─── conversations ───
  `CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'ad_hoc' CHECK (type IN ('mission','meeting','test','ad_hoc')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
    participants TEXT,
    summary TEXT,
    created_by INTEGER,
    archived_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,

  // ─── notifications (NC-1) ───
  `CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('task_approved','task_rejected','task_completed','task_failed','lesson_recorded','budget_exhausted')),
    task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    metadata TEXT,
    read_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE INDEX idx_notifications_agent_read ON notifications(agent_id, read_at)`,
  `CREATE INDEX idx_notifications_created_at ON notifications(created_at)`,

  // ─── workspaces (Phase 1) ───
  `CREATE TABLE IF NOT EXISTS workspaces (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    description TEXT,
    owner_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,

  // ─── projects (Phase 1) ───
  `CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    description TEXT,
    created_by INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE UNIQUE INDEX uq_projects_workspace_slug ON projects(workspace_id, slug)`,

  // ─── workspace_memberships (Phase 1) ───
  `CREATE TABLE IF NOT EXISTS workspace_memberships (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','member','viewer')),
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE UNIQUE INDEX uq_workspace_memberships ON workspace_memberships(workspace_id, user_id)`,

  // ─── secret_vault_items (Phase 1) ───
  `CREATE TABLE IF NOT EXISTS secret_vault_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL,
    project_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    algorithm TEXT NOT NULL,
    key_id TEXT NOT NULL,
    envelope_version TEXT NOT NULL,
    nonce TEXT NOT NULL,
    auth_tag TEXT NOT NULL,
    ciphertext TEXT NOT NULL,
    created_by INTEGER NOT NULL,
    updated_by INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE UNIQUE INDEX uq_secret_vault_items_project_name ON secret_vault_items(workspace_id, project_id, name)`,

  // ─── shared_sessions (Phase 3) ───
  `CREATE TABLE IF NOT EXISTS shared_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    session_key TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL DEFAULT 'adhoc' CHECK (type IN ('collaboration','handoff','meeting','review','adhoc')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
    participants TEXT,
    summary TEXT,
    context TEXT,
    created_by INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,

  // ─── session_messages (Phase 3) ───
  `CREATE TABLE IF NOT EXISTS session_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    from_agent_id INTEGER,
    to_agent_id INTEGER,
    role TEXT NOT NULL DEFAULT 'assistant' CHECK (role IN ('user','assistant','system')),
    content TEXT NOT NULL,
    metadata TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,

  // ─── agent_memories (Phase 3) ───
  `CREATE TABLE IF NOT EXISTS agent_memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id INTEGER NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'personal' CHECK (type IN ('personal','shared','company')),
    tags TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE UNIQUE INDEX uq_agent_memories_key ON agent_memories(agent_id, key)`,

  // ─── external_agents (Phase 3) ───
  `CREATE TABLE IF NOT EXISTS external_agents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    platform TEXT NOT NULL CHECK (platform IN ('hermes','opencode','codex','arkclaw','openai','custom')),
    endpoint TEXT,
    api_key TEXT,
    model TEXT,
    status TEXT NOT NULL DEFAULT 'offline' CHECK (status IN ('online','offline','error')),
    capabilities TEXT,
    config TEXT,
    last_heartbeat INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,

  // ─── plugins (P2-1 插件中心，与 db/schema.ts 对齐) ───
  `CREATE TABLE IF NOT EXISTS plugins (
    "key" TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    url TEXT NOT NULL,
    token_env_key TEXT,
    enabled INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
];

/**
 * S2: 历史一次性迁移函数全部退化为 no-op。
 *
 * 原因：S1 schema/connection 切到 SQLite 后，auto-migrate 已直接以最新 schema 建表
 * （包含 P8.1 / P13 / external task identity / agents.mcp_token / mailbox 重命名列
 * / P11 / Phase 2 模型白名单与高价模型授权 / Phase 1 workspaces 等所有列）。
 * 这些函数原本是给 MySQL 旧版"列已建、需 ALTER 补列"用的；SQLite fresh-install
 * 路径下没有任何待补列。
 *
 * 保留函数签名（migrateMailboxColumns / migrateP13Columns / migrateExternalTaskIdentity
 * / migrateAgentMcpToken / syncAgentMcpTokens）是为了让 boot.ts 的调用点不报错；
 * 它们全部立即返回并在 logs 里标记"no-op"。
 */
function migrateMailboxColumns(_db: unknown, logs: string[]): void {
  logs.push("mailbox_messages: no-op (auto-migrate creates mailbox_type/mailbox_status directly)");
}

function migrateP13Columns(_db: unknown, logs: string[]): void {
  logs.push("token_usage: no-op (auto-migrate creates all P13 columns directly)");
}

function migrateExternalTaskIdentity(_db: unknown, logs: string[]): void {
  logs.push("tasks: no-op (auto-migrate creates external identity + lease columns and uq_tasks_origin_* indexes directly)");
}

function migrateAgentMcpToken(_db: unknown, logs: string[]): void {
  logs.push("agents: no-op (auto-migrate creates mcp_token column directly)");
}

function syncAgentMcpTokens(_db: unknown, logs: string[]): void {
  // S2: SQLite 路径下，MCP token 同步仍然有效（写入 agents.mcp_token）——保留
  // 实现，但走 drizzle/better-sqlite3 通道而非 mysql2。S2 实现：保持行为兼容
  // （env 读 + secrets 文件读 + UPDATE agents SET mcp_token = ?），仅改连接。
  void logs; // logs 在下面 callers 里统一 push
  // 此函数体由 syncAgentMcpTokensViaDrizzle 实际填充
}

/**
 * S2: 用 node:sqlite DatabaseSync 直接执行 MCP token 同步。
 * 不走 drizzle，因为这是一次性运维种子而非业务查询。
 */
function syncAgentMcpTokensViaSqlite(db: import("node:sqlite").DatabaseSync, logs: string[]): void {
  const tokenMap = new Map<number, string>(); // agentId -> token

  // 1. From env vars
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

  // 2. From secrets file
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
  // node:sqlite StatementSync.run 返回 { changes, lastInsertRowid }，
  // 与 better-sqlite3 RunResult 同形。
  const stmt = db.prepare("UPDATE agents SET mcp_token = ? WHERE id = ?");
  for (const [agentId, token] of tokenMap) {
    try {
      stmt.run(token, agentId);
      updated++;
    } catch (e: any) {
      logs.push(`MCP token sync agent ${agentId}: ${e.message?.slice(0, 60)}`);
    }
  }
  logs.push(`MCP token sync: ${updated}/${tokenMap.size} agents updated`);
}

/**
 * 种子：model_pricing 行。
 * S2: 用 better-sqlite3 RunResult.changes 判断"已存在则跳过"，不再依赖 MySQL
 * `ER_DUP_ENTRY` 错误码。
 */
function seedModelPricing(db: import("node:sqlite").DatabaseSync, logs: string[]): void {
  const seeds = [
    { model: "deepseek-v4-flash", provider: "deepseek-official", input_price: "0.0003", output_price: "0.0006", cached_input_price: "0.000075" },
    { model: "deepseek-reasoner", provider: "deepseek-official", input_price: "0.002", output_price: "0.008", cached_input_price: "0.0005" },
    { model: "deepseek-v3.2", provider: "zeabur-ai", input_price: "0.0005", output_price: "0.0015", cached_input_price: null },
    { model: "deepseek-v4-pro", provider: "deepseek-official", input_price: "0.002", output_price: "0.008", cached_input_price: "0.0005" },
    { model: "kimi-for-coding", provider: "kimi-code", input_price: "0.004", output_price: "0.012", cached_input_price: null },
    { model: "MiniMax-M3", provider: "minimax-cn", input_price: "0.002", output_price: "0.008", cached_input_price: null },
    { model: "MiniMax-M2.7", provider: "minimax-cn", input_price: "0.001", output_price: "0.004", cached_input_price: null },
    { model: "claude-opus-4-8", provider: "anthropic", input_price: "0.015", output_price: "0.075", cached_input_price: "0.0075" },
    { model: "claude-fable-5", provider: "anthropic", input_price: "0.003", output_price: "0.015", cached_input_price: "0.0003" },
    { model: "ark-code-latest", provider: "volcengine-plan", input_price: "0.002", output_price: "0.008", cached_input_price: null },
    { model: "qwen3.6-plus", provider: "bailian", input_price: "0.002", output_price: "0.008", cached_input_price: null },
    { model: "doubao-seedream-5-0-260128", provider: "volcengine", input_price: "0.008", output_price: "0.024", cached_input_price: null },
    { model: "gpt-4o", provider: "openai", input_price: "0.005", output_price: "0.015", cached_input_price: "0.0025" },
    { model: "openclaw-connector", provider: "openclaw", input_price: "0.001", output_price: "0.002", cached_input_price: null },
    { model: "mock-executor", provider: "tiangong-mock", input_price: "0", output_price: "0", cached_input_price: null },
  ];

  let inserted = 0;
  let skipped = 0;
  const stmt = db.prepare(
    "INSERT INTO model_pricing (model, provider, input_price, output_price, cached_input_price) VALUES (?, ?, ?, ?, ?)"
  );
  for (const s of seeds) {
    try {
      const r = stmt.run(
        s.model,
        s.provider,
        s.input_price,
        s.output_price,
        s.cached_input_price
      );
      if (r.changes > 0) inserted++;
      else skipped++;
    } catch (e: any) {
      if (e?.message?.includes("UNIQUE constraint failed") || e?.message?.includes("duplicate")) {
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
 * S2: 用 INSERT OR IGNORE 替代 MySQL 的 INSERT IGNORE 语法。
 */
function seedMcpKeys(db: import("node:sqlite").DatabaseSync, logs: string[]): void {
  const keyDefs = [
    { envVar: "TIANGONG_MEIZHIZI_MCP_KEY", agentId: 1, name: "美智子 Connector" },
    { envVar: "TIANGONG_CODEMASTER_MCP_KEY", agentId: 2, name: "编程大师 Connector" },
  ];
  const keys = keyDefs
    .filter((d) => process.env[d.envVar])
    .map((d) => ({ key: process.env[d.envVar]!, agentId: d.agentId, name: d.name }));

  if (keys.length === 0) {
    logs.push("MCP keys: no env vars set, skipping");
    return;
  }

  try {
    // Check if keys already exist
    const existingRows = db.prepare("SELECT COUNT(*) AS cnt FROM mcp_api_keys").all() as Array<{ cnt: number }>;
    const count = Number(existingRows?.[0]?.cnt ?? 0);
    if (count > 0) {
      logs.push(`MCP keys: ${count} already exist, skipping`);
      return;
    }

    let inserted = 0;
    const stmt = db.prepare(
      "INSERT OR IGNORE INTO mcp_api_keys (key, agent_id, name, active, rate_limit) VALUES (?, ?, ?, 'true', 10)"
    );
    for (const k of keys) {
      stmt.run(k.key, k.agentId, k.name);
      inserted++;
    }

    logs.push(`MCP keys seeded: ${inserted} inserted`);
  } catch (e: any) {
    logs.push(`MCP keys seed failed: ${e.message?.slice(0, 80)}`);
  }
}

/**
 * 解析 SQLite 文件路径：单一事实源在 connection.ts（resolveDbPath 已导出），
 * 此处直接复用，避免出现两份语义漂移副本（曾因本地副本停留在
 * data/tiangong.db 而 getDb 已迁 artifact 卷，导致建表与读写分离）。
 */
import { resolveDbPath } from "../queries/connection";

function ensureParentDir(filePath: string): void {
  const parent = path.dirname(filePath);
  if (parent && !fs.existsSync(parent)) {
    fs.mkdirSync(parent, { recursive: true });
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

  let db: ReturnType<typeof import("drizzle-orm/better-sqlite3").drizzle> | null = null;
  let sqliteDb: import("node:sqlite").DatabaseSync | null = null;
  try {
    const dbPath = resolveDbPath(env.databaseUrl);
    ensureParentDir(dbPath);
    // node:sqlite 走与 connection.ts 同一适配器，保证 drizzle/better-sqlite3 看到
    // 同一 Database 形状；不直接 require better-sqlite3。
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    sqliteDb = new DatabaseSync(dbPath);

    // S2: 在 SQLite 路径上开启外键约束（默认关闭）。仅影响本次连接的生命周期。
    try {
      sqliteDb.exec("PRAGMA foreign_keys = ON");
    } catch {
      // 旧版 node:sqlite 不支持时静默忽略
    }

    const { drizzle } = await import("drizzle-orm/better-sqlite3");
    const { nodeSqliteAdapter } = await import("./node-sqlite-adapter");
    db = drizzle(nodeSqliteAdapter(sqliteDb), {
      schema: { ...(await import("../../db/schema")) },
    });

    logs.push("Database connected");
    console.log("Database connected, running migrations...");

    for (const sql of CREATE_TABLES_SQL) {
      try {
        // 兼容 CREATE TABLE / CREATE UNIQUE INDEX / CREATE INDEX 三种语句
        const tableName = sql.match(/CREATE\s+(?:TABLE IF NOT EXISTS|UNIQUE\s+INDEX|INDEX)\s+(?:IF NOT EXISTS\s+)?(\w+)/)?.[1] || "unknown";
        const isTable = /CREATE TABLE/.test(sql);
        if (force && isTable) {
          // SQLite 3.8+ 支持 DROP TABLE IF EXISTS
          try {
            sqliteDb.exec(`DROP TABLE IF EXISTS "${tableName}"`);
          } catch {
            // ignore
          }
          const createSql = sql.replace("IF NOT EXISTS ", "");
          sqliteDb.exec(createSql);
          logs.push(`Table ${tableName}: FORCE RECREATED`);
        } else {
          sqliteDb.exec(sql);
          logs.push(`${isTable ? "Table" : "Index"} ${tableName}: OK`);
        }
      } catch (e: any) {
        const tableName = sql.match(/CREATE\s+(?:TABLE IF NOT EXISTS|UNIQUE\s+INDEX|INDEX)\s+(?:IF NOT EXISTS\s+)?(\w+)/)?.[1] || "unknown";
        logs.push(`${tableName}: ${e.message?.slice(0, 80)}`);
        console.warn("Migration statement warning:", e.message?.slice(0, 100));
      }
    }

    // 历史迁移（全部 no-op；保留调用点防止 boot.ts / 测试断链）
    migrateMailboxColumns(db, logs);
    migrateP13Columns(db, logs);
    migrateExternalTaskIdentity(db, logs);
    migrateAgentMcpToken(db, logs);
    seedModelPricing(sqliteDb, logs);
    seedMcpKeys(sqliteDb, logs);
    syncAgentMcpTokensViaSqlite(sqliteDb, logs);

    logs.push(`Auto-migration completed: ${CREATE_TABLES_SQL.length} statements executed`);
    console.log(`Auto-migration completed: ${CREATE_TABLES_SQL.length} statements executed`);
  } catch (e: any) {
    logs.push(`Connection failed: ${e.message}`);
    console.warn("Auto-migration failed:", e.message);
  } finally {
    if (sqliteDb) {
      try {
        sqliteDb.close();
      } catch {
        // ignore
      }
    }
  }
  return logs;
}
