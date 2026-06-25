#!/usr/bin/env node
/**
 * 天宫任务分配策略模块
 * 后土（CEO）和薇子（秘书）共用
 */

const TIANGONG_BASE = "https://tiangg.zeabur.app";

// ─── Agent 对照表 ───
const AGENTS = {
  1: { name: "女娲", mailboxId: "meizhizi", role: "CTO" },
  2: { name: "编程大师", mailboxId: "codemaster", role: "高级工程师" },
  4: { name: "上官婉儿", mailboxId: "shangguan", role: "运营主管" },
  6: { name: "琼霄", mailboxId: "qiongxiao", role: "生活秘书" },
  7: { name: "云霄", mailboxId: "yunxiao", role: "创意设计师" },
  8: { name: "薇子", mailboxId: "weizi", role: "秘书主管" },
  9: { name: "美成子", mailboxId: "meichengzi", role: "财务法务" },
  10: { name: "精卫", mailboxId: "jingwei", role: "创意主管" },
  12: { name: "碧霄", mailboxId: "bixiao", role: "知识库专员" },
  13: { name: "羲和", mailboxId: "xihe", role: "工程师" },
  14: { name: "后土", mailboxId: "meixizi", role: "CEO" },
  15: { name: "上衫绘梨衣", mailboxId: "sumu", role: "文学创作" },
};

// ─── 匹配规则 ───
// 优先级：越靠前优先级越高
const MATCH_RULES = [
  // 代码/技术/编程 → 女娲（id=1）
  {
    keywords: ["代码", "技术", "编程", "开发", "bug", "debug", "git", "api", "数据库", "前端", "后端", "部署", "docker", "k8s", "kubernetes", "cloud", "server", "function", "algorithm", "数据结构", "react", "vue", "typescript", "javascript", "python", "java", "rust", "golang", "c++", "sql", "redis", "nginx", "linux", "shell", "bash", "ci/cd", "devops", "microservice", "component", "模块", "接口", "测试", "重构", "优化", "性能", "code", "programming", "tech", "software", "engineer", "coding", "implement", "fix"],
    agentId: 1,
    name: "女娲",
  },
  // 创意/设计/视觉 → 精卫（id=10）
  {
    keywords: ["创意", "设计", "视觉", "ui", "ux", "figma", "sketch", "photoshop", "logo", "banner", "海报", "插画", "配色", "排版", "字体", "brand", "动画", "视频", "动效", "creative", "design", "visual", "art", "graphic", "illustration", "icon", "animation", "motion", "video"],
    agentId: 10,
    name: "精卫",
  },
  // 文学/内容/写作 → 上衫绘梨衣（id=15）
  {
    keywords: ["文学", "内容", "写作", "小说", "故事", "文章", "诗歌", "散文", "剧本", "编辑", "出版", "literature", "content", "writing", "story", "novel", "poem", "essay", "script", "editorial", "blog", "author", "write", "book", "reading", "literary", "创作", " novelist", "writer"],
    agentId: 15,
    name: "上衫绘梨衣",
  },
  // 运营/文案 → 上官婉儿（id=4）
  {
    keywords: ["运营", "文案", "推广", "营销", "社群", "活动", "策划", "seo", "sem", "social", "media", "growth", "user", "retention", "conversion", "analytics", "content", "operation", "copywriting", "marketing", "promotion", "community", "event", "planning", "投放", "增长", "转化", "产品", "介绍", "宣传"],
    agentId: 4,
    name: "上官婉儿",
  },
  // 财务/法务 → 美成子（id=9）
  {
    keywords: ["财务", "法务", "会计", "税务", "合同", "法律", "合规", "审计", "预算", "invoice", "payment", "legal", "law", "contract", "compliance", "audit", "finance", "accounting", "tax", "budget", "cost", "revenue", "profit", "报销", "发票", "账单"],
    agentId: 9,
    name: "美成子",
  },
  // 秘书/生活/日程 → 薇子（id=8）
  {
    keywords: ["秘书", "生活", "日程", "日历", "安排", "提醒", "待办", "todo", "schedule", "plan", "meeting", "appointment", "reminder", "secretary", "life", "daily", "routine", "calendar", "organize", "arrange", "备忘", "会议", "约见", "行程"],
    agentId: 8,
    name: "薇子",
  },
  // 架构/战略 → 后土自己（id=14）
  {
    keywords: ["架构", "战略", "规划", "路线图", "roadmap", "strategy", "architecture", "planning", "vision", "goal", "objective", "milestone", "org", "structure", "system", "blueprint", "顶层设计", "统筹", "全局", "决策", "管理"],
    agentId: 14,
    name: "后土",
  },
];

// ─── 默认匹配（兜底）───
const DEFAULT_AGENT = { agentId: 1, mailboxId: "meizhizi", name: "女娲" };

