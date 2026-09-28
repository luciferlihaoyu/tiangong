/**
 * §4-③ 配置服务收敛：
 *  A. TIANSHU_BASE_URL 统一——此前 7 个文件两套硬编码默认值互相打架，且其中
 *     "https://woppis1.zeabur.app" 是**死域名**（/v1/models 实测 404，2026-09-28，
 *     生产 Vault 又没设 TIANSHU_BASE_URL）——summarizer/pricing-router/task-runner/
 *     tianshu-router 四处是潜伏故障；tianshu.xianrealme.com 实测 200 且 /v1/models
 *     返回正常 new_api payload。统一到 env.ts 单一 helper（默认=实测存活的
 *     公网域名）。
 *  B. AList 密码迁 Vault——原 UI 配置把**明文密码**存进 system_settings，
 *     随每日未加密备份外流。现契约：DB 只存 baseUrl/username/basePath/
 *     autoUpload；密码一律来自 ALIST_PASSWORD 环境变量（Zeabur Vault）。
 *     版本化迁移 0002 把已落库的密码从设置行里剥离（立即给备份脱敏）。
 *
 * RED 锚点：恢复 saveAlistDbConfig 的密码持久化 / 迁移不剥 password → 用例转红。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createTestDb, markSystemReady, type TestDb } from "./helpers/test-db";

const ROOT = path.resolve(__dirname, "../..");

function source(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf8");
}

// settings 走真实 drizzle（db 由 mock 的 getDb 对准 testDb）
const conn = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock("../../api/queries/connection", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/queries/connection")>();
  return { ...actual, getDb: conn.getDb };
});

describe("§4-③A TIANSHU_BASE_URL 收敛到单一事实源", () => {
  const sites = [
    "api/lib/task-runner.ts",
    "api/tianshu-router.ts",
    "api/lib/ai-assistant.ts",
    "api/lib/auto-approve.ts",
    "api/lib/fusion-prereview.ts",
    "api/lib/summarizer.ts",
    "api/pricing-router.ts",
  ];

  it("7 个消费点全部改成引用 api/lib/env 的统一 helper（不再各自硬编码域名）", () => {
    for (const f of sites) {
      const src = readFileSync(path.join(ROOT, f), "utf8");
      expect(src, `${f} 不得再硬编码 woppis1.zeabur.app`).not.toMatch(/woppis1\.zeabur\.app/);
      expect(src, `${f} 不得再硬编码 tianshu.xianrealme.com（应引用统一 helper）`)
        .not.toMatch(/tianshu\.xianrealme\.com/);
    }
    expect(readFileSync(path.join(ROOT, "api/lib/env.ts"), "utf8"),
      "env.ts 是唯一允许写默认域名的地方").toMatch(/tianshu\.xianrealme\.com/);
  });

  it("统一 helper：默认 = 实测存活的 tianshu.xianrealme.com，且去尾斜杠", async () => {
    vi.resetModules();
    const saved = process.env.TIANSHU_BASE_URL;
    delete process.env.TIANSHU_BASE_URL;
    const { tianshuBaseUrlSafe } = await import("../../api/lib/env");
    expect(tianshuBaseUrlSafe()).toBe("https://tianshu.xianrealme.com");
    process.env.TIANSHU_BASE_URL = "https://custom.example.com///";
    expect(tianshuBaseUrlSafe()).toBe("https://custom.example.com");
    if (saved !== undefined) process.env.TIANSHU_BASE_URL = saved;
    else delete process.env.TIANSHU_BASE_URL;
  });
});

describe("§4-③B AList 密码只存 Vault（env），DB/备份脱敏", () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createTestDb();
    markSystemReady();
    conn.getDb.mockReturnValue(testDb.db);
  });
  afterEach(() => {
    testDb.dispose();
    delete process.env.ALIST_PASSWORD;
    conn.getDb.mockReset();
  });

  function rawSetting(key: string): string | null {
    const row = testDb.raw
      .prepare("SELECT value FROM system_settings WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  function seedDbConfigWithPassword(): void {
    testDb.raw
      .prepare(
        `INSERT INTO system_settings (key, value, category) VALUES ('alist_config', ?, 'alist')`,
      )
      .run(
        JSON.stringify({
          baseUrl: "https://tiankulist.example.com",
          username: "tiangong",
          password: "DB-PLAINTEXT-SECRET",
          basePath: "/115/天宫",
          autoUpload: true,
        }),
      );
  }

  it("迁移 0002（幂等）：从 alist_config 设置行剥离 password 字段，其余字段保留", async () => {
    seedDbConfigWithPassword();
    const { runSchemaMigrations } = await import("../../api/lib/schema-migrations");
    await import("../../api/lib/migrations-register"); // side-effect 注册 0002
    runSchemaMigrations(testDb.raw as unknown as DatabaseSync);

    const raw = rawSetting("alist_config");
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!) as Record<string, unknown>;
    expect(parsed.password).toBeUndefined();
    expect(parsed.baseUrl).toBe("https://tiankulist.example.com");
    expect(parsed.username).toBe("tiangong");
    expect(parsed.basePath).toBe("/115/天宫");
    expect(parsed.autoUpload).toBe(true);
    // 再跑一轮：没有 password 可剥也不抛错（幂等）
    expect(() => runSchemaMigrations(testDb.raw as unknown as DatabaseSync)).not.toThrow();
    expect(JSON.parse(rawSetting("alist_config")!)).not.toHaveProperty("password");
  });

  it("saveAlistDbConfig 不再持久化密码：传入的 password 不落 DB", async () => {
    const { saveAlistDbConfig } = await import("../../api/connectors/alist");
    await saveAlistDbConfig({
      baseUrl: "https://tiankulist.example.com",
      username: "tiangong",
      password: "CLI-CAME-IN",
      basePath: "/115/天宫",
      autoUpload: true,
    });
    const parsed = JSON.parse(rawSetting("alist_config")!) as Record<string, unknown>;
    expect(parsed.password).toBeUndefined();
    expect(parsed.baseUrl).toBe("https://tiankulist.example.com");
    expect(parsed.username).toBe("tiangong");
  });

  it("getAlistDbConfig：连接参数来自 DB，密码一律取 env（DB 里没有也取不到）", async () => {
    const { runSchemaMigrations } = await import("../../api/lib/schema-migrations");
    await import("../../api/lib/migrations-register");
    runSchemaMigrations(testDb.raw as unknown as DatabaseSync);
    seedDbConfigWithPassword();
    runSchemaMigrations(testDb.raw as unknown as DatabaseSync); // 先剥掉落库密码

    const { resolveAlistConfig, alistConfigSource } = await import("../../api/connectors/alist");

    // env 缺密码 → 配置不可用（不能再用 DB 里的明文兜底——它都不存在了）
    delete process.env.ALIST_PASSWORD;
    expect(await resolveAlistConfig()).toBeNull();

    // env 有密码 → 连接参数来自 DB、密码来自 env
    process.env.ALIST_PASSWORD = "VAULT-SECRET";
    const cfg = await resolveAlistConfig();
    expect(cfg).toBeTruthy();
    expect(cfg!.password).toBe("VAULT-SECRET");
    expect(cfg!.baseUrl).toBe("https://tiankulist.example.com");
    expect(cfg!.username).toBe("tiangong");
    expect(cfg!.basePath).toBe("/115/天宫");
    expect(await alistConfigSource()).toBe("ui");
  });
});
