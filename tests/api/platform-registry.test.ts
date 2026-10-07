/**
 * 天宫首页卡片注册表单测（平台/外部应用/外部工具站）。
 *
 * 需求：首页卡片网格由 platform.registry 驱动，把用户给的网址加成卡片，
 * 与天宫/北斗/天枢/DSH 等平台卡同构（同样的健康灯 + 点击开窗行为）。
 * 覆盖三批：① OpenClaw / 4sapi / OpenCode（external）；
 *          ② 浮生若梦（自带 /api/health，走 app）；
 *          ③ Zeabur / DeepSeek / LiblibAI / AutoDL / LibTV / MiniMax 音频（external）。
 * 本测试锁定注册表的可观察契约：
 *   1) 各 key 已注册且 kind 正确（external 走「可达即健康」；app 探真实健康端点）；
 *   2) 未配置环境变量时使用内置默认网址，且尾斜杠已 strip（子路径不受影响）；
 *   3) 配置环境变量时被覆盖，尾斜杠仍被 strip、显式空串回退默认；
 *   4) 既有平台项与顺序契约未被破坏（首页网格顺序稳定）。
 */
import { afterEach, describe, expect, it } from "vitest";
import { getPlatformServices } from "../../api/platform-router";

const ENV_KEYS = [
  "OPENCLAW_BASE_URL",
  "S4API_BASE_URL",
  "OPENCODE_BASE_URL",
  "FUSHENG_BASE_URL",
  "ZEABUR_BASE_URL",
  "DEEPSEEK_BASE_URL",
  "LIBLIB_BASE_URL",
  "AUTODL_BASE_URL",
  "LIBLIBTV_BASE_URL",
  "MINIMAX_AUDIO_BASE_URL",
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

/**
 * 第二批外部工具站（Zeabur / DeepSeek / LiblibAI / AutoDL / LibTV / MiniMax 音频）。
 * 均为第三方 SaaS，没有可用的自建健康端点，故沿用 kind="external"（可达即健康）。
 * 注意其中一个坑：MiniMax 的入口是子路径 /audio，stripTrailingSlash 只该吃「尾斜杠」，
 * 不能把路径段当尾斜杠一起吃掉 —— 本文件用显式断言把它钉住。
 */
describe("外部工具卡片（第二批）", () => {
  const TOOLS = [
    { key: "zeabur", label: "Zeabur", url: "https://zeabur.com" },
    { key: "deepseek", label: "DeepSeek", url: "https://platform.deepseek.com" },
    { key: "liblib", label: "LiblibAI", url: "https://www.liblib.art" },
    { key: "autodl", label: "AutoDL", url: "https://www.autodl.com" },
    { key: "liblibtv", label: "LibTV", url: "https://www.liblib.tv" },
    { key: "minimaxaudio", label: "MiniMax 音频", url: "https://www.minimax.cn/audio" },
  ] as const;

  it("六个工具站均已注册且 kind 为 external", () => {
    for (const t of TOOLS) {
      expect(byKey(t.key).kind).toBe("external");
    }
  });

  it("label 与卡片标题一致", () => {
    for (const t of TOOLS) {
      expect(byKey(t.key).label).toBe(t.label);
    }
  });

  it("未配置 env 时使用内置默认网址（尾斜杠已 strip）", () => {
    for (const k of ENV_KEYS) delete process.env[k];
    for (const t of TOOLS) {
      expect(byKey(t.key).url).toBe(t.url);
    }
  });

  it("MiniMax 的子路径 /audio 不被 stripTrailingSlash 吃掉", () => {
    delete process.env.MINIMAX_AUDIO_BASE_URL;
    const url = byKey("minimaxaudio").url;
    expect(url).toContain("/audio");
    expect(url.endsWith("/")).toBe(false);
  });

  it("env 覆盖生效且尾斜杠仍被 strip", () => {
    process.env.ZEABUR_BASE_URL = "https://z.example.com/";
    process.env.DEEPSEEK_BASE_URL = "https://d.example.com//";
    process.env.LIBLIB_BASE_URL = "https://l.example.com";
    process.env.AUTODL_BASE_URL = "https://a.example.com/";
    process.env.LIBLIBTV_BASE_URL = "https://lt.example.com/";
    process.env.MINIMAX_AUDIO_BASE_URL = "https://mm.example.com/audio/";
    expect(byKey("zeabur").url).toBe("https://z.example.com");
    expect(byKey("deepseek").url).toBe("https://d.example.com");
    expect(byKey("liblib").url).toBe("https://l.example.com");
    expect(byKey("autodl").url).toBe("https://a.example.com");
    expect(byKey("liblibtv").url).toBe("https://lt.example.com");
    // 覆盖值带子路径 + 尾斜杠：只去尾斜杠、保留 /audio
    expect(byKey("minimaxaudio").url).toBe("https://mm.example.com/audio");
  });

  it("env 显式设为空串时回退内置默认", () => {
    for (const k of ENV_KEYS) process.env[k] = "";
    for (const t of TOOLS) {
      expect(byKey(t.key).url).toBe(t.url);
    }
  });

  it("排在第一批外部应用之后（首页网格顺序稳定）", () => {
    const keys = getPlatformServices().map((s) => s.key);
    for (const t of TOOLS) {
      expect(keys.indexOf(t.key)).toBeGreaterThan(keys.indexOf("opencode"));
    }
  });

  it("与既有 MCP 插件 key 不重名（minimax 插件在册，故用 minimaxaudio 而非 minimax）", () => {
    const keys = getPlatformServices().map((s) => s.key);
    expect(keys).not.toContain("minimax");
    expect(keys).toContain("minimaxaudio");
  });
});
