/**
 * 首页「平台入口」卡片的前端契约测试。
 *
 * 为什么用源码文本断言而不是渲染测试：本仓库没有 jsdom / testing-library 依赖，
 * 而为 3 张卡引入整套渲染测试栈（并改 AppHub 导出结构）成本远大于收益。
 * 这里只锁定两类「静默回归」——它们在 TS 层面拦不住：
 *   1) APP_META 缺描述 → 卡片描述回退 label，标题与描述重复（编译不报错）；
 *   2) 新 key 被误加进 SSO_KEYS → 点击会先调 platform.launch 签票而不是直接开外链
 *      （拼写正确的 key 编译同样不报错）。
 * 若将来 AppHub 结构大改导致本测试失效，请把 APP_META / SSO_KEYS 抽成独立模块
 * 再改为导入断言，而不是删掉这些契约。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const APP_HUB_PATH = path.resolve(import.meta.dirname, "../../src/sections/AppHub.tsx");
const source = readFileSync(APP_HUB_PATH, "utf-8");

/** 首页外部/新接入卡片：这些站点没有 /sso/launch 接收端，必须直开外链 */
const DIRECT_OPEN_KEYS = ["openclaw", "4sapi", "opencode", "fusheng"] as const;

describe("首页卡片前端契约（AppHub.tsx）", () => {
  it("新卡都有专属中文描述（缺失会回退 label 造成标题/描述重复）", () => {
    for (const description of [
      "OpenClaw 网页控制台",
      "API 聚合中转站",
      "OpenCode 网页终端",
      "AI 影视创作工作台",
    ]) {
      expect(source).toContain(description);
    }
  });

  it("APP_META 覆盖所有新 key", () => {
    expect(source).toMatch(/^\s*openclaw:\s*\{/m);
    expect(source).toMatch(/^\s*"4sapi":\s*\{/m);
    expect(source).toMatch(/^\s*opencode:\s*\{/m);
    expect(source).toMatch(/^\s*fusheng:\s*\{/m);
  });

  it("新 key 不在 SSO_KEYS 白名单里（应直开外链，不误走 platform.launch 签票）", () => {
    const ssoLine = source.split("\n").find((line) => line.includes("const SSO_KEYS"));
    expect(ssoLine, "未找到 SSO_KEYS 定义").toBeDefined();
    for (const key of DIRECT_OPEN_KEYS) {
      expect(ssoLine!).not.toContain(key);
    }
  });
});
