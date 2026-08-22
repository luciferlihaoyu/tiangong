# 天宫 · 全链路自动化闭环 — 断点修复实施报告

> 版本：2026-08-22
> 基于：`main @ 4de3f7c`（全部结论已逐行核实源码，非文档推断）
> 目标闭环：**自动发布任务 → 外系统 Agent 自动认领 → 执行 → 完成自动回写 → 自动汇总输出成果 → 重要成果上传 AList + 相关记忆写璇玑**
> 本文档自包含：先给逐环体检结论，再给断点清单与分阶段实施方案，每项含动机、涉及文件（精确到行）、具体改动与验收标准，可直接交给开发工具执行。

---

## 实施状态（2026-08-22 更新）

**P0 阶段一（五个任务）已全部实施并通过独立两阶段评审（规格符合度 + 代码质量），全量回归 45 文件 371 测试绿、tsc/esbuild/eslint 通过：**

| 任务 | 状态 | 落点 |
|---|---|---|
| 1.1 钩子收敛 finalizeCompletedTask | ✅ 已实施 | `api/lib/task-finalize.ts` 新建；6 完成路径全部收敛，AList 断链随收敛修复 |
| 1.2 AList 补偿 sweeper | ✅ 已实施 | `api/lib/sweepers/alist-compensation.ts` 新建 + config/scheduler 注册；顺带修复 fake-db 测试基础设施的 or/and 短路求值 bug |
| 1.3 汇总接线 + 双归档 | ✅ 已实施 | `maybeSummarizeParent` 挂 finalize 尾部；`autoSummarizeCollab` 加幂等闸 + collab_summary artifact + 父任务 finalize（动态 import 解循环依赖，esbuild 实测内联可行） |
| 1.4 外部用量记账 + 预算停放 | ✅ 已实施 | `api/lib/external-usage.ts` 新建（token_usage + spentCents 原子递增，两路径共用 microsToCents）；claimTask/updateHeartbeat 两入口预算熔断（轻量方案：跳过认领+reason，不锁死） |
| 1.5 长输出通道 | ✅ 已实施 | updateProgress 增 artifacts 入参（≤5 条×50K，MCP Key 越权防护）；dsh-poller 长输出分段 + DSH_MODEL usage 透传 |

**遗留跟进（非阻塞）**：recordTianshuUsage 递增缺直接单测；taskArtifacts.content 的 50K CJK 字符 vs MySQL TEXT 64KB 字节上限建议按字节加固；api/lib/artifacts/artifact-sealer.ts 为零调用死代码待清理。

---

## 0. 闭环体检总览

```
[1 自动发布] ──→ [2 外部认领] ──→ [3 执行] ──→ [4 完成回写] ──→ [5 自动汇总] ──→ [6a AList 归档]
   ✅ 已通          ✅ 已通          ✅ 已通        ⚠️ 半通          ❌ 死代码         ❌ 外部路径断链
                                                                                  │
                                                                       [6b 璇玑记忆]
                                                                         ✅ 已通 + 有补偿
```

| 环节 | 判定 | 一句话结论 |
|---|---|---|
| 1 自动发布 | ✅ | `TIANGONG_AUTO_DISPATCH` 默认开，pending(created) 经审批闸门自动转 queued |
| 2 外部认领 | ✅ | 心跳顺带认领（`agent.updateHeartbeat` 返回 `claimedTask`），MCP Key 与 agent 匹配校验已有 |
| 3 执行 | ✅ | dsh-poller spawn dsh CLI，超时兜底；但输出硬截断 12KB |
| 4 完成回写 | ⚠️ | 回写与完成闸门正常；**但该路径不记用量 → 预算熔断对外部执行体失效** |
| 5 自动汇总 | ❌ | `autoSummarizeCollab` 已完整实现但**零调用者**；且即使接线，它直接 `db.update` 父任务，绕过全部归档钩子 |
| 6a AList | ❌ | `syncTaskArtifactsToAlist` 只挂在内部 Runner 路径；**外部（dsh）完成的任务不上传 AList**，dsh-poller 注释声称会上传——与实现不符 |
| 6b 璇玑 | ✅ | 外部路径有同步 + memory-compensation sweeper 兜底；缺口是失败教训不写入 |

