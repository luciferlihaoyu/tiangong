import { useMemo } from "react";
import { trpc } from "@/providers/trpc";

/** Agent 虚拟状态：决定它在办公室里的位置与动作 */
export type AgentState = "offline" | "idle" | "commuting" | "working" | "reviewing" | "failed";

export interface AgentPosition {
  agentId: number;
  agentName: string;
  /** 当前虚拟位置（0..1 归一化坐标，相对 canvas） */
  x: number;
  y: number;
  /** 工位锚点（离线时也保留，画"暂离"牌） */
  seatX: number;
  seatY: number;
  /** 目标状态 */
  state: AgentState;
  /** 头顶气泡文字（任务环节 / 休闲动作 / "暂离"） */
  bubble?: string;
  /** 当前任务名（如果有） */
  taskName?: string;
  /** 当前任务进度 0-100 */
  taskProgress?: number;
  /** 像素精灵颜色（按 agentId 哈希） */
  color: string;
  /** 离线时 true */
  isOffline: boolean;
  /** 在工位还是休闲区（决定 z 排序和大小） */
  zone: "desk" | "lounge";
}

export interface LayoutMetrics {
  /** Canvas 实际像素宽 */
  width: number;
  /** Canvas 实际像素高 */
  height: number;
  /** 工位区（顶部 65%） */
  deskZoneHeight: number;
  /** 休闲区（底部 30%） */
  loungeZoneTop: number;
  /** 中间走道分隔线 Y */
  aisleY: number;
}

/** 颜色调色板（8-bit 像素风柔和色） */
const PALETTE = [
  "#4a9eff", "#56bed8", "#c23a30", "#d8a04a", "#7ac26a",
  "#b57ae0", "#e07ab5", "#7a90e0", "#e0a07a", "#6ac2a8",
  "#c8c856", "#8a6ae0", "#5ac2c2", "#e06a8a", "#96b8e0",
];

/** 根据 agentId 哈希稳定选一个颜色 */
function colorFor(id: number): string {
  return PALETTE[id % PALETTE.length];
}

/** 稳定伪随机（按 seed 生成 0..1） */
function seededRandom(seed: number): number {
  const x = Math.sin(seed * 9301 + 49297) * 233280;
  return x - Math.floor(x);
}

/** 计算工位布局：n 个工位，2 列 X N 行（在顶部 65% 区域内） */
function layoutSeats(count: number, m: LayoutMetrics): Array<{ x: number; y: number }> {
  const seats: Array<{ x: number; y: number }> = [];
  if (count === 0) return seats;
  // 工位区横向边距 5%，纵向边距 8%
  const deskLeft = m.width * 0.05;
  const deskRight = m.width * 0.95;
  const deskTop = m.height * 0.08;
  const deskBottom = m.deskZoneHeight * 0.92;
  const cols = Math.max(1, Math.min(7, Math.ceil(count / 2))); // 最多 7 列，2 行
  const rows = Math.ceil(count / cols);
  const cellW = (deskRight - deskLeft) / cols;
  const cellH = (deskBottom - deskTop) / rows;
  for (let i = 0; i < count; i++) {
    const c = i % cols;
    const r = Math.floor(i / cols);
    seats.push({
      x: deskLeft + cellW * (c + 0.5),
      y: deskTop + cellH * (r + 0.5),
    });
  }
  return seats;
}

/** 休闲区点位：咖啡机/沙发/乒乓球/健身角 4 个固定点 */
function loungeSpots(m: LayoutMetrics): Array<{ x: number; y: number; label: string }> {
  const y = (m.loungeZoneTop + m.height) / 2;
  return [
    { x: m.width * 0.15, y, label: "☕ 咖啡机" },
    { x: m.width * 0.42, y, label: "🛋️ 沙发" },
    { x: m.width * 0.68, y, label: "🏓 乒乓" },
    { x: m.width * 0.9, y, label: "🏋️ 健身" },
  ];
}

/** 休闲动作台词（按 agentId 哈希稳定选一句） */
const LOUNGE_LINES = [
  "泡杯咖啡 ☕",
  "小憩一下 😴",
  "看看新闻 📰",
  "拉伸一下 🤸",
  "发呆中…",
  "整理思路 💭",
  "翻翻文档 📚",
  "打个盹 💤",
];

function loungeLine(id: number): string {
  return LOUNGE_LINES[id % LOUNGE_LINES.length];
}

/**
 * 核心 hook：把 trpc 的 agent + task 数据转成每个 agent 的虚拟位置
 * - agent 在线 + 无任务 → 休闲区游走
 * - agent 在线 + 任务进行中 → 工位上工作
 * - agent 在线 + 任务 submitted/reviewing → 工位上等待
 * - agent 离线（>5min 无心跳）→ 工位空 + "暂离"牌
 */
