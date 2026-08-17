# TIANGONG P8.2 — 协作任务编排 (Collaboration Orchestration)

> **状态**: 本地实现完成  
> **日期**: 2026-06-14  
> **依赖**: P8.1 可靠消息总线

## 1. 目标

P8.2 在 P8.1 的可靠消息总线之上，提供一个最小可验收的多 Agent 协作闭环：

1. 将一个父任务/mission 拆解为多个显式子任务。
2. 子任务分配给指定 Agent，并进入现有任务认领流程。
3. 创建子任务时发送绑定 `taskId/correlationId/idempotencyKey` 的 command message。
4. 查询 parent mission 下的子任务、Agent、消息投递/ACK 状态。
5. 对完成/失败的子任务做结构化汇总。

P8.2 不做 LLM 自动拆解，不切生产 runner，不修改 Gateway/Zeabur 配置。

## 2. 数据模型

P8.2 复用现有表，不新增大表：

- `tasks.parentTaskId`：父任务到子任务的层级关系。
- `task_dependencies`：子任务间依赖关系。
- `messages.taskId`：委托消息绑定子任务。
- `messages.correlationId`：一次 mission 的协作关联 ID。
- `messages.idempotencyKey`：防止重复委托产生重复消息。

## 3. API

### 3.1 `collab.delegate`

将父任务拆成多个子任务，并向对应 Agent 发送委托消息。

```ts
input: {
  parentTaskId: number;
  coordinatorAgentId: number;
  correlationId?: string;
  subtasks: Array<{
    title: string;
    description?: string;
    assigneeAgentId: number;
    priority?: number;
    input?: string;
    dependencies?: number[];
  }>;
}
```

语义：

- 子任务 `taskId` 使用短格式 `C{base36ParentId}-{base36Index}` 生成，避免超过 `tasks.taskId varchar(20)`。
- 委托消息 `idempotencyKey` 使用 `collab:{parentTaskId}:{index}:{title}` 生成。
- 重复调用同一父任务/同一 index/title 不重复创建消息。
- 无依赖或依赖已完成的子任务进入 `queued`，可被现有 connector 认领。
- 依赖未完成的子任务保持 `pending`。

返回：

```ts
{
  success: true;
  parentTaskId: number;
  correlationId: string;
  subtasks: Array<{
    index: number;
    taskId: number;
    taskKey: string;
    messageId: number | null;
    idempotent: boolean;
    status: string;
  }>;
}
```

### 3.2 `collab.status`

查询一个 parent mission 的协作状态。

```ts
input: { parentTaskId: number }
```

返回：

- `parent`：父任务。
- `counts`：子任务状态计数。
- `subtasks[]`：子任务、Agent、依赖、委托消息、`messageStatus/ackedAt/deliveredAt`。

### 3.3 `collab.summary`

结构化汇总一个 parent mission。

```ts
input: { parentTaskId: number }
```

返回：

- `overallStatus`: `empty | running | done | failed`
- `counts`: 子任务状态计数
- `outputs[]`: 已写 output 的子任务输出
- `errors[]`: failed 或有 error 的子任务错误
- `messageCounts`: 关联消息状态计数

### 3.4 `collab.unblockReady`

重新检查 parent mission 下 pending 子任务的依赖，如果依赖都 done，则切为 `queued`。

```ts
input: { parentTaskId: number }
```

## 4. 数据流

```text
parent task
  └─ collab.delegate
       ├─ create child tasks (queued/pending)
       ├─ create task_dependencies
       ├─ send command messages with taskId/correlationId/idempotencyKey
       └─ existing connector claims queued tasks

agent completes task
  └─ task/orch updateStatus writes done/failed + output/error
       └─ collab.summary returns structured mission result
```

## 5. 本地验收

1. 创建一个父任务：`task.create` 或 `orch.createTask`。
2. 调用 `collab.delegate`，显式传入多个子任务和 assignee Agent。
3. 调用 `collab.status`，确认：
   - 子任务创建成功。
   - command message 绑定到 `taskId`。
   - message 有 `correlationId/idempotencyKey`。
4. 重复调用相同 `collab.delegate`，确认返回 `idempotent: true`，不重复创建消息。
5. 将子任务更新为 `done/failed` 并写入 `output/error`。
6. 调用 `collab.summary`，确认输出结构化汇总。

## 6. 边界

- 不自动调用 LLM 拆解。
- 不修改生产 runner。
- 不修改 OpenClaw Gateway 配置。
- 不修改 Zeabur env。
- 不 commit/push/deploy。
