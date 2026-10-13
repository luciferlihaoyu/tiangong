import path from "path"
const __dirname = import.meta.dirname
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// https://vite.dev/config/
export default defineConfig(async ({ mode }) => {
  const plugins = [react()]

  // devServer 只在开发模式加载
  if (mode === "development") {
    try {
      const devServer = (await import("@hono/vite-dev-server")).default
      const honoPlugin = devServer({ entry: "api/boot.ts", exclude: [/^\/(?!api\/).*$/] })
      plugins.push(...(Array.isArray(honoPlugin) ? honoPlugin : [honoPlugin]))
    } catch {
      console.warn("@hono/vite-dev-server not available, skipping")
    }
  }

  return {
    plugins,
    server: { port: 3000 },
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
        "@contracts": path.resolve(__dirname, "./contracts"),
        "@db": path.resolve(__dirname, "./db"),
        "db": path.resolve(__dirname, "./db"),
      },
    },
    envDir: path.resolve(__dirname),
    build: {
      outDir: path.resolve(__dirname, "dist/public"),
      emptyOutDir: true,
      rollupOptions: {
        output: {
          manualChunks: {
            "react-vendor": ["react", "react-dom", "react-router"],
            "trpc-vendor": ["@trpc/client", "@trpc/react-query", "@trpc/server", "@tanstack/react-query"],
            "ui-vendor": ["@radix-ui/react-dialog", "@radix-ui/react-dropdown-menu", "@radix-ui/react-tabs", "@radix-ui/react-tooltip", "@radix-ui/react-select"],
            // three-vendor 不再手动钉块（碧霄 2026-02 P0 首屏减负）：
            // 此前 manualChunks 使 rollup 把共享 __vitePreload helper 放进了 three-vendor chunk，
            // 入口为拿 helper 静态 import 这 1.1MB——每个页面都被迫 modulepreload three。
            // 去掉后 three 跟随 lazy 的 MatrixNodes/FooterTerminal 自然成块，仅首页按需加载。
          },
        },
      },
    },
  }
})
