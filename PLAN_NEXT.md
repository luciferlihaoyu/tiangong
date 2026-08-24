# 通知中心 WebSocket 实时推送 实施计划

## 背景

通知中心 MVP 已完成 10 个 commits（#26-#35）—— schema + helper + 6 失败教训挂点 + tRPC + 5 业务挂点 + UI 5 件（hook/item/dropdown/bell/全页）。

当前 UX 限制：前端 useNotifications 用 30s `refetchInterval` 轮询，新通知最长有 30s 延迟才能在铃铛角标上看到。

本计划把"通知创建"事件经 wsManager 推到前端，bell 角标可近实时（<1s）刷新。

## 目标

`recordNotification` 写入数据库后，通过 `wsManager.broadcastToDashboard` 推送 `notification_created` 事件；前端 useWebSocket 监听该类型，调用 `useNotifications` 的 refresh（invalidate tRPC query）。轮询 30s 保留为兜底（断线/异常恢复路径）。

## 任务

### t1-backend-broadcast — recordNotification 加 wsManager 广播

- **goal**：recordNotification 成功 insert 后调 wsManager.broadcastToDashboard 推 notification_created 事件
- **files**：
  - `api/lib/notification.ts`（改）— 末尾 try/catch 内 db.insert 成功后加 broadcast
  - `tests/api/notification-ws-broadcast.test.ts`（新）— ≥3 个测试
- **change**：
  ```ts
  // api/lib/notification.ts 顶部
  import { wsManager } from "../ws-manager";

  // recordNotification 内 db.insert 成功后
  try {
    wsManager.broadcastToDashboard({
      type: "notification_created",
      notification: { id, type, agentId, taskId, title, body, metadata, readAt: null, createdAt: new Date().toISOString() },
    });
  } catch (e) {
    // broadcast 失败不影响主流程（与其他 5 挂点同模式）
    console.warn(`[notification] broadcast failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  ```
- **verify**：
  - `npx vitest run tests/api/notification-ws-broadcast.test.ts` → 至少 3 测试绿
  - 测试内容：mock wsManager，断言 broadcastToDashboard 被调一次；broadcast 异常不抛；broadcast 失败不影响 db.insert
  - 关键：broadcast 包独立 try/catch，不影响 recordNotification 主流程（永不抛错语义保持）

### t2-frontend-subscribe — useNotifications 订阅 notification_created

- **goal**：useNotifications hook 收到 `notification_created` ws 消息后，自动 invalidate tRPC list 查询
- **files**：
  - `src/hooks/useNotifications.ts`（改）— 增加 ws 订阅
  - `src/hooks/useWebSocket.ts`（不改，但需确认有 addEventListener）
- **change**：
  ```ts
  // useNotifications 内
  const { addEventListener, removeEventListener } = useWebSocket();
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "notification_created") {
          utils.agent.notifications.list.invalidate();
        }
      } catch { /* ignore malformed */ }
    };
    addEventListener("notification_created", handler);
    return () => removeEventListener("notification_created", handler);
  }, [addEventListener, removeEventListener, utils]);
  ```
- **verify**：
  - `tsc -b` exit 0
  - dev server smoke：`curl /` = 200
  - 工作树干净

### t3-integration-test — 端到端验证

- **goal**：ws 推送链路端到端可工作（fake 模式）
- **files**：
  - `tests/api/notification-ws-integration.test.ts`（新）— 1 个集成测试
- **change**：
  - 调 recordNotification，断言 wsManager.broadcastToDashboard 收到的事件结构（type/notification）
  - 用现有的 fake-dashboard-ws（如无则参考 dag-router 测试里的 mock 模式）
- **verify**：
  - `npx vitest run tests/api/notification-ws-integration.test.ts` → 1 测试绿
  - 全量 `npx vitest run` → 56+ 文件 491+ 测试全绿

## 验收

3 个 commit 全部 push（#36/37/38）：
- 后端：recordNotification 写库后推 ws 事件
- 前端：useNotifications 订阅 ws 事件并 invalidate query
- 测试：端到端集成

防 30s 延迟；轮询 30s 保留为兜底。

## 风险

- broadcast 在 db.insert 同 try 块内 → 失败会走外层 catch 兜底（永不抛错语义保持）
- 前端 listener 重复挂载 → useEffect 清理函数
- ws 断线时事件丢失 → 30s 轮询兜底（不删 refetchInterval）

## 不做

- 不做广播给特定 agent（只 dashboard 全量广播——与现有 task_update 等事件一致）
- 不改 tRPC 路由形状
- 不删 30s 轮询（兜底）
- 不引入新依赖
