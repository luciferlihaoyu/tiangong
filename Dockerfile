FROM node:24-alpine

RUN addgroup -g 10001 tiangong && adduser -D -u 10001 -G tiangong tiangong

WORKDIR /app

# 安装依赖（包含 devDependencies，drizzle-kit 需要）
COPY package.json package-lock.json ./
RUN npm ci

# 复制源码
COPY . .

# 构建前端 + 后端
RUN npm run build

ENV TIANGONG_ARTIFACT_ROOT=/app/data/tiangong-artifacts
RUN mkdir -p /app/data/tiangong-artifacts/by-sha /app/data/tiangong-artifacts/staged /app/data/tiangong-artifacts/gc /app/data/tiangong-artifacts/probe /app/data \
  && chown -R tiangong:tiangong /app /app/data \
  && chmod 0750 /app/data /app/data/tiangong-artifacts /app/data/tiangong-artifacts/by-sha /app/data/tiangong-artifacts/staged /app/data/tiangong-artifacts/gc /app/data/tiangong-artifacts/probe

# SQLite 数据库文件（/app/data/tiangong.db）由 /app/data 持久化 volume 承载
# （zeabur.json mountPaths 已挂 /app/data → tiangong-data）；artifact 目录在
# /app/data 之下，随全局挂载一并持久化。
VOLUME ["/app/data"]
USER tiangong:tiangong

# 保留 drizzle-kit（push schema 需要）
# 不执行 npm prune --production

EXPOSE 3000

# 启动：数据库 schema 由应用启动时的 autoMigrate + migrateV2 负责，避免 drizzle-kit push 阻塞 Zeabur STARTING
CMD ["sh", "scripts/start.sh"]