/**
 * 根据任务内容匹配最合适的助手
 * @param {object} task - 任务对象 { name, description, input }
 * @returns {{agentId: number, mailboxId: string, name: string}}
 */
export function matchAgent(task) {
  const rawText = ((task.name || "") + " " + (task.description || "") + " " + (task.input || ""));
  const text = rawText.toLowerCase();
  const tokens = rawText.toLowerCase().split(/[^a-z0-9\u4e00-\u9fa5]+/).filter(Boolean);
  const tokenSet = new Set(tokens);

  // ─── Phase 1: 高优先级精确匹配 ───
  // 架构/战略类关键词优先级最高（防止 "设计" 误匹配创意）
  const architectureKeywords = ["架构", "战略", "顶层设计", "roadmap", "strategy", "architecture", "planning", "vision"];
  for (const kw of architectureKeywords) {
    if (text.includes(kw.toLowerCase())) {
      return { agentId: 14, mailboxId: "meixizi", name: "后土" };
    }
  }

  // 代码/技术类关键词（高优先级）
  const codeKeywords = ["代码", "编程", "开发", "bug", "debug", "git", "api", "数据库", "前端", "后端", "docker", "k8s", "react", "vue", "typescript", "javascript", "python", "java", "rust", "golang", "c++", "sql", "redis", "nginx", "linux", "shell", "bash", "ci/cd", "devops", "microservice"];
  for (const kw of codeKeywords) {
    if (text.includes(kw.toLowerCase())) {
      return { agentId: 1, mailboxId: "meizhizi", name: "女娲" };
    }
  }

  // ─── Phase 2: 通用规则匹配 ───
  for (const rule of MATCH_RULES) {
    for (const kw of rule.keywords) {
      const kwLower = kw.toLowerCase();
      // 中文关键词（长度>1且含中文）：直接子串匹配
      if (kw.length > 1 && /[\u4e00-\u9fa5]/.test(kw)) {
        if (text.includes(kwLower)) {
          return { agentId: rule.agentId, mailboxId: AGENTS[rule.agentId]?.mailboxId || "", name: rule.name };
        }
      } else {
        // 英文/短关键词：要求 token 精确匹配或边界匹配
        if (tokenSet.has(kwLower) || text.includes(` ${kwLower} `) || text.startsWith(`${kwLower} `) || text.endsWith(` ${kwLower}`)) {
          return { agentId: rule.agentId, mailboxId: AGENTS[rule.agentId]?.mailboxId || "", name: rule.name };
        }
      }
    }
  }

  // ─── Phase 3: 兜底 ───
  const techKeywords = ["code", "program", "develop", "build", "fix", "implement", "debug", "test", "deploy", "server", "api", "app", "web", "site", "software"];
  for (const kw of techKeywords) {
    if (tokenSet.has(kw) || text.includes(` ${kw} `) || text.startsWith(`${kw} `) || text.endsWith(` ${kw}`)) {
      return { agentId: 1, mailboxId: "meizhizi", name: "女娲" };
    }
  }

  return { ...DEFAULT_AGENT };
}

/**
 * 调用天宫 API
 */
