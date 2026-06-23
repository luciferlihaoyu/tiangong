#!/usr/bin/env bash
# 天宫数据备份脚本（加密版）
# 备份所有核心数据 → 加密压缩包 → 提交到 GitHub
# 用法: ./scripts/backup.sh [output_dir] [password]
# 默认输出到 ./backups/
# 密码通过环境变量 BACKUP_PASS 或参数传入

set -euo pipefail

BASE_URL="${TIANGONG_BASE_URL:-https://tiangg.zeabur.app}"
OUTPUT_DIR="${1:-backups}"
PASSWORD="${2:-${BACKUP_PASS:-}}"
TIMESTAMP=$(date -u +"%Y%m%d_%H%M%S")
TEMP_DIR=$(mktemp -d)
ARCHIVE="${OUTPUT_DIR}/tiangong-backup-${TIMESTAMP}.tar.gz.enc"

mkdir -p "${OUTPUT_DIR}"

if [ -z "${PASSWORD}" ]; then
  echo "❌ 错误：未设置备份密码"
  echo "   请通过环境变量 BACKUP_PASS 或第二个参数传入密码"
  exit 1
fi

echo "🔐 天宫数据备份（加密）- ${TIMESTAMP}"
echo "======================================"
echo "目标: ${BASE_URL}"
echo "输出: ${ARCHIVE}"
echo ""

# 备份函数
backup_endpoint() {
  local name="$1"
  local endpoint="$2"
  local file="${TEMP_DIR}/${name}.json"
  
  echo "  📥 ${name}..."
  if curl -s -f -o "${file}" "${BASE_URL}${endpoint}" 2>/dev/null; then
    local count=$(python3 -c "
import json
d=json.load(open('${file}'))
r=d.get('result',{}).get('data',[])
print(len(r) if isinstance(r, list) else 1)
" 2>/dev/null || echo "?")
    echo "    ✅ ${count} 条记录"
  else
    echo "    ⚠️  跳过（无数据或端点不可用）"
    rm -f "${file}"
  fi
}

# 备份所有核心数据
backup_endpoint "agents" "/api/trpc/agent.list"
backup_endpoint "pricing" "/api/trpc/pricing.list"
backup_endpoint "tasks" "/api/trpc/task.list?limit=1000"
backup_endpoint "usage" "/api/trpc/usage.list?limit=1000"
backup_endpoint "usage_by_model" "/api/trpc/usage.byModel"
backup_endpoint "usage_by_agent" "/api/trpc/usage.byAgent"

# 生成恢复脚本
RESTORE_SCRIPT="${TEMP_DIR}/restore.sh"
cat > "${RESTORE_SCRIPT}" << 'RESTORE_EOF'
#!/usr/bin/env bash
# 天宫数据恢复脚本
# 用法: 先解密: openssl enc -d -aes-256-cbc -pbkdf2 -in backup.tar.gz.enc -out backup.tar.gz
#       然后: tar xzf backup.tar.gz
#       最后: bash restore.sh <base_url>

BASE_URL="${1:-https://tiangg.zeabur.app}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "🔄 天宫数据恢复"
echo "目标: ${BASE_URL}"
echo ""

# 恢复 Agent
if [ -f "${SCRIPT_DIR}/agents.json" ]; then
  echo "📥 恢复 Agent..."
  python3 -c "
import json
data=json.load(open('${SCRIPT_DIR}/agents.json'))
agents=data.get('result',{}).get('data',[])
for a in agents:
    print(json.dumps({'name':a.get('name'),'agentId':a.get('agentId'),'source':a.get('source','openclaw'),'status':'idle','system':a.get('system','openclaw')}))
" | while read -r payload; do
    [ -z "$payload" ] && continue
    curl -s -X POST "${BASE_URL}/api/trpc/agent.create" \
      -H "Content-Type: application/json" \
      -d "${payload}" > /dev/null
    echo "  ✅ $(echo $payload | python3 -c "import json,sys;print(json.load(sys.stdin).get('name','?'))")"
  done
fi

# 恢复定价表
if [ -f "${SCRIPT_DIR}/pricing.json" ]; then
  echo "📥 恢复定价表..."
  python3 -c "
import json
data=json.load(open('${SCRIPT_DIR}/pricing.json'))
rows=data.get('result',{}).get('data',[])
for r in rows:
    item = {k:v for k,v in r.items() if k in ('model','provider','inputPrice','outputPrice','cachedInputPrice','notes') and v is not None}
    if item:
        print(json.dumps(item))
" | while read -r payload; do
    [ -z "$payload" ] && continue
    curl -s -X POST "${BASE_URL}/api/trpc/pricing.upsert" \
      -H "Content-Type: application/json" \
      -d "${payload}" > /dev/null
  done
  echo "  ✅ 定价表恢复完成"
fi

echo ""
echo "✅ 恢复完成"
RESTORE_EOF
chmod +x "${RESTORE_SCRIPT}"

# 打包并加密
echo ""
echo "🔒 加密打包..."
cd "${TEMP_DIR}"
tar czf backup.tar.gz *.json restore.sh 2>/dev/null || true
openssl enc -aes-256-cbc -pbkdf2 -salt \
  -in backup.tar.gz \
  -out "${ARCHIVE}" \
  -pass "pass:${PASSWORD}"
cd - > /dev/null

# 清理临时文件
rm -rf "${TEMP_DIR}"

echo ""
echo "📊 备份摘要"
echo "======================================"
ls -lh "${ARCHIVE}"
echo ""
echo "✅ 备份完成！"
echo ""
echo "提交到 GitHub:"
echo "  cd ${OUTPUT_DIR}"
echo "  git add $(basename ${ARCHIVE})"
echo "  git commit -m \"backup: 天宫数据 ${TIMESTAMP}\""
echo "  git push"
echo ""
echo "🔑 恢复命令:"
echo "  openssl enc -d -aes-256-cbc -pbkdf2 -in ${ARCHIVE} -out backup.tar.gz"
echo "  tar xzf backup.tar.gz"
echo "  bash restore.sh https://tiangg.zeabur.app"
