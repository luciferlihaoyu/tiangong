/**
 * 部署切换后的 chunk 加载自愈（碧霄 2026-02，配合 P0 路由级代码分割）
 *
 * 背景（天演评审 M1）：代码分割后，长驻 tab 持有旧 index.html；一旦新版部署、
 * 旧 hash 的 lazy chunk 404，dynamic import reject 会穿透所有 Suspense（Suspense
 * 不拦 error），直达顶层 ErrorBoundary → 全屏错误页，且无自动恢复路径。
 *
 * Vite（≥5.1，本项目 Vite 7）在 module preload / 动态 chunk 加载失败时派发
 * 可取消的 window "vite:preloadError" 事件：
 * - 首次命中：preventDefault（吞掉 reject，不让错误炸进 React 树）+ 整页刷新拿新 shell；
 * - sessionStorage 标记防无限循环：刷新后 10s 内再失败则不再刷新，放行走
 *   ErrorBoundary 既有兜底（展示诊断信息）；
 * - 启动稳定 10s 后复位标记，未来一次部署切换仍可再自愈一次。
 */
const RELOAD_FLAG = "tiangong:chunk-self-healed";

const flag = {
  get(): string | null {
    try {
      return sessionStorage.getItem(RELOAD_FLAG);
    } catch {
      return null; // 隐私模式等拿不到 sessionStorage：视作无标记，最坏回到手动刷新
    }
  },
  set(): void {
    try {
      sessionStorage.setItem(RELOAD_FLAG, "1");
    } catch {
      /* noop */
    }
  },
  clear(): void {
    try {
      sessionStorage.removeItem(RELOAD_FLAG);
    } catch {
      /* noop */
    }
  },
};

export function installChunkSelfHeal(): void {
  if (typeof window === "undefined") return;

  window.addEventListener("vite:preloadError", (event) => {
    if (flag.get()) return; // 本 tab 已自愈过一次仍失败：不再刷新，放行抛错交给 ErrorBoundary
    flag.set();
    event.preventDefault();
    window.location.reload();
  });

  // 页面平稳运行 10s 视为本次启动成功，复位标记，保留未来的自愈额度
  window.setTimeout(() => flag.clear(), 10_000);
}