**核心结论：闭环的前四环已通，后两环（汇总 + AList）在外部执行路径上是断的。用户感知会是——dsh 任务跑完了、璇玑有记忆，但网盘里永远空着，父任务也永远没人汇总。**

---

## 1. 逐环体检详情

### 环节 1：自动发布 ✅

- 路径：`task.create` / `orch.createTask` → `pending(created)` → task-runner tick（`TIANGONG_AUTO_DISPATCH` 默认开）→ 审批闸门（`api/lib/execution-gate.ts`，规则见 `api/lib/approval-policy.ts`）→ `queued`
- 外部认领型 agent（`source=dsh-runner`，`TIANGONG_EXTERNAL_CLAIM_SOURCES` 可配）的任务内部 Runner 不抢（`api/lib/task-runner.ts:115-117`）
- 高风险任务停放 `boardStatus=blocked`，`taskboard.approve` 放行
- 无需改动。

### 环节 2：外系统自动认领 ✅

- dsh-poller 每 5s 心跳：`agent.updateHeartbeat`（`api/agent-router.ts:318`）顺带返回 `claimedTask`（内部走 `findClaimableTask`，含审批闸门拦截）
- 认领时 MCP Key 与 agentId 匹配校验已有（`api/agent-router.ts:262-268`：Key 绑定的 agent 不匹配直接 FORBIDDEN）
- 认领即置 `running` + agent `busy`；外部状态机完整（`api/lib/external-task-lifecycle.ts` 的 `EXTERNAL_STATES` + 20 条合法迁移）
- 缺口（阶段二处理）：dsh 在执行循环内**无法反查天宫**——MCP server（`api/mcp/server.ts`，现有 22 个工具）没有 `claim_task` / `read_alist` / `search_xuanji`，dsh 拿不到知识上下文也读不了网盘文件。

### 环节 3：执行 ✅（一处硬伤）

- dsh-poller 把任务 input/description 拼成提示词写临时文件 → `DSH_CMD` 模板执行 → 超时 SIGKILL（默认 600s）
- **硬伤**：回写 `output.slice(0, 12000)`——超过 12KB 的长成果直接丢尾。且外部系统没有任何通道提交大产物（`api/artifact-router.ts:72` 的 `create` 是 `userQuery`，仅登录用户可用，MCP Key 不行）。

### 环节 4：完成自动回写 ⚠️（两处断点）

回写链路本身正常：dsh-poller → `task.updateProgress`（`api/task-router.ts:214`）→ 完成闸门拦截高风险 self-approve → `done/completed`。

**断点 ③（用量）**：内部 Runner 有 `recordUsage` 把天枢 usage 写 `token_usage` 表并更新 `spentCents`（`api/lib/task-runner.ts:1070-1097`）；外部路径**完全没有等价物**。后果链：外部任务的模型消耗不进 `agent.spentCents` → `guard_check` 的预算硬熔断（`api/guard-router.ts:311-317`，已实现且有效）对外部执行体**形同虚设**——因为查到的 spent 永远是旧值。

**附带**：认领侧也没有任务级预算检查（超预算 agent 照样能认领新任务）。

### 环节 5：自动汇总 ❌（死代码 + 幽灵绕行）

- `autoSummarizeCollab`（`api/lib/task-validator.ts:153-235`）功能完整：等全部子任务终态 → 生成汇总文本（含每个子任务状态/输出/错误）→ 写父任务 `output` 并置 `status=done/failed` → 广播 `collab_summary` 事件
- 但**全仓库零调用者**（`collab.summary` tRPC 路由只是手动查询）——父任务永远不会被自动汇总
- 更深的坑：它写父任务用的是裸 `db.update`，**不经过任何完成钩子**——就算今天把调用接上，汇总结果也不会上传 AList、不会写璇玑（见环节 6a 的根因分析）

