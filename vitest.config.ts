import { defineConfig } from "vitest/config";
import path from "path";

const __dirname = import.meta.dirname;

export default defineConfig({
  test: {
    setupFiles: ["./tests/setup.ts"],
    globals: true,
    include: ["tests/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@contracts": path.resolve(__dirname, "./contracts"),
      "@db": path.resolve(__dirname, "./db"),
      db: path.resolve(__dirname, "./db"),
      // better-sqlite3 只在 drizzle-orm/better-sqlite3 的 import 语句里被引用，
      // 生产经 pnpm file: 协议链到 vendor shim；vitest 环境直接 alias 过去，
      // 避免本机 node_modules 链接不全时 ERR_MODULE_NOT_FOUND。
      "better-sqlite3": path.resolve(__dirname, "./vendor/better-sqlite3-shim/index.js"),
    },
  },
});
