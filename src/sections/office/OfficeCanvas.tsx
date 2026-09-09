import { useEffect, useRef, useCallback } from "react";
import { useAgentPositions, type AgentPosition } from "./useAgentPositions";

interface OfficeCanvasProps {
  className?: string;
}

/** 像素小人尺寸 */
const AGENT_W = 18;
const AGENT_H = 24;

/** 工位尺寸 */
const DESK_W = 56;
const DESK_H = 36;

/** 工位配色（浅色办公室 + 像素风柔和色） */
const COLORS = {
  bg: "#faf8f2", // 米白底
  floor: "#ebe5d8", // 浅木地板
  wall: "#e8e0d0", // 米灰墙（暂未用，预留）
  desk: "#c8b896", // 木桌
  deskEdge: "#a89878", // 桌边深色
  monitor: "#3a3a4a", // 显示器外框（深色）
  monitorScreen: "#7a9a7a", // 屏幕待机（浅绿）
  monitorScreenActive: "#2a8a2a", // 屏幕活跃（深绿）
  chair: "#8a7a68", // 椅子
  lounge: "#f0e8dc", // 休闲区地板（更亮）
  loungeEdge: "#c8b896", // 休闲区边线
  aisle: "rgba(120, 100, 70, 0.18)", // 走道分隔线
  textPrimary: "#2a2a3a", // 深色文字
  textMuted: "#707080", // 次要文字
  offline: "#c0c0c8", // 离线工位灰
  accent: "#c23a30",
  gold: "#b8860b",
  ok: "#2a8a2a", // 进度条绿
  warn: "#b8860b", // 警告黄
  err: "#c23a30", // 错误红
};

/** 画像素小人（方块组合，8-bit 风） */
function drawPixelAgent(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  color: string,
  state: AgentPosition["state"],
  frame: number
) {
  ctx.save();
  ctx.translate(x, y);
  // 阴影
  ctx.fillStyle = "rgba(0,0,0,0.18)";
  ctx.fillRect(-AGENT_W / 2, AGENT_H / 2 - 2, AGENT_W, 3);

  // 身体（矩形）
  ctx.fillStyle = color;
  ctx.fillRect(-AGENT_W / 2 + 2, -AGENT_H / 2 + 8, AGENT_W - 4, AGENT_H - 10);

  // 头（方块）
  ctx.fillStyle = "#e8c8a8"; // 肤色（浅背景用稍深）
  ctx.fillRect(-AGENT_W / 2 + 4, -AGENT_H / 2, AGENT_W - 8, 10);

  // 眼睛（两个小方块）
  ctx.fillStyle = "#000";
  ctx.fillRect(-AGENT_W / 2 + 6, -AGENT_H / 2 + 4, 2, 2);
  ctx.fillRect(AGENT_W / 2 - 8, -AGENT_H / 2 + 4, 2, 2);

  // 状态装饰
  if (state === "working") {
    // 敲击键盘：手上下动（帧动画）
    const armOffset = Math.floor(frame / 8) % 2 === 0 ? 0 : 1;
    ctx.fillStyle = color;
    ctx.fillRect(-AGENT_W / 2 - 1, 0 + armOffset, 3, 4);
    ctx.fillRect(AGENT_W / 2 - 2, 0 + (1 - armOffset), 3, 4);
  } else if (state === "failed") {
    // 捂头（手到头）
    ctx.fillStyle = color;
    ctx.fillRect(-AGENT_W / 2 - 1, -AGENT_H / 2 - 2, 3, 4);
    ctx.fillRect(AGENT_W / 2 - 2, -AGENT_H / 2 - 2, 3, 4);
  } else if (state === "reviewing") {
    // 举手（一只手伸起）
    ctx.fillStyle = color;
    ctx.fillRect(AGENT_W / 2 - 2, -AGENT_H / 2 - 4, 3, 6);
  } else if (state === "idle") {
    // 休闲动作：偶尔眨眼（每 4 秒一次）
    const blinkFrame = Math.floor(frame / 240) % 2; // 4s 一次
    if (blinkFrame === 0 && Math.floor(frame / 4) % 4 === 0) {
      // 闭眼
      ctx.fillStyle = "#e8c8a8";
      ctx.fillRect(-AGENT_W / 2 + 6, -AGENT_H / 2 + 4, 2, 2);
      ctx.fillRect(AGENT_W / 2 - 8, -AGENT_H / 2 + 4, 2, 2);
    }
  }

  ctx.restore();
}

