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
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";
import { env } from "./env";
import * as schema from "../../db/schema";
import { generateAllDdl } from "./ddl";
import { runSchemaMigrations } from "./schema-migrations";

/**
 * 建库 DDL：**从 db/schema.ts 派生**（api/lib/ddl.ts），不再是手写副本。
 * 黄金快照等价性（列/型别/NOT NULL/默认值/PK/外键/索引逐表一致）由
 * tests/api/schema-ddl-golden.test.ts 用重写前手写 SQL 冻结的结构背书。
 */
export const CREATE_TABLES_SQL: string[] = generateAllDdl(
  schema as unknown as Record<string, unknown>,
);

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
import { describeSchemaRepair, repairMissingColumns, type SchemaRepairResult } from "./schema-repair";
import { readiness } from "./readiness";

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
    // node:sqlite 静态导入（builtin，无循环依赖风险；原先的 require() 在
    // 纯 ESM 上下文（tsx 直跑）下直接 ReferenceError）
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

    // Phase B §2：区分"良性幂等告警"与"真失败"，后者会让 not-ready → 不接单
    const criticalFailures: string[] = [];

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
        const message = e.message?.slice(0, 100) ?? String(e);
        logs.push(`${tableName}: ${e.message?.slice(0, 80)}`);
        console.warn("Migration statement warning:", message);
        // "already exists" 是幂等重跑的良性告警（生产日志里一堆），不算失败；
        // 其余（磁盘/权限/DDL 语法等）是真失败 → 就绪判定要据此拦住接单。
        if (!/already exists/i.test(message)) criticalFailures.push(`${tableName}: ${message.slice(0, 120)}`);
      }
    }

    // 建表之后统一做列对齐（Phase B 旧库升级）。
    // CREATE TABLE IF NOT EXISTS 不会修改**已存在**的表，所以老库后来新增的列
    // 只能在这里补；否则部署新版后查询会报 no such column，而本地测试全绿。
    // 补列清单从 db/schema.ts 派生；SQLite 拒绝补的列会进 skipped 并打日志。
    let repair: SchemaRepairResult | undefined;
    try {
      repair = repairMissingColumns(sqliteDb);
      const repairLogs = describeSchemaRepair(repair);
      logs.push(...repairLogs);
      // 同时打到 stdout：补列是"在生产上静默改库"的动作，只放进返回数组的话
      // 运维在容器日志里看不到它发生过（本轮生产就静默补了 outbox 的租约两列，
      // 直到手工查表才发现）。启动各打一行，代价可以忽略。
      for (const line of repairLogs) console.log(line);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logs.push(`schema-repair error: ${message}`);
      criticalFailures.push(`schema-repair: ${message.slice(0, 120)}`);
    }

    // 版本化一次性迁移（§4 版本化迁移统一）：建表 + 补列之后执行；
    // 失败收进 criticalFailures（→ readiness 不接单），成功记录在 schema_migrations。
    try {
      const mig = runSchemaMigrations(sqliteDb, logs);
      for (const f of mig.failures) {
        criticalFailures.push(`schema-migration ${f.name}: ${f.error.slice(0, 120)}`);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logs.push(`schema-migrations error: ${message}`);
      criticalFailures.push(`schema-migrations: ${message.slice(0, 120)}`);
    }

    // 就绪上报（Phase B §2）：迁移失败或 schema 与代码不一致 → 不就绪 → 不接单。
    // 补列被跳过意味着代码要用的列在库里不存在，运行时必然 no such column，
    // 因此它和迁移失败一样属于"关键"而非"可选集成"。
    readiness.recordMigration(
      criticalFailures.length === 0,
      criticalFailures.length > 0 ? criticalFailures.join("; ") : undefined,
    );
    readiness.recordSchemaDrift(repair?.skipped ?? []);

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