### 环节 6a：重要成果上传 AList ❌（外部路径断链 + 文档误导）

`syncTaskArtifactsToAlist`（`api/lib/alist-sync.ts`，含幂等标记 `task_artifacts.type='alist_sync'`、ensureDir、50MB 上限、非致命保证）质量没问题，问题在**调用点覆盖面**：

| 完成路径 | 位置 | 璇玑同步 | AList 同步 |
|---|---|---|---|
| 内部 Runner 执行完成 | `task-runner.ts:545` / `:558` | ✅ | ✅ |
| `task.updateProgress`（**dsh-poller 走这里**） | `task-router.ts:250` | ✅ | ❌ |
| `task.approve` | `task-router.ts:393` | ✅ | ❌ |
| `taskboard.approve`（高风险放行） | `taskboard-router.ts:470, :589` | ✅ | ❌ |
| A2A 提交 | `a2a-router.ts:456` | ✅ | ❌ |
| 补偿 sweeper | `sweepers/memory-compensation.ts` | ✅ | ❌ |
| 手动强制重传 | `alist-router.ts:117` | — | ✅（唯一兜底，需人工点） |

即：**六条完成路径里五条只挂了璇玑、漏了 AList**。`scripts/dsh-poller.mjs` 头部注释声称"AList 产物上传由 task-runner 侧的钩子负责"——对外部认领任务不成立，属于文档性 bug。

根因不是"漏写一行"，而是**完成钩子被复制到了六个调用点，新增同步能力时逐点手动补、补漏了**。修复必须收敛钩子（见方案 1.1），否则下次再加接收端还会漂移。

### 环节 6b：相关记忆写璇玑 ✅（一处缺口）

- 所有完成路径都挂了 `syncTaskMemoryToXuanji`（traceId 溯源、task_artifacts 幂等、非致命）
- 有 `memory-compensation` sweeper 兜底璇玑宕机期间的漏写
- 缺口：**只有 `done` 任务写入**——失败原因、人工驳回意见不进璇玑，同类任务检索不到教训（阶段三处理）

---

## 2. 断点清单（按严重度）

| # | 断点 | 严重度 | 影响 |
|---|---|---|---|
| ① | AList 上传在外部/审批/A2A 路径全部缺失 | **硬** | dsh 任务成果永远不上网盘；高风险任务审批放行后也不传 |
| ② | 自动汇总零调用 + 汇总写入绕过归档钩子 | **硬** | 父任务无产出；即使接线成果也不归档 |
| ③ | 外部路径零用量记账 | **硬** | 预算熔断对外部执行体失效，成本失控风险 |
| ④ | 12KB 输出截断 + 外部无产物提交通道 | 弱 | 长报告/代码类成果丢失 |
| ⑤ | MCP 工具面缺 claim/alist/xuanji | 弱 | dsh 循环内拿不到知识上下文（原报告 P0 1.2） |
| ⑥ | 失败教训不写璇玑 | 弱 | 知识闭环只记成功不记失败 |

---

## 3. 实施方案

### 阶段一（P0）：接通断链 —— 让闭环真正转起来（约 3 个工作日）

#### 任务 1.1 收敛完成钩子为 `finalizeCompletedTask()` 【根治，最优先】

- **动机**：断点①的根因是钩子复制漂移。先收敛，后续所有接收端（AList/璇玑/汇总/未来的通知）只改一处。
- **涉及**：新建 `api/lib/task-finalize.ts`；改 `task-runner.ts:545-570`、`task-router.ts:250`、`task-router.ts:393`、`taskboard-router.ts:470,589`、`a2a-router.ts:456` 六个调用点
- **改动**：
  ```ts
  // api/lib/task-finalize.ts（伪代码示意）
  export async function finalizeCompletedTask(db: Db, task: TaskRow): Promise<void> {
    await syncTaskMemoryToXuanji(db, task);      // 现有
    await syncTaskArtifactsToAlist(db, task);    // 新增——六个调用点从此全覆盖
    await maybeSummarizeParent(db, task);        // 任务 1.3
  }
  ```
  六个调用点替换为对 helper 的一次调用；两个 sync 各自的幂等标记（task_artifacts type 检查）保持不变——它们是补偿 sweeper 的基石。