async function trpcCall(procedure, input) {
  const url = `${TIANGONG_BASE}/api/trpc/${procedure}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  const json = await res.json();
  // tRPC v11: { result: { data: ... } }
  if (json.result && json.result.data !== undefined) {
    return json.result.data;
  }
  return json;
}

async function trpcQuery(procedure, input) {
  const qs = new URLSearchParams({ input: JSON.stringify(input) });
  const url = `${TIANGONG_BASE}/api/trpc/${procedure}?${qs.toString()}`;
  const res = await fetch(url, { method: "GET" });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  const json = await res.json();
  if (json.result && json.result.data !== undefined) {
    return json.result.data;
  }
  return json;
}

/**
 * 获取所有 queued 状态的任务
 * @returns {Promise<Array>}
 */
export async function fetchQueuedTasks() {
  try {
    const data = await trpcQuery("task.list", { status: "queued", limit: 50 });
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.error(`[dispatch-strategy] fetchQueuedTasks failed: ${err.message}`);
    return [];
  }
}

/**
 * 使用 a2a.dispatch 更新任务分配状态
 * @param {object} task - 任务对象
 * @param {number} agentId - 目标 Agent ID
 * @returns {Promise<object>}
 */
export async function dispatchTask(task, agentId) {
  return trpcCall("a2a.dispatch", {
    taskId: task.id,
    targetAgentId: agentId,
    dispatcherAgentId: 14, // 后土
    payload: `任务「${task.name}」由后土分配给 ${AGENTS[agentId]?.name || '未知助手'}`,
  });
}

/**
 * 通知薇子（秘书部主管）分配结果
 * @param {object} task - 任务对象
 * @param {number} agentId - 目标 Agent ID
 * @param {string} mailboxId - 目标 mailboxId
 * @returns {Promise<object>}
 */
export async function notifySecretary(task, agentId, mailboxId) {
  const agent = AGENTS[agentId] || { name: "未知助手" };
  return trpcCall("mailbox.send", {
    fromMailboxId: "meixizi",
    toMailboxId: "weizi",
    type: "direct",
    subject: `📋 新任务分配: ${task.name}`,
    body: `任务「${task.name}」已分配给 ${agent.name}（ID=${agentId}，mailbox=${mailboxId}）\n\n任务描述：${task.description || "（无）"}\n任务ID：${task.id}`,
    payload: {
      taskId: task.id,
      taskName: task.name,
      targetAgentId: agentId,
      targetMailboxId: mailboxId,
      source: "houtu-dispatch",
    },
  });
}

/**
 * 获取指定 mailbox 的收件箱
 * @param {string} mailboxId
 * @param {number} limit
 * @returns {Promise<Array>}
 */
export async function fetchInbox(mailboxId, limit = 20) {
  try {
    const data = await trpcQuery("mailbox.inbox", { mailboxId, limit });
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.error(`[dispatch-strategy] fetchInbox failed: ${err.message}`);
    return [];
  }
}

/**
 * 薇子转发分配通知给目标助手
 * @param {object} msg - mailbox 消息对象
 * @returns {Promise<object>}
 */
export async function forwardDispatch(msg) {
  const payload = msg.payload || {};
  const targetMailboxId = payload.targetMailboxId;
  const targetAgentId = payload.targetAgentId;
  const taskName = payload.taskName || "未知任务";
  const taskId = payload.taskId;

  if (!targetMailboxId) {
    throw new Error("Missing targetMailboxId in message payload");
  }

  return trpcCall("mailbox.send", {
    fromMailboxId: "weizi",
    toMailboxId: targetMailboxId,
    type: "direct",
    subject: `🎯 新任务通知: ${taskName}`,
    body: `你有一个新任务待执行！\n\n任务名称：${taskName}\n任务ID：${taskId}\n来源：后土 → 薇子 → 你\n\n请尽快到任务中心认领并执行。`,
    payload: {
      taskId: taskId,
      taskName: taskName,
      forwardedBy: "weizi",
      originalMessageId: msg.id,
      source: "weizi-forward",
    },
  });
}

/**
 * 高层封装：后土扫描并分配所有 queued 任务
 * @returns {Promise<{scanned: number, dispatched: number, notified: number, errors: number}>}
 */
export async function houtuDispatchScan() {
  const tasks = await fetchQueuedTasks();
  let dispatched = 0;
  let notified = 0;
  let errors = 0;

  for (const task of tasks) {
    try {
      const matched = matchAgent(task);
      console.log(`[Houtu] 任务「${task.name}」→ 分配给 ${matched.name} (agentId=${matched.agentId})`);

      // 尝试 dispatch，如果任务已被认领则跳过
      const dispatchResult = await dispatchTask(task, matched.agentId);
      if (dispatchResult.success === false) {
        console.log(`[Houtu] 任务「${task.name}」dispatch 失败: ${dispatchResult.error || 'unknown'} — 跳过`);
        continue;
      }
      dispatched++;

      await notifySecretary(task, matched.agentId, matched.mailboxId);
      notified++;
    } catch (err) {
      console.error(`[Houtu] 分配任务「${task.name}」失败: ${err.message}`);
      errors++;
    }
  }

  return { scanned: tasks.length, dispatched, notified, errors };
}

/**
 * 高层封装：薇子扫描并转发后土的分配通知
 * @returns {Promise<{scanned: number, forwarded: number, errors: number}>}
 */
export async function weiziForwardScan() {
  const messages = await fetchInbox("weizi", 20);
  let forwarded = 0;
  let errors = 0;

  for (const msg of messages) {
    // 只处理后土发来的 dispatch 消息
    if (msg.fromMailboxId !== "meixizi") continue;
    if (!msg.payload?.targetMailboxId) continue;

    try {
      console.log(`[Weizi] 转发任务「${msg.payload.taskName || msg.subject}」→ ${msg.payload.targetMailboxId}`);
      await forwardDispatch(msg);
      forwarded++;
    } catch (err) {
      console.error(`[Weizi] 转发消息失败: ${err.message}`);
      errors++;
    }
  }

  return { scanned: messages.length, forwarded, errors };
}

// 测试入口（仅直接运行时执行）
if (import.meta.url === `file://${process.argv[1]}`) {
  const mode = process.argv[2] || "houtu";
  if (mode === "houtu") {
    const result = await houtuDispatchScan();
    console.log("[Houtu] 扫描结果:", JSON.stringify(result, null, 2));
  } else if (mode === "weizi") {
    const result = await weiziForwardScan();
    console.log("[Weizi] 扫描结果:", JSON.stringify(result, null, 2));
  } else {
    console.log("用法: node dispatch-strategy.mjs [houtu|weizi]");
  }
}
