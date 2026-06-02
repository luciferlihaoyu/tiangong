import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value && process.env.NODE_ENV === "production") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value ?? "";
}

function optional(name: string, defaultValue: string = ""): string {
  return process.env[name] ?? defaultValue;
}

export const env = {
  // 必需：数据库连接
  databaseUrl: required("DATABASE_URL"),

  // 必需：JWT 密钥（用于认证令牌签名）
  appSecret: optional("APP_SECRET", "tiangong-default-secret-change-me"),

  // 可选：管理员账号
  adminUser: optional("ADMIN_USER", "admin"),
  adminPassword: optional("ADMIN_PASSWORD", "admin"),

  // 可选：OAuth 配置（仅在使用外部认证时需要）
  appId: optional("APP_ID"),
  kimiAuthUrl: optional("KIMI_AUTH_URL"),
  kimiOpenUrl: optional("KIMI_OPEN_URL"),
  ownerUnionId: optional("OWNER_UNION_ID"),

  isProduction: process.env.NODE_ENV === "production",
};
