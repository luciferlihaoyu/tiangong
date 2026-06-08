FROM node:24-alpine

WORKDIR /app

# 安装依赖（包含 devDependencies）
COPY package.json package-lock.json ./
RUN npm ci --include=dev

# 构建前端
RUN npx vite build

# 构建后端
RUN npx esbuild api/boot.ts --platform=node --bundle --format=esm --outdir=dist --banner:js="import { createRequire } from 'module';const require = createRequire(import.meta.url);"

# 清理 devDependencies（可选，减小镜像）
RUN npm prune --production

EXPOSE 3000

# 启动：先同步数据库 schema，再启动服务
CMD ["sh", "-c", "(npx drizzle-kit push || true) && NODE_ENV=production node dist/boot.js"]
