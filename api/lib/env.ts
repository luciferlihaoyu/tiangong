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
};
