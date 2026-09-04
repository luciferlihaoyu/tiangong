/**
 * TaskReviewActions — 审批操作统一组件
 *
 * 用于任务详情三处复用：
 *  - TaskDetailModal（任务板里点开）
 *  - TaskDetail 整页（/tasks/:id）
 *  - TaskCenter 详情块（后续接入）
 *
 * 行为：
 *  - 仅当 caller 决定 isReviewing = true 时渲染（避免耦合 boardStatus/lifecycleStatus）
 *  - 权限：isAdmin || (reviewerId === operatorAgentId)
 *  - 三个 mutation：approve / reject / requestChanges
 *  - 内部管 reviewComment，submit 后清空
 */
import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { CheckCircle, RotateCcw, XCircle } from "lucide-react";

interface Props {
  taskId: number;
  /** 任务的预定 reviewer；null 表示尚未指定 reviewer */
  reviewerId: number | null;
  /** 当前操作者 agentId（null 时按钮禁用） */
  operatorAgentId: number | null;
  /** 当前用户是否管理员 */
  isAdmin: boolean;
  /** 成功后回调（页面级 invalidation / toast 等） */
  onSuccess?: () => void;
  /** 渲染变体：'panel' 独立 panel（TaskDetail），'inline' 嵌入 action 区（TaskDetailModal） */
  variant?: "panel" | "inline";
}

export function TaskReviewActions({
  taskId,
  reviewerId,
  operatorAgentId,
  isAdmin,
  onSuccess,
  variant = "inline",
}: Props) {
  const [comment, setComment] = useState("");
  const utils = trpc.useUtils();

  const allowed =
    isAdmin || (reviewerId !== null && operatorAgentId !== null && reviewerId === operatorAgentId);

  const invalidateAndNotify = () => {
    utils.taskboard.list.invalidate();
    utils.taskboard.get.invalidate({ id: taskId });
    setComment("");
    onSuccess?.();
  };

  const approveMutation = trpc.taskboard.approve.useMutation({
    onSuccess: invalidateAndNotify,
    onError: () => {/* 错误由 UI 层捕获（isPending=false 后用户重试） */},
  });
  const rejectMutation = trpc.taskboard.reject.useMutation({
    onSuccess: invalidateAndNotify,
    onError: () => {},
  });
  const requestChangesMutation = trpc.taskboard.requestChanges.useMutation({
    onSuccess: invalidateAndNotify,
    onError: () => {},
  });

  const isPending =
    approveMutation.isPending || rejectMutation.isPending || requestChangesMutation.isPending;

  if (!allowed) return null;

  const containerCls =
    variant === "panel" ? "mb-6 glass-panel p-4 sci-border" : "mb-2";
  const headerCls =
    variant === "panel" ? "text-[10px] font-mono mb-3" : "hidden";
  const sectionLabelCls = variant === "panel" ? "section-label" : "hidden";

  return (
    <div className={containerCls} style={variant === "panel" ? { border: "1px solid rgba(74,158,255,0.2)" } : undefined}>
      {variant === "panel" && (
        <div className="flex items-center gap-2 mb-3">
          <span className={sectionLabelCls} style={{ color: "var(--accent-cyan)" }}>
            审批操作 · REVIEW
          </span>
          <div className="flex-1 h-px" style={{ background: "var(--border-default)" }} />
        </div>
      )}
      {variant === "panel" && (
        <div className={headerCls} style={{ color: "var(--text-muted)" }}>
          该任务已提交审批，请选择审批操作并填写意见。
        </div>
      )}
      <textarea
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder="输入审批意见（可选）..."
        rows={variant === "panel" ? 2 : 2}
        className={
          variant === "panel"
            ? "w-full px-3 py-2 rounded text-xs outline-none font-mono resize-none mb-3"
            : "w-full px-3 py-1.5 rounded text-xs outline-none resize-none"
        }
        style={{
          background: "rgba(0,0,0,0.2)",
          border: "1px solid var(--border-default)",
          color: "var(--text-primary)",
        }}
      />
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() =>
            approveMutation.mutate({ taskId, agentId: operatorAgentId!, comment: comment || undefined })
          }
          disabled={isPending || !operatorAgentId}
          className="px-4 py-2 rounded text-xs font-mono font-bold transition-all hover:brightness-110 disabled:opacity-50 flex items-center gap-1"
          style={{
            background: "rgba(76,175,125,0.1)",
            color: "var(--success)",
            border: "1px solid rgba(76,175,125,0.2)",
          }}
        >
          <CheckCircle size={12} /> 通过
        </button>
        <button
          onClick={() =>
            requestChangesMutation.mutate({ taskId, agentId: operatorAgentId!, reason: comment || undefined })
          }
          disabled={isPending || !operatorAgentId}
          className="px-4 py-2 rounded text-xs font-mono font-bold transition-all hover:brightness-110 disabled:opacity-50 flex items-center gap-1"
          style={{
            background: "rgba(201,168,76,0.1)",
            color: "var(--accent-gold)",
            border: "1px solid rgba(201,168,76,0.2)",
          }}
        >
          <RotateCcw size={12} /> 退回修改
        </button>
        <button
          onClick={() =>
            rejectMutation.mutate({ taskId, agentId: operatorAgentId!, reason: comment || undefined })
          }
          disabled={isPending || !operatorAgentId}
          className="px-4 py-2 rounded text-xs font-mono font-bold transition-all hover:brightness-110 disabled:opacity-50 flex items-center gap-1"
          style={{
            background: "rgba(194,58,48,0.1)",
            color: "var(--danger)",
            border: "1px solid rgba(194,58,48,0.2)",
          }}
        >
          <XCircle size={12} /> 拒绝
        </button>
      </div>
    </div>
  );
}