- **验收**：`grep -rn "syncTaskMemoryToXuanji" api/ --include="*.ts"` 只剩 `task-finalize.ts` 一个业务调用点（sync 模块与 sweeper 自身除外）；现有测试全绿。

#### 任务 1.2 AList 补偿 sweeper（镜像璇玑的兜底）

- **动机**：AList 宕机期间完成的任务目前永久漏传（璇玑有补偿、AList 没有，能力不对称）。
- **涉及**：新建 `api/lib/sweepers/alist-compensation.ts`（照抄 `memory-compensation.ts` 结构：lookback 窗口扫描 → 跳过已有 `alist_sync` 标记的 → 逐个 `syncTaskArtifactsToAlist`，MAX_SCAN=20 / MAX_SYNC=5）；`api/lib/sweepers/scheduler.ts` 注册进 sweep 列表
- **验收**：单测——完成任务但无 alist_sync 标记 → sweeper tick 后标记出现；已有标记的任务不被重复上传。

#### 任务 1.3 接线自动汇总 + 汇总结果双归档

- **动机**：激活死代码（断点②），并堵住"汇总绕过归档"的幽灵路径。
- **涉及**：`api/lib/task-finalize.ts`（新 helper 内）；`api/lib/task-validator.ts`
- **改动**：
  1. `finalizeCompletedTask` 末尾：若 `task.parentTaskId != null` → 调 `autoSummarizeCollab(parentTaskId)`（其内部在"尚有子任务未终态"时自动 no-op，天然防误触发）
  2. `autoSummarizeCollab` 生成汇总、更新父任务后，**追加两步**：把汇总文本写一条 `task_artifacts`（type=`collab_summary`，内容=汇总正文）到父任务；然后对父任务调 `finalizeCompletedTask`——汇总报告由此自动流经 AList（`tasks/{parentTaskId}/output.md` + `artifacts/collab_summary-*.md`）和璇玑
  3. 幂等：并发完成多个子任务时可能重复触发；以 `task_artifacts` 中 type=`collab_summary` 是否已存在为闸（写入前 select 检查），重复调用直接返回上次结果。汇总内容确定性重建无害，但避免重复广播/重复归档。
- **验收**：父任务 + 3 子任务（DAG）全部完成后 5s 内：父任务 `output` 为汇总文本、status=done；`task_artifacts` 出现 `collab_summary`；AList 出现父任务目录；璇玑可按 traceId 检索到。

#### 任务 1.4 外部用量记账 + 认领预算检查（断点③）

- **动机**：让预算熔断对外部执行体生效。模型侧真实用量在天枢（dsh 的模型端点按 poller 文档建议配成天枢 OpenAI 兼容地址），天宫侧至少要拿到"任务级"账。
- **涉及**：`api/task-router.ts`（updateProgress input 扩展）、`scripts/dsh-poller.mjs`、`api/agent-router.ts`（claimTask）、`api/lib/model-pricing.ts`（已有，定价查询）
- **改动**：
  1. `task.updateProgress` input 增加可选 `usage: { promptTokens, completionTokens, model? }`；服务端按 `model-pricing` 折算 cost_micros 写 `token_usage` + `agents.spentCents += cost`（复用 task-runner 的记账逻辑，抽公共函数）
  2. dsh-poller：dsh 若以 JSON 输出模式运行可解析 usage 则带上；解析不到则不带（天宫侧记 0，不阻塞）
  3. `claimTask`（`agent-router.ts:258`）认领前检查：`spentCents >= budgetCents`（budget>0 时）→ 不返回任务，返回 `{ task: null, reason: "budget_exhausted" }` 并把该 agent 的待认领任务停放（boardStatus=blocked，reason 标预算）——这就是"任务级预算停放"
