import json
import subprocess
import time

# 1. 获取appSecret
with open('/home/node/.openclaw/openclaw.json') as f:
    config = json.load(f)
app_id = config['channels']['feishu']['accounts']['sumu']['appId']
app_secret = config['channels']['feishu']['accounts']['sumu']['appSecret']

# 2. 获取token
result = subprocess.run([
    'curl', '-s', '-X', 'POST',
    'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
    '-H', 'Content-Type: application/json',
    '-d', json.dumps({'app_id': app_id, 'app_secret': app_secret})
], capture_output=True, text=True)
token = json.loads(result.stdout)['tenant_access_token']
print('Token获取成功')

# 3. 创建文档
result = subprocess.run([
    'curl', '-s', '-X', 'POST',
    'https://open.feishu.cn/open-apis/docx/v1/documents',
    '-H', f'Authorization: Bearer {token}',
    '-H', 'Content-Type: application/json',
    '-d', json.dumps({'title': '《未命名》世界观设定集 v2.0'})
], capture_output=True, text=True)
doc_id = json.loads(result.stdout)['data']['document']['document_id']
print(f'文档创建成功: {doc_id}')

# 4. 读取设定集v2内容
with open('novels/科幻灵气复苏/设定集_v2.md', 'r') as f:
    content = f.read()

lines = content.split('\n')
blocks = []

for line in lines:
    line = line.strip()
    if not line:
        continue
    
    if line.startswith('# '):
        blocks.append({'block_type': 3, 'heading1': {'elements': [{'text_run': {'content': line[2:]}}]}})
    elif line.startswith('## '):
        blocks.append({'block_type': 4, 'heading2': {'elements': [{'text_run': {'content': line[3:]}}]}})
    elif line.startswith('### '):
        blocks.append({'block_type': 5, 'heading3': {'elements': [{'text_run': {'content': line[4:]}}]}})
    elif line.startswith('#### '):
        blocks.append({'block_type': 6, 'heading4': {'elements': [{'text_run': {'content': line[5:]}}]}})
    elif line.startswith('- ') or line.startswith('* '):
        blocks.append({'block_type': 12, 'bullet': {'elements': [{'text_run': {'content': line[2:]}}]}})
    elif line.startswith('> '):
        blocks.append({'block_type': 15, 'quote': {'elements': [{'text_run': {'content': line[2:]}}]}})
    elif line.startswith('```'):
        continue
    elif line.startswith('**') and line.endswith('**'):
        blocks.append({'block_type': 2, 'text': {'elements': [{'text_run': {'content': line[2:-2], 'text_element_style': {'bold': True}}}]}})
    else:
        blocks.append({'block_type': 2, 'text': {'elements': [{'text_run': {'content': line}}]}})

print(f'设定集共解析 {len(blocks)} 个blocks')

# 5. 分批写入设定集
batch_size = 5
for i in range(0, len(blocks), batch_size):
    batch = blocks[i:i+batch_size]
    write_data = {'children': batch, 'index': -1}
    
    with open('/tmp/feishu_write.json', 'w') as f:
        json.dump(write_data, f)
    
    subprocess.run([
        'curl', '-s', '-X', 'POST',
        f'https://open.feishu.cn/open-apis/docx/v1/documents/{doc_id}/blocks/{doc_id}/children',
        '-H', f'Authorization: Bearer {token}',
        '-H', 'Content-Type: application/json',
        '-d', '@/tmp/feishu_write.json'
    ], capture_output=True, text=True)
    
    time.sleep(0.3)

print(f'设定集写入完成！')

# 6. 创建人物与大纲文档
result = subprocess.run([
    'curl', '-s', '-X', 'POST',
    'https://open.feishu.cn/open-apis/docx/v1/documents',
    '-H', f'Authorization: Bearer {token}',
    '-H', 'Content-Type: application/json',
    '-d', json.dumps({'title': '《未命名》人物合集与大纲'})
], capture_output=True, text=True)
doc_id2 = json.loads(result.stdout)['data']['document']['document_id']
print(f'人物文档创建成功: {doc_id2}')

# 7. 读取人物与大纲内容
with open('novels/科幻灵气复苏/人物与大纲.md', 'r') as f:
    content2 = f.read()

lines2 = content2.split('\n')
blocks2 = []

for line in lines2:
    line = line.strip()
    if not line:
        continue
    
    if line.startswith('# '):
        blocks2.append({'block_type': 3, 'heading1': {'elements': [{'text_run': {'content': line[2:]}}]}})
    elif line.startswith('## '):
        blocks2.append({'block_type': 4, 'heading2': {'elements': [{'text_run': {'content': line[3:]}}]}})
    elif line.startswith('### '):
        blocks2.append({'block_type': 5, 'heading3': {'elements': [{'text_run': {'content': line[4:]}}]}})
    elif line.startswith('#### '):
        blocks2.append({'block_type': 6, 'heading4': {'elements': [{'text_run': {'content': line[5:]}}]}})
    elif line.startswith('- ') or line.startswith('* '):
        blocks2.append({'block_type': 12, 'bullet': {'elements': [{'text_run': {'content': line[2:]}}]}})
    elif line.startswith('> '):
        blocks2.append({'block_type': 15, 'quote': {'elements': [{'text_run': {'content': line[2:]}}]}})
    elif line.startswith('```'):
        continue
    elif line.startswith('**') and line.endswith('**'):
        blocks2.append({'block_type': 2, 'text': {'elements': [{'text_run': {'content': line[2:-2], 'text_element_style': {'bold': True}}}]}})
    else:
        blocks2.append({'block_type': 2, 'text': {'elements': [{'text_run': {'content': line}}]}})

print(f'人物大纲共解析 {len(blocks2)} 个blocks')

# 8. 分批写入人物文档
for i in range(0, len(blocks2), batch_size):
    batch = blocks2[i:i+batch_size]
    write_data = {'children': batch, 'index': -1}
    
    with open('/tmp/feishu_write.json', 'w') as f:
        json.dump(write_data, f)
    
    subprocess.run([
        'curl', '-s', '-X', 'POST',
        f'https://open.feishu.cn/open-apis/docx/v1/documents/{doc_id2}/blocks/{doc_id2}/children',
        '-H', f'Authorization: Bearer {token}',
        '-H', 'Content-Type: application/json',
        '-d', '@/tmp/feishu_write.json'
    ], capture_output=True, text=True)
    
    time.sleep(0.3)

print(f'人物大纲写入完成！')
print(f'\n=== 文档链接 ===')
print(f'设定集: https://open.feishu.cn/docx/{doc_id}')
print(f'人物大纲: https://open.feishu.cn/docx/{doc_id2}')