/** 画工位（桌子+显示器+椅子） */
function drawDesk(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  agentName: string,
  isOccupied: boolean,
  isActive: boolean,
  isOffline: boolean,
  seatColor: string
) {
  ctx.save();
  ctx.translate(x, y);

  // 桌子（矩形）
  ctx.fillStyle = isOffline ? COLORS.offline : COLORS.desk;
  ctx.fillRect(-DESK_W / 2, -DESK_H / 2, DESK_W, DESK_H);
  // 桌边高光
  ctx.fillStyle = COLORS.deskEdge;
  ctx.fillRect(-DESK_W / 2, -DESK_H / 2, DESK_W, 2);

  // 显示器（中央小矩形）
  const mw = 22;
  const mh = 14;
  ctx.fillStyle = COLORS.monitor;
  ctx.fillRect(-mw / 2, -DESK_H / 2 + 4, mw, mh);
  // 屏幕（活跃时亮绿）
  ctx.fillStyle = isActive ? COLORS.monitorScreenActive : isOffline ? "#1a1a2a" : COLORS.monitorScreen;
  ctx.fillRect(-mw / 2 + 2, -DESK_H / 2 + 6, mw - 4, mh - 4);

  // 椅子（下方小矩形）
  const cw = 14;
  const ch = 8;
  ctx.fillStyle = isOffline ? "#2a2a3a" : COLORS.chair;
  ctx.fillRect(-cw / 2, DESK_H / 2 - 4, cw, ch);

  // 工位牌（名字）
  ctx.fillStyle = COLORS.textMuted;
  ctx.font = "8px monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const nameShort = agentName.length > 8 ? agentName.slice(0, 8) + "…" : agentName;
  ctx.fillText(nameShort, 0, -DESK_H / 2 + DESK_H + 2);

  // 工位序号（右上角小点）
  if (!isOffline) {
    ctx.fillStyle = seatColor;
    ctx.fillRect(DESK_W / 2 - 4, -DESK_H / 2 + 2, 3, 3);
  }

  ctx.restore();
}

/** 画头顶气泡（像素风对话框） */
function drawBubble(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  text: string,
  color: string,
  isWarning?: boolean,
  isError?: boolean
) {
  ctx.save();
  ctx.font = "9px monospace";
  const w = ctx.measureText(text).width + 12;
  const h = 16;
  const bx = x - w / 2;
  const by = y - AGENT_H / 2 - h - 6;

  // 气泡体（白底深边）
  ctx.fillStyle = "#e8e8f0";
  ctx.fillRect(bx, by, w, h);
  // 边
  ctx.strokeStyle = isError ? COLORS.err : isWarning ? COLORS.warn : "#2a2a3a";
  ctx.lineWidth = 1;
  ctx.strokeRect(bx, by, w, h);
  // 小三角指向小人
  ctx.fillStyle = "#e8e8f0";
  ctx.beginPath();
  ctx.moveTo(x - 4, by + h);
  ctx.lineTo(x + 4, by + h);
  ctx.lineTo(x, by + h + 5);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = isError ? COLORS.err : isWarning ? COLORS.warn : "#2a2a3a";
  ctx.stroke();

  // 文字
  ctx.fillStyle = isError ? COLORS.err : isWarning ? COLORS.warn : "#1a1a2e";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x, by + h / 2 + 0.5);

  ctx.restore();
}

/** 画休闲区家具 */
function drawLounge(ctx: CanvasRenderingContext2D, width: number, height: number, aisleY: number) {
  ctx.save();

  // 休闲区地板（略亮）
  ctx.fillStyle = COLORS.lounge;
  ctx.fillRect(0, aisleY, width, height - aisleY);
  // 顶部 1px 边线
  ctx.fillStyle = COLORS.loungeEdge;
  ctx.fillRect(0, aisleY, width, 1);

  // 走道虚线
  ctx.strokeStyle = COLORS.aisle;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(0, aisleY);
  ctx.lineTo(width, aisleY);
  ctx.stroke();
  ctx.setLineDash([]);

  // 4 个休闲家具（按位置点绘制）
  const spots = [
    { x: width * 0.15, label: "☕", name: "咖啡机" },
    { x: width * 0.42, label: "🛋️", name: "沙发" },
    { x: width * 0.68, label: "🏓", name: "乒乓" },
    { x: width * 0.9, label: "🏋️", name: "健身" },
  ];
  const midY = (aisleY + height) / 2;

  for (const s of spots) {
    // 家具底座（40×20 矩形，浅色木板）
    ctx.fillStyle = "#c8b896";
    ctx.fillRect(s.x - 20, midY - 10, 40, 20);
    ctx.fillStyle = "#b0a078";
    ctx.fillRect(s.x - 20, midY - 10, 40, 2);
    // emoji 图标
    ctx.font = "14px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(s.label, s.x, midY);
    // 名字
    ctx.fillStyle = COLORS.textMuted;
    ctx.font = "7px monospace";
    ctx.fillText(s.name, s.x, midY + 14);
  }

  ctx.restore();
}

