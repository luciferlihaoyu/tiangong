import "dotenv/config";

function optional(name: string, defaultValue: string = ""): string {
  return process.env[name] ?? defaultValue;
}

export const env = {
  // S2 (PLAN_SQLITE_MIGRATION): 数据库连接 — SQLite 文件路径
  //（如 `data/tiangong.db` 或 `:memory:`）。
  // 兼容旧值：若设为 `mysql://...` / `mysql2://...`，connection.ts
  // 的 resolveDbPath 兜底走 `data/tiangong.db`（见 api/queries/connection.ts）。
  databaseUrl: optional("DATABASE_URL"),

  // JWT 密钥
  appSecret: optional("APP_SECRET", "tiangong-default-secret-change-me"),

  // 管理员账号
  adminUser: optional("ADMIN_USER", "admin"),
  adminPassword: optional("ADMIN_PASSWORD", "admin"),

  isProduction: process.env.NODE_ENV === "production",

  // P7: Remote OpenClaw Gateway Runner
  openclawGatewayUrl: optional("TIANGONG_OPENCLAW_GATEWAY_URL"),
  openclawGatewayToken: optional("TIANGONG_OPENCLAW_GATEWAY_TOKEN"),
  openclawGatewayAgent: optional("TIANGONG_OPENCLAW_GATEWAY_AGENT", "codemaster"),
  openclawGatewayModel: optional("TIANGONG_OPENCLAW_GATEWAY_MODEL"),
  openclawGatewaySessionPrefix: optional("TIANGONG_OPENCLAW_GATEWAY_SESSION_PREFIX", "tiangong"),

  // P11: GitHub App Integration
  githubAppId: optional("GITHUB_APP_ID"),
  githubAppPrivateKeyPath: optional("GITHUB_APP_PRIVATE_KEY_PATH"),
  githubAppPrivateKey: optional("GITHUB_APP_PRIVATE_KEY"),
  githubAppPrivateKeyBase64: optional("GITHUB_APP_PRIVATE_KEY_BASE64"),
  githubAppInstallationId: optional("GITHUB_APP_INSTALLATION_ID"),
  githubWebhookSecret: optional("GITHUB_WEBHOOK_SECRET"),

  // Phase 1: Secret Vault encryption key
  secretVaultKey: optional("TIANGONG_SECRET_VAULT_KEY"),
  secretVaultKeyId: optional("TIANGONG_SECRET_VAULT_KEY_ID", "default"),

  // Todo 20: Beidou service key server pepper (deployment secret).
  // The verifier stored in `tiangong_service_keys` is
  // HMAC-SHA-256(TIANGONG_SERVICE_KEY_PEPPER, token); the plaintext token is
  // never stored anywhere. Absent pepper ⇒ fail-closed verification.
  serviceKeyPepper: optional("TIANGONG_SERVICE_KEY_PEPPER"),
  // Rotation overlap retention = max callback retry window (default 24h).
  serviceKeyRotationRetentionMs: optional(
    "TIANGONG_SERVICE_KEY_ROTATION_RETENTION_MS",
    String(24 * 60 * 60 * 1000)
  ),
  callbackBindings: optional("TIANGONG_CALLBACK_BINDINGS", "[]"),
  artifactRoot: optional("TIANGONG_ARTIFACT_ROOT", "/app/data/tiangong-artifacts"),
  artifactVolumeId: optional("TIANGONG_ARTIFACT_VOLUME_ID"),
  artifactGenerationId: optional("TIANGONG_ARTIFACT_GENERATION_ID", "1"),
  tiangongProviderInstanceId: optional("TIANGONG_PROVIDER_INSTANCE_ID"),
};

/**
 * 天枢（New API）网关基础 URL 的**唯一事实源**（§4-③ 配置收敛）。
 * 此前 7 个文件两套硬编码默认互相打架，且 woppis1.zeabur.app 是死域名
 * （/v1/models 404，2026-09-28 实测；Vault 未设 TIANSHU_BASE_URL）。
 * tianshu.xianrealme.com 实测存活且返回合法 new_api payload，作为唯一默认。
 */
export const TIANSHU_DEFAULT_BASE_URL = "https://tianshu.xianrealme.com";

/** 统一取值入口：env 覆盖（去尾斜杠）→ 默认 */
export function tianshuBaseUrlSafe(): string {
  return (process.env.TIANSHU_BASE_URL || TIANSHU_DEFAULT_BASE_URL).replace(/\/+$/, "");
}