- **验收**：带 usage 的 updateProgress 后 `token_usage` 有行、`spentCents` 增长；把测试 agent 预算调到低于已耗时，心跳不再返回任务且任务被停放。

#### 任务 1.5 长输出通道（断点④）

- **动机**：12KB 截断丢成果；外部无产物提交端点。
- **涉及**：`api/task-router.ts` 或 `api/artifact-router.ts`、`scripts/dsh-poller.mjs`
- **改动**：
  1. `task.updateProgress` 增加可选 `artifacts: [{ name, content, mimeType? }]`（每条 ≤50KB，单次 ≤5 条）：写 `task_artifacts` 表——这些产物随后被任务 1.1 的 AList 同步自动捡走（`alist-sync.ts` 本来就会遍历 task_artifacts 上传），零额外工作
  2. dsh-poller：输出 >10KB 时，inline 只留前 10KB + 截断说明，全文作为 `full-output.md` artifact 提交
  3. 鉴权：走既有 MCP Key（`authedQuery` 已接受 API Key，`middleware.ts:128-131`），但服务端必须校验"该 Key 绑定的 agent 正是此任务的认领人"，防止越权写他人任务产物
- **验收**：造一份 30KB 输出经 poller 回写 → AList `tasks/{taskId}/artifacts/full-output.md` 完整无截断。

### 阶段二（P1）：MCP 互通 —— dsh 循环内可回调天宫（约 1.5 个工作日）

#### 任务 2.1 执行面工具：`claim_task` / `report_progress` / `submit_artifact`

- **涉及**：`api/mcp/server.ts`（新增三个 server.tool）、复用对应 tRPC 逻辑
- **关键设计**：权限收窄——工具内部强制 `ctx.apiKeyAgentId` 优先（与 `agent.claimTask` 现有校验同一原则）：agent Key 只能认领/回写自己的任务，admin Key 才可跨 agent。绝不复用宽松版入参。
- **验收**：A agent 的 Key 调 `claim_task(agentId=B)` 返回 FORBIDDEN；正常认领-回写-提交产物链路通。

#### 任务 2.2 知识面工具：`read_alist` / `search_xuanji`

- **涉及**：`api/mcp/server.ts`；底层直接包 `connectors/alist`（列目录/读文件，路径约束在配置 basePath 内防穿越）与 `memory.xuanjiSearchContext`（`memory-router.ts:121` 已有 keyword/vector/hybrid）
- **收益**：dsh 执行任务前先 `search_xuanji` 检索同类任务记忆 → 权限与记账始终卡在天宫，密钥不进执行层（原报告 1.2 的目标）

#### 任务 2.3 重要成果分级

- **动机**：用户要求的是"**重要**成果上传 AList"，不是所有产物无差别堆网盘。
- **涉及**：`api/contracts/platform.ts`（TaskMetadata 加 `importance: "normal" | "important"`，zod 兼容缺省）、`api/lib/alist-sync.ts`、任务创建入口
- **改动**：全量产物仍按现状传 `tasks/{taskId}/`（保完整档案）；`importance=important` 的任务额外把 output.md 复制一份到 `{basePath}/highlights/{YYYY-MM-DD}-{taskId}-{任务名}.md`，便于人直接翻阅精华。判定来源：创建时人工标记，或任务描述含"报告/汇报/总结/重要"由审批策略同类关键词规则推断。
- **验收**：标记 important 的任务完成后 highlights 目录出现对应文件。

### 阶段三（P2）：质量反哺（约 1 个工作日）

#### 任务 3.1 失败教训写璇玑（断点⑥）

- **涉及**：`api/lib/task-finalize.ts`、`api/lib/xuanji-sync.ts`
- **改动**：finalize 对 `status=failed` 的任务也调 `syncTaskMemoryToXuanji`（请求体带 `status: "failed"` + error 摘要，璇玑侧文档标 kind=lesson）；人工驳回（`taskboard.approve` 拒绝分支）同样写入驳回意见。幂等标记复用现有 `xuanji_memory` artifact 机制，注意一个任务成功/失败只写一次。
- **验收**：失败任务完成后璇玑可检索到含失败原因的文档；后续同类任务的 `search_xuanji` 能命中。

