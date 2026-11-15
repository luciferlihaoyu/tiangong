/**
 * 生产迁移注册表：auto-migrate.ts side-effect import 本模块，
 * runSchemaMigrations 执行时按注册序运行未应用的条目。
 *
 * 命名约定：四位序号-短名（"0001-notifications-system-agent"），序号只表达
 * 引入顺序、不代表执行依赖（执行依赖写进 up 内部的检查）。
 *
 * §4-② 0001：系统代理行——系统任务（agentId=null）的失败教训通知此前只能
 * "no assignee → skip"（notifications.agent_id NOT NULL + FK 无处归属），
 * 管理员在面板上看不到系统任务失败。归属落到本行后通知真实落库：
 *  - model 留空：fusion 面板的 status IN (online,busy,idle) AND model 非空
 *    过滤天然排除它，不会出现在可派单池里；
 *  - 派单是 agent 自认领模型（claimNextTask 由 agent 自报 agentId），被动行
 *    永远不会被派活；
 *  - status 用默认 'idle'（CHECK 只认 online/busy/idle，没有 offline 档）。
 * 幂等：ON CONFLICT(agent_id) DO NOTHING——迁移只跑一次，但迁移体本身可重入。
 */
import type { DatabaseSync } from "node:sqlite";
import { registerSchemaMigration } from "./schema-migrations";

registerSchemaMigration({
  name: "0001-notifications-system-agent",
  up(db: DatabaseSync) {
    db.exec(`
      INSERT INTO agents (agent_id, name, system, status, source, description)
      VALUES ('system', '系统', 'system', 'idle', 'system',
              '平台系统代理行：承载系统任务（无执行代理）的失败教训通知归属。由版本化迁移 0001 创建，勿删。')
      ON CONFLICT(agent_id) DO NOTHING
    `);
  },
});

registerSchemaMigration({
  name: "0002-alist-password-to-vault",
  up(db: DatabaseSync) {
    // §4-③：把历史明文落库的 AList 密码从 system_settings 剥离（密码已迁
    // ALIST_PASSWORD 环境变量/Vault；每日备份从此不再携带它）。幂等：没有
    // password 字段的行原样通过；没有 alist_config 行也无害。
    const rows = db
      .prepare("SELECT key, value FROM system_settings WHERE key = 'alist_config'")
      .all() as { key: string; value: string }[];
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.value) as Record<string, unknown>;
        if (!("password" in parsed)) continue;
        delete parsed.password;
        db.prepare("UPDATE system_settings SET value = ? WHERE key = ?")
          .run(JSON.stringify(parsed), row.key);
      } catch {
        // 非 JSON 值不动（保持向后兼容，交由上层读取逻辑兜底）
      }
    }
  },
});

/**
 * t2-3：tasks.created_by_agent_id——记录"谁建的单"。
 *
 * 与 `agent_id`（派给谁执行）语义不同：历史事故 #61/#62/#198 复盘时发现，
 * 大量 agent_id=NULL 的任务查不出是谁投的，既无法追责、也无法判断该由哪个
 * Runner 兜底。本列可空（老行 + 推导不出身份的调用方一律 NULL）。
 *
 * 为什么写成版本化迁移而不是只靠 schema-repair：加列本身 repair 能补，但
 * "库的形状变了"必须是有记录的有意识行为（§4 版本化纪律）。DDL 从派生
 * schema 现取（单一事实源），避免手写副本与 db/schema.ts 漂移；列已存在时
 * （全新库 / repair 先跑过）幂等跳过。
 */
registerSchemaMigration({
  name: "0003-tasks-created-by-agent-id",
  up(db: DatabaseSync) {
    const columns = db.prepare(`PRAGMA table_info("tasks")`).all() as Array<{ name: string }>;
    if (columns.some((c) => c.name === "created_by_agent_id")) return;
    db.exec(`ALTER TABLE "tasks" ADD COLUMN "created_by_agent_id" integer`);
  },
});
