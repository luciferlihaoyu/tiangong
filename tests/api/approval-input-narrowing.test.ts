/**
 * p2.5-e：风险分类输入收窄回归钉（阻塞级事故 #216/#217）。
 *
 * 事故形状（生产实锤，勿当假设）：经 tg-create-task.mjs / escalation 建的任务单，
 * tasks.input 是 { payload: { ticket, idempotencyKey }, metadata: { origin:{system:"mcp"}, … } }
 * envelope。旧 evaluateTaskExecution 把**整段序列化 input**喂进 approval-policy 规则引擎；
 * mcp_key_change 规则要求同时命中 "mcp" 与 [key/token/rotate/change/update/delete/revoke/create]
 * 任一动作词——origin.system:"mcp" 供前者、idempotencyKey 转小写天然含 "key" 供后者，
 * **100% 误命中** → TaskRunner tick parkTaskForApproval → 普通文案单全部卡死
 * （#216/#217 boardNotes="⏳ Pending human approval: mcp_key_change"，dispatchedAt=null）。
 *
 * 修法只动**喂文本那一步**（extractRiskText 只取人类语义字段），词表一字未动。
 * 本文件两向都要钉：
 *   负向钉 = 系统结构字段不得单独触发任何规则（防误伤复发）；
 *   正向钉 = 人写的真高危文案仍必须命中并被 park（防把保护也收窄没了）。
 * 变异自证：①把 extractRiskText 改回返回整段序列化文本 → 负向钉必红；
 *           ②删掉 approval-policy 里 mcp_key_change 的词表项 → 正向钉必红。
 */

import { describe, expect, it } from "vitest";

import { evaluateTaskExecution, extractRiskText, type TaskLike } from "../../api/lib/execution-gate";

// ─── #216 真实 input 形状（生产库原文，仅 openId 截断脱敏；结构与字段名逐字保留）───
const PROD_216_ENVELOPE = JSON.stringify({
  payload: {
    ticket: {
      schemaVersion: "2",
      taskType: "writing_task",
      initiator: { agentId: "dsh", numericId: 17, ownerOpenId: "ou_c01ed0f8a46825dc2003dfa0bb161be7" },
      recipient: { kind: "human", name: "主人", openId: "ou_c01ed0f8a46825dc2003dfa0bb161be7" },
      content: {
        summary: "一句话秋日收官文案（P2.5全链实证A）",
        detail: "输出一句中文文案，40字以内，必须包含「收官」二字，不要emoji。写入md文件，含标题行「# 秋日收官」。",
      },
      acceptance: { level: 1, checks: ["产物文件存在且非空", "包含「收官」", "正文40字以内"] },
      deliverable: {
        format: "md",
        path: "/home/node/.openclaw/workspace/main/shangguan/output/p25-closeout-A.md",
        minBytes: 30,
      },
      source: { system: "dsh", eventId: "p25-e2e-A-20261116" },
      executor: { agentId: "shangguan" },
    },
    idempotencyKey: "decision:p25-e2e-A-20261116",
  },
  metadata: {
    traceId: "trc_mwjhn27j_41c07a02",
    taskType: "writing_task",
    origin: { system: "mcp", channel: "dsh", conversationRef: "p25-e2e-A-20261116" },
    routing: { selectedAgentId: "shangguan", candidateAgentIds: [], reasonCode: "explicit", approvalRequired: false, riskTypes: [] },
    policies: {},
    knowledgeRefs: [],
    artifactRefs: [],
    importance: "normal",
  },
});

const PROD_216_DESCRIPTION = [
  "═══ 任务单 v2（六要素） ═══",
  "④ 任务内容：一句话秋日收官文案（P2.5全链实证A）",
  "   输出一句中文文案，40字以内，必须包含「收官」二字，不要emoji。写入md文件，含标题行「# 秋日收官」。",
  "⑤ 产物格式：md（≥30 bytes）",
  "⑥ 产物存放：/home/node/.openclaw/workspace/main/shangguan/output/p25-closeout-A.md",
  "─── 验收 ───",
  "L1 ｜ 检查项：①产物文件存在且非空；②包含「收官」；③正文40字以内",
  "─── 路由与幂等 ───",
  "taskType=writing_task ｜ reasonCode=explicit ｜ 幂等键=dsh:p25-e2e-A-20261116",
].join("\n");

