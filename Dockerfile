FROM node:24-alpine

WORKDIR /app

# 安装依赖（包含 devDependencies，drizzle-kit 需要）
COPY package.json package-lock.json ./
RUN npm ci --include=dev

# 复制源码
COPY . .

# 构建前端 + 后端
RUN npm run build

# 保留 drizzle-kit（push schema 需要）
# 不执行 npm prune --production

EXPOSE 3000

# 启动：先同步数据库 schema，再启动服务
CMD ["sh", "-c", "(npx drizzle-kit push || true) && NODE_ENV=production node dist/boot.js"]
