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
      plugins.push(devServer({ entry: "api/boot.ts", exclude: [/^\/(?!api\/).*$/] }))
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
    },
  }
})