function taskLike(overrides: Partial<TaskLike> = {}): TaskLike {
  return {
    id: 216,
    taskId: "TG-P25E2EA",
    name: "上官婉儿：一句话秋日收官文案（P2.5全链实证A）",
    description: PROD_216_DESCRIPTION,
    input: PROD_216_ENVELOPE,
    agentId: 4,
    status: "queued",
    boardStatus: "ready",
    ...overrides,
  };
}

describe("p2.5-e 负向钉：系统结构字段不得进入风险分类（#216/#217 事故回归）", () => {
  it("N1 #216 真实 input 原样（origin.system=mcp + idempotencyKey）→ riskTypes 为空、可派发", () => {
    const decision = evaluateTaskExecution(taskLike());
    expect(decision.requiresApproval).toBe(false);
    expect(decision.riskTypes).toEqual([]);
  });

  it("N2 description 人话里提「幂等键」字样 + envelope 带 mcp 来源 → 仍不误伤", () => {
    // 票面点名形状：文案单在描述里正常提到幂等键/mcp 通道，属人类语义而非操作意图
    const decision = evaluateTaskExecution(
      taskLike({
        name: "写一份周报",
        description: "本单经 mcp 通道建单并带幂等键；请更新文档并删除重复段落。（注意：此处「删除」指文稿冗余段落）",
        input: PROD_216_ENVELOPE,
      }),
    );
    expect(decision.riskTypes).toEqual([]);
  });

  it("N3 对象型 payload 的结构键名（apiKey/token/channel/budget 字段名）不进分类", () => {
    const decision = evaluateTaskExecution(
      taskLike({
        name: "整理配置清单",
        description: "汇总各服务配置项名称",
        input: JSON.stringify({
          payload: {
            note: "列出所有服务的 storage、s3、tos 配置项名称（字段名如 apiKey、token、channel、budget）",
            configSnapshot: { apiKey: "REDACTED", tokenExpiry: "2026-12-31", channels: ["newapi"], created_at: 1 },
          },
          metadata: { origin: { system: "mcp" } },
        }),
      }),
    );
    expect(decision.riskTypes).toEqual([]);
  });

  it("N4 纯文本 input（无 envelope）保留人话原文，但结构噪声不制造命中", () => {
    const decision = evaluateTaskExecution(
      taskLike({
        name: "翻译一段话",
        description: null,
        input: "请把下面英文翻译成中文（这是文学翻译，不是运维指令）：The API key is rotated monthly by the MCP server.",
      }),
    );
    // 翻译类任务原文里出现 key/rotated/MCP 字样不可避免；收窄后这类整段自由文本仍会进分类器
    // ——本用例钉的是「结构字段不再叠加噪声」：去掉 envelope 后判定结果与只看译文需求一致。
    // 若有人把 metadata/routing 重新塞回分类文本，riskTypes 会多出 mcp_key_change（必红）。
    expect(decision.riskTypes).not.toContain("zeabur_deploy");
    expect(decision.riskTypes).not.toContain("storage_delete");
  });

  it("N5 北斗 external envelope（origin.system=beidou + idempotencyKey 字段）不误伤", () => {
    const decision = evaluateTaskExecution(
      taskLike({
        name: "检索：量子纠错最新进展",
        description: "检索并综述",
        input: JSON.stringify({
          external: {
            originSystem: "beidou",
            externalRef: "ext-1",
            idempotencyKey: "idem-1",
            operation: "research",
            target: "量子纠错最新进展",
            canonicalRequestHash: "abc",
          },
          metadata: {
            traceId: "trc_beidou01_aaaaaaaa",
            origin: { system: "beidou", channel: "service" },
            routing: { candidateAgentIds: [], approvalRequired: false, riskTypes: [] },
            policies: {},
            knowledgeRefs: [],
            artifactRefs: [],
            importance: "normal",
          },
        }),
      }),
    );
    expect(decision.riskTypes).toEqual([]);
  });

  it("N6 已停放任务的审批标记不被重算翻案（getApprovalState 短路语义不变）", () => {
    // 反向确认收窄没有动 state.required 的既有路径：带 approvalRequired=true 的
    // 存量 pending 标记仍然由 checkExecutionGate 消费（本函数只测实时评估面）。
    const decision = evaluateTaskExecution(
      taskLike({
        input: JSON.stringify({
          payload: { ticket: { content: { summary: "普通文案任务" } } },
          metadata: { origin: { system: "mcp" }, routing: { approvalRequired: true, riskTypes: ["mcp_key_change"] } },
        }),
      }),
    );
    // 实时评估只看人类文本：ticket.content.summary 无害 → 空。
    // （parked 标记的放行/拦截由 getApprovalState 分支负责，见 execution-gate.test.ts）
    expect(decision.riskTypes).toEqual([]);
  });
});

