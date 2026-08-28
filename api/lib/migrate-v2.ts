/**
 * V2 Migration — S2 (PLAN_SQLITE_MIGRATION) 后已退化为 no-op。
 *
 * 历史职责：MySQL 阶段为已有表补列（agents 新字段、tasks 新字段、token_usage
 * P13 列、mailbox_messages type/status → mailbox_type/mailbox_status 重命名、
 * messages ENUM 扩值、Phase 2 模型白名单/高价模型授权、P11 GitHub 表、审计
 * hash chain 列等）。
 *
 * 当前职责：S1 schema/connection 切到 SQLite 后，api/lib/auto-migrate.ts 已直接
 * 以"最新 schema"建表——所有 V2 需要补的列/索引/重命名都已内联到 CREATE TABLE
 * 语句中（包括 mailbox_type/mailbox_status 列名直接用新名）。S2 fresh-install
 * 路径下没有任何待补列。`migrateV2(force)` 保留函数签名以避免 boot.ts / admin
 * 端点 / 测试 fixtures 断链；它不再连接数据库，只返回一行说明。
 *
 * 升级路径（如果未来出现"已有 SQLite 文件，需补列"的场景）：在 S2 之后新增
 * 单独一次性迁移脚本（参考 S3 数据迁移脚本），并由 boot.ts 在 autoMigrate
 * 完成后串行调用；此处不再承载。
 */
export async function migrateV2(_force = false): Promise<string[]> {
  return [
    "migrate-v2: no-op in S2 (auto-migrate 已用最新 schema 直接建表；所有 V2 历史补列均已内联)",
  ];
}
