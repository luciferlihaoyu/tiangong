# 天宫任务分发工作流 Spec

## 概述
建立自动化的任务分发流水线：任务出现 → 后土分配 → 薇子通知 → 助手执行

## 角色职责

### 后土（CEO）
- 监控新任务队列（`status=queued` 的任务）
- 根据任务内容和各助手职责，决定分配给谁
- 将分配方案写入天宫：更新任务的 `agentId`、`status=dispatched`
- 将分配结果通过 mailbox 告知薇子

### 薇子（秘书部主管）
- 接收后土的分配通知
- 通过 mailbox 给对应助手发送任务通知
- 跟踪任务是否已被认领

### 各助手
- 收到 mailbox 通知后认领任务
- 执行任务并回写结果

## 任务状态流转
```
created → queued → dispatched → claimed → running → done/failed
```

## 技术实现

### 1. 后土分配逻辑（runner-houtu.sh）
后土的 Connector 需要增强，使其能：
- 定期扫描 `status=queued` 的任务
- 根据任务内容 + 助手职责匹配，决定分配给谁
- 调用 `task.update` 更新任务的 `agentId` 和 `status=dispatched`
- 调用 `mailbox.send` 通知薇子

### 2. 薇子通知逻辑（runner-weizi.sh）
薇子的 Connector 需要增强，使其能：
- 接收后土的 mailbox 消息
- 解析消息中的任务信息和目标助手
- 调用 `mailbox.send` 通知对应助手

### 3. 助手认领逻辑（各助手 runner）
各助手的 runner 需要增强，使其能：
- 定期检查自己的 mailbox
- 收到任务通知后，调用 `task.updateProgress` 更新状态为 claimed/running
- 执行任务
- 回写结果

## 匹配规则（后土分配策略）
根据助手职责匹配任务类型：

| 任务类型 | 分配给 |
|---------|--------|
| 代码/技术 | 女娲（CTO）→ 编程大师或羲和 |
| 创意/设计 | 精卫 |
| 文学/内容 | 上衫绘梨衣 |
| 运营/文案 | 上官婉儿 |
| 财务/法务 | 美成子 |
| 秘书/生活 | 薇子 → 琼霄或碧霄 |
| 架构/战略 | 后土自己或女娲 |

## 文件变更
1. `scripts/openclaw-connector/runner-houtu.sh` — 增强后土 runner
2. `scripts/openclaw-connector/runner-weizi.sh` — 增强薇子 runner
3. 各助手 runner — 增加 mailbox 检查和任务认领逻辑