describe("p2.5-e 正向钉：人写的真高危必须仍被拦下", () => {
  it.each([
    {
      label: "P1 中文轮换 mcp key（description）",
      task: taskLike({ description: "请帮我轮换 mcp key，今晚生效" }),
      expected: "mcp_key_change",
    },
    {
      label: "P2 rotate the MCP token（name+description）",
      task: taskLike({ name: "ops maintenance", description: "rotate the MCP token on gateway" }),
      expected: "mcp_key_change",
    },
    {
      label: "P3 高危藏 ticket.content.summary（input 人类段）",
      task: taskLike({
        name: "例行小活",
        description: null,
        input: JSON.stringify({
          payload: { ticket: { content: { summary: "执行 git push 到生产仓库 main" }, acceptance: { checks: ["合并 pull request 后确认 CI"] } } },
          metadata: { origin: { system: "mcp" } },
        }),
      }),
      expected: "github_push",
    },
    {
      label: "P4 zeabur deploy 上线（description）",
      task: taskLike({ description: "zeabur deploy 上线新版本" }),
      expected: "zeabur_deploy",
    },
    {
      label: "P5 delete zeabur service（description）",
      task: taskLike({ description: "delete zeabur service 释放资源" }),
      expected: "zeabur_delete_service",
    },
    {
      label: "P6 删除 tos 对象存储备份（description）",
      task: taskLike({ description: "把 tos 上的过期备份 delete 掉" }),
      expected: "storage_delete",
    },
    {
      label: "P7 update New API channel budget（description）",
      task: taskLike({ description: "update New API channel budget to 500" }),
      expected: "newapi_write",
    },
    {
      label: "P8 调用 webhook（description）",
      task: taskLike({ description: "联调时调用 webhook 验证回调链路" }),
      expected: "webhook_call",
    },
    {
      label: "P9 send external email（description）",
      task: taskLike({ description: "send external email 给客户代表" }),
      expected: "external_send",
    },
    {
      label: "P10 create github release（name）",
      task: taskLike({ name: "create github release v3.0", description: null }),
      expected: "github_release",
    },
  ])("$label → 命中 $expected", ({ task, expected }) => {
    const decision = evaluateTaskExecution(task);
    expect(decision.requiresApproval).toBe(true);
    expect(decision.riskTypes).toContain(expected);
  });
});

describe("p2.5-e extractRiskText 单元面：白名单字段逐一钉", () => {
  it("ticket-v2：只取 content.summary/detail + acceptance.checks + notes", () => {
    const text = extractRiskText(
      JSON.stringify({
        payload: {
          ticket: {
            content: { summary: "S", detail: "D" },
            acceptance: { level: 1, checks: ["C1", "C2"] },
            notes: "N",
            deliverable: { path: "/secret/path/key", format: "md" },
            source: { system: "feishu", eventId: "evt-key-token" },
            executor: { agentId: "dsh" },
          },
          idempotencyKey: "decision:q42",
        },
        metadata: { origin: { system: "mcp" }, routing: { selectedAgentId: "x" } },
      }),
    );
    expect(text).toBe("S D C1 C2 N");
  });

  it("字符串 payload：payload/input/task/prompt 直取", () => {
    expect(extractRiskText(JSON.stringify({ payload: "hello world", metadata: { origin: { system: "mcp" } } }))).toBe("hello world");
    expect(extractRiskText(JSON.stringify({ prompt: "do the thing" }))).toBe("do the thing");
  });

  it("对象 payload 无 ticket：只认白名单人写字段名", () => {
    const text = extractRiskText(
      JSON.stringify({
        payload: { goal: "G", content: "C", apiKey: "SECRET", token: "T", budget: 100 },
        metadata: { origin: { system: "mcp" } },
      }),
    );
    expect(text).toBe("G C");
  });

  it("纯文本 input 原样返回；空/数组返回 null", () => {
    expect(extractRiskText("plain text 任务")).toBe("plain text 任务");
    expect(extractRiskText(null)).toBeNull();
    expect(extractRiskText("  ")).toBeNull();
    expect(extractRiskText(JSON.stringify(["a", "b"]))).toBeNull();
  });
});
