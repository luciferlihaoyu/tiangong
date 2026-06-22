#!/usr/bin/env bash
# 天宫数据备份脚本
# 备份所有核心数据到 JSON 文件，可提交到 GitHub 仓库
# 用法: ./scripts/backup.sh [output_dir]
# 默认输出到 ./backups/

set -euo pipefail

BASE_URL="${TIANGONG_BASE_URL:-https://tiangg.zeabur.app}"
OUTPUT_DIR="${1:-backups}"
TIMESTAMP=$(date -u +"%Y%m%d_%H%M%S")
BACKUP_DIR="${OUTPUT_DIR}/${TIMESTAMP}"

mkdir -p "${BACKUP_DIR}"

echo "🔍 天宫数据备份 - ${TIMESTAMP}"
echo "================================"
echo "目标: ${BASE_URL}"
echo "输出: ${BACKUP_DIR}"
echo ""

# 备份函数
backup_endpoint() {
  local name="$1"
  local endpoint="$2"
  local file="${BACKUP_DIR}/${name}.json"
  
  echo "  📥 ${name}..."
  if curl -s -f -o "${file}" "${BASE_URL}${endpoint}" 2>/dev/null; then
    local count=$(python3 -c "import json; d=json.load(open('${file}')); r=d.get('result',{}).get('data',[]); print(len(r) if isinstance(r, list) else 1)" 2>/dev/null || echo "?")
    echo "    ✅ ${count} 条记录"
  else
    echo "    ❌ 失败"
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
backup_endpoint "mailbox" "/api/trpc/mailbox.inbox?mailboxId=meizhizi&limit=1000"

echo ""
echo "📊 备份摘要"
echo "================================"
echo "位置: ${BACKUP_DIR}"
ls -la "${BACKUP_DIR}/"
echo ""

# 生成恢复脚本
RESTORE_SCRIPT="${BACKUP_DIR}/restore.sh"
cat > "${RESTORE_SCRIPT}" << 'RESTORE_EOF'
#!/usr/bin/env bash
# 天宫数据恢复脚本
# 用法: ./restore.sh <base_url>
# 例如: ./restore.sh https://tiangg.zeabur.app

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
    print(json.dumps({k:v for k,v in r.items() if k in ('model','provider','inputPrice','outputPrice','cachedInputPrice','notes') and v is not None}))
" | while read -r payload; do
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

echo "📝 恢复脚本已生成: ${RESTORE_SCRIPT}"
echo ""
echo "✅ 备份完成！"
echo ""
echo "提交到 GitHub:"
echo "  cd ${OUTPUT_DIR}"
echo "  git add ${TIMESTAMP}/"
echo "  git commit -m \"backup: 天宫数据 ${TIMESTAMP}\""
echo "  git push"
