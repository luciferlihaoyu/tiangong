import { useState } from "react";
import { useSearchParams } from "react-router";
import { Bot, GitBranch, Kanban, ClipboardList } from "lucide-react";
import TaskCenter from "./TaskCenter";
import TaskBoard from "./TaskBoard";
import DagPanel from "./DagPanel";
import MissionLog from "./MissionLog";

/**
 * 任务工作台（合并入口 P-merge）：
 * 把原 4 个任务页（任务中心 / 任务板 / DAG / 协作日志）收敛为单一路由 /tasks 下的 4 个 Tab。
 * 老路由 /task-center /taskboard /dag /missions 由 App.tsx 用 <Navigate> 重定向到 ?tab=…。
 *
 * Tab 行为：
 * - ?tab=center|board|dag|log 深链可分享（缺省 center）
 * - Tab 切换即更新 URL query（不强制刷新页面，切回保持各自页内状态）
 */
type TaskTab = "center" | "board" | "dag" | "log";

const TAB_DEFS: { key: TaskTab; label: string; icon: React.ReactNode; hint: string }[] = [
  { key: "center", label: "任务中心", icon: <Bot size={15} />, hint: "创建 · 状态 · 协作编排" },
  { key: "board", label: "任务板", icon: <Kanban size={15} />, hint: "看板拖拽 · 待我审核" },
  { key: "dag", label: "DAG · 计划", icon: <GitBranch size={15} />, hint: "依赖 · 组织 · 计划生成" },
  { key: "log", label: "协作日志", icon: <ClipboardList size={15} />, hint: "记事板 · 会话归档" },
];

export default function Tasks() {
  const [searchParams, setSearchParams] = useSearchParams();
  const raw = searchParams.get("tab") as TaskTab | null;
  const initial = raw && TAB_DEFS.some((t) => t.key === raw) ? raw : "center";
  const [tab, setTab] = useState<TaskTab>(initial);

  const switchTab = (key: TaskTab) => {
    setTab(key);
    const next = new URLSearchParams(searchParams);
    if (key === "center") {
      next.delete("tab");
    } else {
      next.set("tab", key);
    }
    setSearchParams(next, { replace: true });
  };

  const active = TAB_DEFS.find((t) => t.key === tab) ?? TAB_DEFS[0];

  return (
    <div className="min-h-screen pt-16 px-4 md:px-6 max-w-7xl mx-auto">
      {/* 顶栏：标题 + Tab 切换 */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 mb-6">
        <div>
          <h1 className="text-xl font-bold" style={{ color: "var(--text-primary)" }}>
            任务工作台
          </h1>
          <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>
            {active.hint}
          </p>
        </div>
        <div className="flex flex-wrap gap-1 rounded-lg p-1" style={{ background: "rgba(255,255,255,0.03)", border: "1px solid var(--border-default)" }}>
          {TAB_DEFS.map((t) => (
            <button
              key={t.key}
              onClick={() => switchTab(t.key)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs transition-colors"
              style={{
                background: tab === t.key ? "rgba(74,158,255,0.1)" : "transparent",
                border: `1px solid ${tab === t.key ? "rgba(74,158,255,0.3)" : "transparent"}`,
                color: tab === t.key ? "var(--accent-cyan)" : "var(--text-muted)",
                cursor: "pointer",
              }}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* 内容区：各原页自带 min-h-screen 外壳，内层容器宽度已受外层 max-w 约束 */}
      <div className="relative">
        {tab === "center" && <TaskCenter />}
        {tab === "board" && <TaskBoard />}
        {tab === "dag" && <DagPanel />}
        {tab === "log" && <MissionLog />}
      </div>
    </div>
  );
}