export function useAgentPositions(canvasWidth: number, canvasHeight: number) {
  const agentsQuery = trpc.agent.list.useQuery(undefined, {
    refetchInterval: 5000,
    retry: 1,
  });
  const tasksQuery = trpc.taskboard.list.useQuery(undefined, {
    refetchInterval: 5000,
    retry: 1,
  });

  const positions = useMemo(() => {
    const agents = agentsQuery.data ?? [];
    const tasks = tasksQuery.data ?? [];

    const metrics: LayoutMetrics = {
      width: canvasWidth,
      height: canvasHeight,
      deskZoneHeight: canvasHeight * 0.65,
      loungeZoneTop: canvasHeight * 0.72,
      aisleY: canvasHeight * 0.68,
    };

    const seats = layoutSeats(agents.length, metrics);
    const lounge = loungeSpots(metrics);
    const now = Date.now();

    return agents.map((agent, idx) => {
      const seat = seats[idx] ?? { x: canvasWidth / 2, y: canvasHeight / 2 };
      // 心跳判断：5 分钟内有心跳算在线
      const lastBeat = agent.lastHeartbeat ? new Date(agent.lastHeartbeat).getTime() : 0;
      const isOnline = now - lastBeat < 5 * 60 * 1000;
      // 这个 agent 当前最优先的任务（running/working/dispatched/accepted）
      const myTask = tasks.find(
        (t) => t.agentId === agent.id && ["working", "dispatched", "accepted", "running"].includes(t.lifecycleStatus ?? t.status ?? "")
      );
      // 等审阅的任务
      const myReviewTask = tasks.find(
        (t) => t.agentId === agent.id && ["submitted", "reviewing"].includes(t.lifecycleStatus ?? t.status ?? "")
      );
      // 失败任务（最近 1 小时内）
      const myFailedTask = tasks.find(
        (t) => t.agentId === agent.id && t.status === "failed" &&
          (t.failedAt ? now - new Date(t.failedAt).getTime() < 60 * 60 * 1000 : false)
      );

      let state: AgentState = "offline";
      let bubble: string | undefined;
      let x = seat.x;
      let y = seat.y;
      let zone: "desk" | "lounge" = "desk";

      if (!isOnline) {
        state = "offline";
        bubble = "暂离";
        zone = "desk";
      } else if (myTask) {
        // 工作中
        state = "working";
        zone = "desk";
        const progress = myTask.progress ?? 0;
        const stageMap: Record<string, string> = {
          claimed: "已认领",
          dispatched: "已派发",
          accepted: "已接受",
          working: "干活中",
          running: "执行中",
          submitted: "已提交",
          reviewing: "审阅中",
        };
        const stage = stageMap[myTask.lifecycleStatus ?? myTask.status ?? ""] ?? "进行中";
        bubble = `${stage} ${progress}%`;
      } else if (myReviewTask) {
        state = "reviewing";
        zone = "desk";
        bubble = "待审阅 ✋";
      } else if (myFailedTask) {
        state = "failed";
        zone = "desk";
        bubble = "出错了 💥";
      } else {
        // 在线无任务 → 休闲区游走（按 agentId 哈希稳定选一个休闲点）
        state = "idle";
        zone = "lounge";
        const spot = lounge[agent.id % lounge.length];
        // 在休闲点附近做小半径随机游走（用 agentId + 秒级时间做种子）
        const t = Math.floor(now / 4000); // 每 4 秒换位置
        const jx = (seededRandom(agent.id * 31 + t) - 0.5) * 30;
        const jy = (seededRandom(agent.id * 73 + t) - 0.5) * 12;
        x = spot.x + jx;
        y = spot.y + jy;
        bubble = loungeLine(agent.id);
      }

      return {
        agentId: agent.id,
        agentName: agent.name ?? `Agent ${agent.id}`,
        x,
        y,
        seatX: seat.x,
        seatY: seat.y,
        state,
        bubble,
        taskName: myTask?.name ?? myReviewTask?.name,
        taskProgress: myTask?.progress ?? myReviewTask?.progress,
        color: colorFor(agent.id),
        isOffline: !isOnline,
        zone,
      } satisfies AgentPosition;
    });
  }, [agentsQuery.data, tasksQuery.data, canvasWidth, canvasHeight]);

  return {
    positions,
    isLoading: agentsQuery.isLoading || tasksQuery.isLoading,
    error: agentsQuery.error ?? tasksQuery.error,
  };
}
