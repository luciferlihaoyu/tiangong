import "dotenv/config";

function optional(name: string, defaultValue: string = ""): string {
  return process.env[name] ?? defaultValue;
}

export const env = {
  // 数据库连接（可选：没设也能启动，API 调用时才会报错）
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
