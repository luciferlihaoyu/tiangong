/**
 * 天宫首页「平台入口」外部应用卡（OpenClaw / 4sapi / OpenCode）注册表单测。
 *
 * 需求：首页卡片网格由 platform.registry 驱动，把用户给的三个网址加成卡片，
 * 与天宫/北斗/天枢/DSH 等平台卡同构（同样的健康灯 + 点击开窗行为）。
 * 本测试锁定注册表的可观察契约：
 *   1) 三项 key 已注册且 kind === "external"（外部应用，走「可达即健康」探活）；
 *   2) 未配置环境变量时使用内置默认网址，且尾斜杠已 strip；
 *   3) 配置环境变量时被覆盖，尾斜杠仍被 strip；
 *   4) 既有平台项与顺序契约未被破坏（首页网格顺序稳定）。
 */
import { afterEach, describe, expect, it } from "vitest";
import { getPlatformServices } from "../../api/platform-router";

const ENV_KEYS = [
  "OPENCLAW_BASE_URL",
  "S4API_BASE_URL",
  "OPENCODE_BASE_URL",
  "FUSHENG_BASE_URL",
] as const;

/** 按 key 取注册项；缺失直接断言失败，避免后续 undefined 取值噪音 */
function byKey(key: string) {
  const svc = getPlatformServices().find((s) => s.key === key);
  expect(svc, `注册表缺少 ${key}`).toBeDefined();
  return svc!;
}

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

describe("首页外部应用卡注册表", () => {
  it("三项外部应用均已注册且 kind 为 external", () => {
    for (const key of ["openclaw", "4sapi", "opencode"]) {
      expect(byKey(key).kind).toBe("external");
    }
  });

  it("label 与卡片标题一致（首页直接展示 label）", () => {
    expect(byKey("openclaw").label).toBe("OpenClaw");
    expect(byKey("4sapi").label).toBe("4sapi");
    expect(byKey("opencode").label).toBe("OpenCode");
  });

  it("未配置 env 时使用内置默认网址（尾斜杠已 strip）", () => {
    for (const k of ENV_KEYS) delete process.env[k];
    expect(byKey("openclaw").url).toBe("https://ttrssa.xianrealme.com");
    expect(byKey("4sapi").url).toBe("https://4sapi.org");
    expect(byKey("opencode").url).toBe("https://ccood.dpdns.org");
  });

  it("env 覆盖生效且尾斜杠仍被 strip", () => {
    process.env.OPENCLAW_BASE_URL = "https://oc.example.com/";
    process.env.S4API_BASE_URL = "https://s4.example.com//";
    process.env.OPENCODE_BASE_URL = "https://oc2.example.com";
    expect(byKey("openclaw").url).toBe("https://oc.example.com");
    expect(byKey("4sapi").url).toBe("https://s4.example.com");
    expect(byKey("opencode").url).toBe("https://oc2.example.com");
  });

  it("env 显式设为空串时回退内置默认（运维清空变量不会让卡片失去地址）", () => {
    process.env.OPENCLAW_BASE_URL = "";
    process.env.S4API_BASE_URL = "";
    process.env.OPENCODE_BASE_URL = "";
    expect(byKey("openclaw").url).toBe("https://ttrssa.xianrealme.com");
    expect(byKey("4sapi").url).toBe("https://4sapi.org");
    expect(byKey("opencode").url).toBe("https://ccood.dpdns.org");
  });

  it("既有平台项未被破坏", () => {
    const services = getPlatformServices();
    const tiangong = services.find((s) => s.key === "tiangong");
    expect(tiangong?.kind).toBe("self");
    expect(tiangong?.url).toBe("");
    for (const key of ["beidou", "xuanji", "tianshu", "alist", "dsh"]) {
      expect(services.some((s) => s.key === key)).toBe(true);
    }
    // 外部应用排在既有平台/网关之后：首页网格顺序稳定
    const keys = services.map((s) => s.key);
    expect(keys.indexOf("openclaw")).toBeGreaterThan(keys.indexOf("dsh"));
  });

  it("key 唯一（避免前端 React key 冲突与 pluginByKey 覆盖）", () => {
    const keys = getPlatformServices().map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

/**
 * 浮生若梦（AI 影视创作工作台）自带 /api/health（返回 {"ok":true,...}），
 * 因此按 beidou/xuanji 同款 kind="app" 注册：健康灯探的是真实健康端点，
 * 而不是退化成 external 的「base 可达即健康」。
 */
describe("浮生若梦卡片", () => {
  it("注册为 app 类型并指向自带健康端点 /api/health", () => {
    const svc = byKey("fusheng");
    expect(svc.kind).toBe("app");
    expect(svc.healthPath).toBe("/api/health");
    expect(svc.label).toBe("浮生若梦");
  });

  it("未配置 env 时用内置默认网址（尾斜杠已 strip）", () => {
    delete process.env.FUSHENG_BASE_URL;
    expect(byKey("fusheng").url).toBe("https://fusheng-ruomeng.xianrealme.com");
  });

  it("env 覆盖生效且尾斜杠仍被 strip", () => {
    process.env.FUSHENG_BASE_URL = "https://fs.example.com/";
    expect(byKey("fusheng").url).toBe("https://fs.example.com");
  });

  it("排在既有平台卡之后（首页网格顺序稳定）", () => {
    const keys = getPlatformServices().map((s) => s.key);
    expect(keys.indexOf("fusheng")).toBeGreaterThan(keys.indexOf("xuanji"));
  });
});
