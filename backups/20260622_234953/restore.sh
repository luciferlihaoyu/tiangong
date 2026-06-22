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
