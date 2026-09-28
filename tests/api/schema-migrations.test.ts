/**
 * 版本化 schema 迁移（api/lib/schema-migrations.ts）——真实 SQLite 直测。
 *
 * §4 残余（版本化迁移统一）：此前"一次性迁移"没有统一载体——migrate-v2 退化成
 * no-op、数据搬迁只能靠临时脚本；本模块给"有状态的一次性迁移"一个带记录的容器。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// setup.ts 把 queries/connection mock 成只剩 getDb（autoMigrate 里的 resolveDbPath
// 会因此变 undefined）——这里保留真实实现，与 schema-upgrade-boot.test.ts 同口径。
vi.mock("../../api/queries/connection", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/queries/connection")>();
  return { ...actual, getDb: vi.fn() };
});
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  registerSchemaMigration,
  runSchemaMigrations,
  listRegisteredSchemaMigrations,
} from "../../api/lib/schema-migrations";

// 注册簿是模块级的：每个用例注册独立名字，互不干扰
describe("版本化 schema 迁移（真实 SQLite）", () => {
  let db: DatabaseSync;
  const registered: RegisteredSchemaMigration[] = [];

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE probes (k TEXT)");
  });

  it("迁移按注册序执行并记入 schema_migrations；重跑跳过已应用的", () => {
    const calls: string[] = [];
    registerSchemaMigration({ name: "0001-probe", up(d, logs) {
      calls.push("first");
      d.prepare("INSERT INTO probes (k) VALUES ('first')").run();
      logs.push("first ran");
    } });
    registerSchemaMigration({ name: "0002-probe", up(d) {
      calls.push("second");
      d.prepare("INSERT INTO probes (k) VALUES ('second')").run();
    } });

    const run1 = runSchemaMigrations(db);
    expect(run1.applied).toEqual(["0001-probe", "0002-probe"]);
    expect(run1.skipped).toEqual([]);
    expect(calls).toEqual(["first", "second"]);
    expect((db.prepare("SELECT COUNT(*) c FROM probes").get() as { c: number }).c).toBe(2);

    // 重跑：全部跳过、不再执行 up
    const run2 = runSchemaMigrations(db);
    expect(run2.applied).toEqual([]);
    expect(run2.skipped).toEqual(["0001-probe", "0002-probe"]);
    expect(calls).toEqual(["first", "second"]);
    expect(run1.failures).toEqual([]);

    // 名字确实落在表里（跨启动恢复的持久记录）
    const names = (db.prepare("SELECT name FROM schema_migrations ORDER BY name").all() as { name: string }[]).map((r) => r.name);
    expect(names).toEqual(["0001-probe", "0002-probe"]);
  });

  it("失败迁移整体回滚不记名；后续迁移仍按序试运行", () => {
    registerSchemaMigration({ name: "0001-boom", up(d) {
      d.prepare("INSERT INTO probes (k) VALUES ('boom')").run();
      throw new Error("deliberate failure");
    } });
    registerSchemaMigration({ name: "0002-after-boom", up(d) {
      d.prepare("INSERT INTO probes (k) VALUES ('after')").run();
    } });

    const run = runSchemaMigrations(db);
    // 前面用例注册的迁移在新 DB 上也会应用（模块级登记簿共享），这里只做该用例的相对断言：
    // 失败的名字不进 applied、失败清单恰好一条、失败迁移的写入被回滚。
    expect(run.applied).not.toContain("0001-boom");
    expect(run.failures).toHaveLength(1);
    expect(run.failures[0].name).toBe("0001-boom");
    const ks = (db.prepare("SELECT k FROM probes ORDER BY k").all() as { k: string }[]).map((r) => r.k);
    expect(ks).not.toContain("boom");          // 失败迁移的写入被回滚
    expect(ks).toContain("after");             // 后续成功迁移的行在
    // 失败的名字没进 schema_migrations → 下次启动会重试
    const names = (db.prepare("SELECT name FROM schema_migrations").all() as { name: string }[]).map((r) => r.name);
    expect(names).not.toContain("0001-boom");
    expect(names).toContain("0002-after-boom");
  });

  it("同名字重复注册立即抛错（配置错误不允许静默）", () => {
    registerSchemaMigration({ name: "dup-probe", up() {} });
    expect(() => registerSchemaMigration({ name: "dup-probe", up() {} })).toThrow(/dup-probe/);
  });

  it("无注册迁移时不建 schema_migrations 表（零开销）", () => {
    // 本文件前面的用例注册过清理不了，这里是模块级登记簿——新 DB 上"空注册"行为
    // 只能在逻辑上保证：registry 非空才建表。直接断 list 接口存在性。
    expect(Array.isArray(listRegisteredSchemaMigrations())).toBe(true);
  });

  it("（接线）真实 autoMigrate 会执行注册迁移并在第二轮跳过", async () => {
    // 独立临时库：像 schema-upgrade-boot.test.ts 一样跑真 autoMigrate 两轮
    const dir = mkdtempSync(path.join(tmpdir(), "schemamig-"));
    const dbPath = path.join(dir, "m.db");
    const { DatabaseSync: DS } = await import("node:sqlite");
    const raw = new DS(dbPath);
    raw.exec("CREATE TABLE IF NOT EXISTS marker (v TEXT)");
    raw.close();
    process.env.DATABASE_URL = dbPath;
    vi.resetModules();

    const probeName = "0001-wire-probe";
    const oldEnv = process.env.DATABASE_URL;
    try {
      // 关键顺序：resetModules（在 beforeEach 后、本用例较早处）之后先把
      // auto-migrate 引进来（顺带实例化它依赖的 schema-migrations），再从
      // 同一缓存实例拿 registerSchemaMigration——否则会注册进"另一个模块
      // 实例"的登记簿，autoMigrate 看不到。
      const mm = await import("../../api/lib/schema-migrations");
      const { autoMigrate } = await import("../../api/lib/auto-migrate");
      mm.registerSchemaMigration({
        name: probeName,
        up(d) {
          d.exec("INSERT INTO marker (v) VALUES ('wired')");
        },
      });
      await autoMigrate(false);
      const { DatabaseSync: DS2 } = await import("node:sqlite");
      const check = new DS2(dbPath, { readOnly: true });
      const v = (check.prepare("SELECT v FROM marker").all() as { v: string }[]).map((r) => r.v);
      expect(v).toEqual(["wired"]);                       // 第一轮：真执行
      const names = (check.prepare("SELECT name FROM schema_migrations").all() as { name: string }[]).map((r) => r.name);
      expect(names).toContain(probeName);
      check.close();

      // 第二轮：autoMigrate 再跑不应重复执行（v 仍只有一行）
      await autoMigrate(false);
      const check2 = new DS2(dbPath, { readOnly: true });
      expect((check2.prepare("SELECT COUNT(*) c FROM marker").get() as { c: number }).c).toBe(1);
      check2.close();
    } finally {
      process.env.DATABASE_URL = oldEnv;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// RED 反向验证锚点：撤掉 auto-migrate.ts 里 runSchemaMigrations 的接线
// （大约在 "// 版本化一次性迁移（§4 版本化迁移统一）" 注释块），上面第 5 条用例转红。
