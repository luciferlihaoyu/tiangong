FROM node:24-alpine

WORKDIR /app

# 安装依赖（包含 devDependencies，drizzle-kit 需要）
COPY package.json package-lock.json ./
RUN npm ci

# 复制源码
COPY . .

# 构建前端 + 后端
RUN npm run build

# 保留 drizzle-kit（push schema 需要）
# 不执行 npm prune --production

EXPOSE 3000

# 启动：数据库 schema 由应用启动时的 autoMigrate + migrateV2 负责，避免 drizzle-kit push 阻塞 Zeabur STARTING
CMD ["sh", "scripts/start.sh"]