#### 任务 3.2 汇总报告强化（可选）

- 汇总文本已随任务 1.3 双归档；若要更细，可在 `autoSummarizeCollab` 里对每个子任务的 output 摘要从"截断前 500 字"升级为调用一次天枢模型生成两句话总结（天枢调用已有完整封装与计费，注意这笔调用本身也要过 guard_check 记账）。

---

## 4. 端到端验收场景（全部通过 = 闭环交付）

1. 创建父任务 + 3 个子任务（DAG 依赖）分配给 `source=dsh-runner` 的 agent
2. 观察：子任务自动 queued（无需人工）→ dsh-poller 心跳认领 → dsh 执行 → `updateProgress` 回写 done
3. 带 usage 回写后：`token_usage` 有记录、`agents.spentCents` 增长
4. 第 3 个子任务完成 5s 内：父任务 output 变为汇总、status=done、出现 `collab_summary` artifact
5. **AList 检查（回归断点①）**：`{basePath}/tasks/{子任务taskId}/output.md` 与父任务目录都存在——这是外部执行路径，此前永远不会出现
6. `importance=important` 的任务：`highlights/` 目录出现精华文件
7. 璇玑检查：成功任务 + 失败任务（人为造一个）都能按 traceId 检索到
8. 高风险测试：子任务描述含 "git push" → 认领/完成被闸门拦截、boardStatus=blocked → `taskboard.approve` 放行后**产物仍正常上传 AList**（回归 taskboard 路径的同步缺口）
9. 韧性测试：停 AList → 完成任务 → 恢复 AList → alist-compensation sweeper 在一个 tick 内补传

## 5. 工作量与顺序

| 顺序 | 任务 | 估计 | 依赖 |
|---|---|---|---|
| 1 | 1.1 钩子收敛（含断点①修复） | 0.5 天 | 无 |
| 2 | 1.2 AList 补偿 sweeper | 0.25 天 | 1.1 |
| 3 | 1.3 汇总接线 + 双归档 | 0.5 天 | 1.1 |
| 4 | 1.5 长输出通道 | 0.5 天 | 1.1（产物随 AList 同步走） |
| 5 | 1.4 用量记账 + 预算停放 | 1 天 | 无（可与 3/4 并行） |
| 6 | 2.1–2.3 MCP 工具 + 分级 | 1.5 天 | 建议在 1.1 后 |
| 7 | 3.1 失败教训 | 0.5 天 | 1.1 |

阶段一合计约 3 天即可拿到完整闭环；2/3 阶段按需跟进。

## 6. 排雷提示（在原报告三条之上新增）

1. **完成钩子必须收敛单一 helper**——本次 AList 断链的根因就是六处复制漂移；任何"再挂一个完成监听"的需求都改 `task-finalize.ts` 一处
2. **`autoSummarizeCollab` 直接 `db.update` 父任务**——重构时务必让它走 finalize 路径，否则汇总永远不归档
3. **两个 sync 的 `task_artifacts` 幂等标记是补偿 sweeper 的基石**——动表结构或改类型值会让补偿逻辑双写
4. **`artifact.create` 是 `userQuery`（仅登录）**——放开给外部 Key 时必须校验"Key 绑定 agent 已认领该任务"，否则开越权写洞
5. 原有三条继续有效：MySQL SUM 需 `Number()` 强转；AList `fs/put` 前必须 ensureDir（`alistUpload` 已封装，复用勿重写）；凭证一律环境变量/secret-vault/界面配置，不进 git
6. dsh 仍是 v0.1.0-rc：所有 dsh 侧改动集中在 `scripts/dsh-poller.mjs` 与 MCP 工具层两个适配点，接口变更时只动这两处