export default function OfficeCanvas({ className }: OfficeCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef(0);
  const sizeRef = useRef({ width: 800, height: 500 });

  // 测量容器尺寸（自适应）
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        sizeRef.current = { width, height };
      }
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, []);

  // 拿 agent 位置（内部包含 5s 轮询）
  const { positions } = useAgentPositions(sizeRef.current.width, sizeRef.current.height);

  // 渲染循环
  const render = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const { width, height } = sizeRef.current;
    // 高清屏适配
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.scale(dpr, dpr);

    // 帧计数（用于简单动画）
    frameRef.current++;

    // 清屏
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, width, height);

    // 顶部标题栏（左上小字）
    ctx.fillStyle = COLORS.textMuted;
    ctx.font = "9px monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText("TIANGONG OFFICE · 实时工作可视化", 8, 6);

    // 工位区地板
    ctx.fillStyle = COLORS.floor;
    ctx.fillRect(0, 20, width, height * 0.68 - 20);

    // 休闲区
    drawLounge(ctx, width, height, height * 0.72);

    // 按 zone 排序：lounge 先画（在底层），desk 后画（在上层）
    const sorted = [...positions].sort((a, b) => {
      if (a.zone === b.zone) return a.y - b.y;
      return a.zone === "lounge" ? -1 : 1;
    });

    // 先画工位（桌子）
    for (const p of positions) {
      const isActive = p.state === "working";
      const isOccupied = p.zone === "desk" && !p.isOffline;
      drawDesk(ctx, p.seatX, p.seatY, p.agentName, isOccupied, isActive, p.isOffline, p.color);
    }

    // 画小人 + 气泡
    for (const p of sorted) {
      // 离线时：工位空 + 牌子
      if (p.isOffline) {
        // 工位牌"暂离"
        ctx.fillStyle = COLORS.textMuted;
        ctx.font = "8px monospace";
        ctx.textAlign = "center";
        ctx.fillText("暂离", p.seatX, p.seatY + DESK_H / 2 + 10);
        continue;
      }

      // 小人位置
      const agentX = p.zone === "desk" ? p.seatX : p.x;
      const agentY = p.zone === "desk" ? p.seatY + 4 : p.y; // 工位上稍微下移到椅子上

      // 画小人
      drawPixelAgent(ctx, agentX, agentY, p.color, p.state, frameRef.current);

      // 气泡
      if (p.bubble) {
        const isError = p.state === "failed";
        const isWarning = p.state === "reviewing";
        drawBubble(ctx, agentX, agentY, p.bubble, p.color, isWarning, isError);
      }

      // 任务进度条（工位上 working 状态显示）
      if (p.zone === "desk" && p.state === "working" && p.taskProgress !== undefined) {
        const barW = DESK_W - 8;
        const barH = 3;
        const barX = p.seatX - barW / 2;
        const barY = p.seatY + DESK_H / 2 + 4;
        ctx.fillStyle = "#d8d0c0";
        ctx.fillRect(barX, barY, barW, barH);
        ctx.fillStyle = COLORS.ok;
        ctx.fillRect(barX, barY, (barW * p.taskProgress) / 100, barH);
      }
    }

    // 底部状态栏（右下小字：在线/工作统计）
    const online = positions.filter((p) => !p.isOffline).length;
    const working = positions.filter((p) => p.state === "working").length;
    ctx.fillStyle = COLORS.textMuted;
    ctx.font = "9px monospace";
    ctx.textAlign = "right";
    ctx.textBaseline = "bottom";
    ctx.fillText(`${positions.length} agents · ${online} online · ${working} working`, width - 8, height - 4);
  }, [positions]);

  // requestAnimationFrame 循环
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      render();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [render]);

  return (
    <div ref={containerRef} className={className} style={{ width: "100%", height: "100%" }}>
      <canvas ref={canvasRef} style={{ display: "block" }} />
    </div>
  );
}
