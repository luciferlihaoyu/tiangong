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
};
