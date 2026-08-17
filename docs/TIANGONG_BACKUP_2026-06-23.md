# 天宫科技 — 公司架构与助手信息

> 备份日期：2026-06-23
> 来源：天宫线上平台 `https://tiangg.zeabur.app`

## 组织架构

### 天宫科技（ID=1）
多系统 AI Agent 公司化协作中枢
目标：统一接入 OpenClaw、Hermes Agent、ArkClaw 等系统，实现多助手协作完成任务

### 部门与成员

#### 📁 总裁办/系统架构部（ID=1）
- **主管：后土** (ID=14, agentId=`meixizi`, OpenClaw=`meixizi`)
- 角色：CEO — 公司总裁，统筹全局
- 汇报给：无（最高层）

#### 📁 技术部（ID=2）
- **主管：女娲** (ID=1, agentId=`meizhizi`, OpenClaw=`meizhizi`)
- 角色：CTO — 技术部负责人，管理编程大师和羲和
- 汇报给：后土
- **成员：编程大师** (ID=2, agentId=`codemaster`, OpenClaw=`codemaster`)
  - 角色：高级工程师 — 代码实现与审查
  - 汇报给：女娲
- **成员：羲和** (ID=13, agentId=`xihe`, 系统=`hermes`)
  - 角色：工程师 — Hermes Agent 系统接入
  - 汇报给：女娲

#### 📁 创意部（ID=3）
- **主管：精卫** (ID=10, agentId=`jingwei`, OpenClaw=`jingwei`)
- 角色：创意部主管 — 创意设计与视觉
- 汇报给：后土
- **成员：云霄** (ID=7, agentId=`yunxiao`, OpenClaw=`yunxiao`)
  - 角色：创意设计师 — 协助精卫
  - 汇报给：精卫

#### 📁 文学创作部（ID=4）
- **主管：上衫绘梨衣** (ID=15, agentId=`sumu`, OpenClaw=`sumu`)
- 角色：文学创作部主管 — 内容创作
- 汇报给：后土

#### 📁 平台运营部（ID=5）
- **主管：上官婉儿** (ID=4, agentId=`shangguan`, OpenClaw=`shangguan`)
- 角色：平台运营部主管 — 运营与文案
- 汇报给：后土

#### 📁 财务法务部（ID=6）
- **主管：美成子** (ID=9, agentId=`meichengzi`, OpenClaw=`meichengzi`)
- 角色：财务法务部主管 — 财务与法务
- 汇报给：后土

#### 📁 秘书与知识库部（ID=7）
- **主管：薇子** (ID=8, agentId=`weizi`, OpenClaw=`weizi`)
- 角色：秘书与知识库部主管 — 管理碧霄和琼霄
- 汇报给：后土
- **成员：碧霄** (ID=12, agentId=`bixiao`, 系统=`arkclaw`)
  - 角色：知识库专员 — ArkClaw 系统接入
  - 汇报给：薇子
- **成员：琼霄** (ID=6, agentId=`qiongxiao`, OpenClaw=`qiongxiao`)
  - 角色：生活秘书 — 日常事务与生活管理
  - 汇报给：薇子

## 助手对应关系总表

| 天宫 ID | agentId | 名称 | 系统 | OpenClaw 助手 | 部门 | 岗位 |
|---|---|---|---|---|---|---|
| 1 | meizhizi | 女娲 | openclaw | meizhizi | 技术部 | CTO |
| 2 | codemaster | 编程大师 | openclaw | codemaster | 技术部 | 高级工程师 |
| 4 | shangguan | 上官婉儿 | openclaw | shangguan | 平台运营部 | 主管 |
| 6 | qiongxiao | 琼霄 | openclaw | qiongxiao | 秘书与知识库部 | 生活秘书 |
| 7 | yunxiao | 云霄 | openclaw | yunxiao | 创意部 | 创意设计师 |
| 8 | weizi | 薇子 | openclaw | weizi | 秘书与知识库部 | 主管 |
| 9 | meichengzi | 美成子 | openclaw | meichengzi | 财务法务部 | 主管 |
| 10 | jingwei | 精卫 | openclaw | jingwei | 创意部 | 主管 |
| 12 | bixiao | 碧霄 | arkclaw | — | 秘书与知识库部 | 知识库专员 |
| 13 | xihe | 羲和 | hermes | — | 技术部 | 工程师 |
| 14 | meixizi | 后土 | openclaw | meixizi | 总裁办 | CEO |
| 15 | sumu | 上衫绘梨衣 | openclaw | sumu | 文学创作部 | 主管 |

## Connector 配置

### MCP Key 管理
- 所有 Key 通过天宫 `mcp.createKey` API 生成
- 明文存储在 `~/.openclaw/secrets/tiangong-openclaw-agents.json`（0600 权限）
- 天宫 Agent 字段仅记录 `mcp-key-id:*` 引用

### 启动方式
- 启动脚本：`scripts/openclaw-connector/start-openclaw-agents.sh`
- 每个 Agent 独立进程，通过 WebSocket 连接天宫
- 心跳间隔：30s
- 成本守卫：默认 `claim_tasks=false`，需显式启用

### 运行环境
- OpenClaw 运行在 Zeabur `openclaw` 项目
- 天宫运行在 Zeabur `tiangg` 项目
- 数据库：tiangg 项目的 MySQL（跨项目内部网络连接）
- 线上地址：`https://tiangg.zeabur.app`
