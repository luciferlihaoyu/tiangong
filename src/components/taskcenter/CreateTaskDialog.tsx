/**
 * 创建任务弹窗 — 自 src/pages/TaskCenter.tsx 逐段搬迁（原 L1157-1423），行为保持。
 * （原文件中该组件无 docstring，L910 悬空挂着「创建任务弹窗」注释，搬迁时归位于此。）
 */
import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { AGENT_STATUS_LABELS, PRIORITY_LABELS } from "./constants";
import { Plus, Target, X } from "lucide-react";
import type { Agent } from "./types";

export function CreateTaskDialog({
  open,
  onClose,
  agents,
}: {
  open: boolean;
  agents: Agent[];
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [agentId, setAgentId] = useState<number | null>(null);
  const [priority, setPriority] = useState(0);
  const [input, setInput] = useState("");
  const [queueNow, setQueueNow] = useState(true);

  const utils = trpc.useUtils();

  // 获取自动生成的 taskId
  const taskIdQuery = trpc.taskboard.nextTaskId.useQuery(undefined, {
    enabled: open,
    refetchOnMount: true,
    staleTime: 0,
  });

  const createMutation = trpc.orch.createTask.useMutation({
    onSuccess: (data) => {
      if (data.success) {
        onClose();
        setName("");
        setDescription("");
        setAgentId(null);
        setPriority(0);
        setInput("");
        setQueueNow(true);
        utils.taskboard.list.invalidate();
        utils.orch.getOverview.invalidate();
      }
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    const tid = taskIdQuery.data?.taskId ?? `TG-${Date.now().toString(36).slice(-6).toUpperCase()}`;
    createMutation.mutate({
      taskId: tid,
      name: name.trim(),
      description: description.trim() || undefined,
      agentId: agentId ?? undefined,
      priority,
      input: input.trim() || undefined,
      status: queueNow ? "queued" : "pending",
    });
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-12 px-4"
      style={{ background: "rgba(0,0,0,0.65)", backdropFilter: "blur(6px)" }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl rounded-lg"
        style={{
          background: "var(--bg-secondary)",
          border: "1px solid var(--border-default)",
          boxShadow: "0 0 80px rgba(0,0,0,0.5), 0 0 20px rgba(74,158,255,0.08)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex items-center justify-between px-4 py-3"
          style={{ borderBottom: "1px solid var(--border-default)" }}
        >
          <div className="flex items-center gap-2">
            <Target size={18} style={{ color: "var(--accent-cyan)" }} />
            <span className="text-sm font-bold" style={{ color: "var(--text-primary)" }}>
              创建新任务
            </span>
            {taskIdQuery.data && (
              <span className="text-[10px] font-mono" style={{ color: "var(--accent-gold)" }}>
                {taskIdQuery.data.taskId}
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-[rgba(180,200,255,0.1)]"
            style={{ color: "var(--text-muted)" }}
          >
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-4 flex flex-col gap-4 max-h-[75vh] overflow-y-auto custom-scrollbar">
          {/* Name */}
          <div>
            <label className="text-[10px] font-mono mb-1.5 block" style={{ color: "var(--text-muted)" }}>
              任务名称 · NAME *
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="输入任务名称..."
              required
              autoFocus
              className="w-full px-3 py-2 rounded text-sm outline-none transition-all"
              style={{
                background: "rgba(0,0,0,0.2)",
                border: "1px solid var(--border-default)",
                color: "var(--text-primary)",
              }}
              onFocus={(e) => (e.currentTarget.style.borderColor = "var(--accent-cyan)")}
              onBlur={(e) => (e.currentTarget.style.borderColor = "var(--border-default)")}
            />
          </div>

          {/* Description */}
          <div>
            <label className="text-[10px] font-mono mb-1.5 block" style={{ color: "var(--text-muted)" }}>
              描述 · DESCRIPTION
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="描述任务内容..."
              rows={2}
              className="w-full px-3 py-2 rounded text-sm outline-none transition-all resize-none"
              style={{
                background: "rgba(0,0,0,0.2)",
                border: "1px solid var(--border-default)",
                color: "var(--text-primary)",
              }}
              onFocus={(e) => (e.currentTarget.style.borderColor = "var(--accent-cyan)")}
              onBlur={(e) => (e.currentTarget.style.borderColor = "var(--border-default)")}
            />
          </div>

          {/* Agent + Priority row */}
          <div className="grid grid-cols-2 gap-3">
            {/* Agent */}
            <div>
              <label className="text-[10px] font-mono mb-1.5 block" style={{ color: "var(--text-muted)" }}>
                指派 Agent · ASSIGN
              </label>
              <select
                value={agentId ?? ""}
                onChange={(e) => setAgentId(e.target.value ? Number(e.target.value) : null)}
                className="w-full px-3 py-2 rounded text-xs outline-none"
                style={{
                  background: "rgba(0,0,0,0.2)",
                  border: "1px solid var(--border-default)",
                  color: "var(--text-primary)",
                }}
              >
                <option value="">— 不指定（通用任务）—</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({AGENT_STATUS_LABELS[a.status]})
                  </option>
                ))}
              </select>
            </div>

            {/* Priority */}
            <div>
              <label className="text-[10px] font-mono mb-1.5 block" style={{ color: "var(--text-muted)" }}>
                优先级 · PRIORITY
              </label>
              <select
                value={priority}
                onChange={(e) => setPriority(Number(e.target.value))}
                className="w-full px-3 py-2 rounded text-xs outline-none"
                style={{
                  background: "rgba(0,0,0,0.2)",
                  border: "1px solid var(--border-default)",
                  color: "var(--text-primary)",
                }}
              >
                {[0, 1, 2, 3, 4, 5].map((p) => (
                  <option key={p} value={p}>
                    P{p} — {PRIORITY_LABELS[p] || "普通"}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Input */}
          <div>
            <label className="text-[10px] font-mono mb-1.5 block" style={{ color: "var(--text-muted)" }}>
              输入内容 · INPUT
            </label>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="任务输入内容，如需要处理的文本、指令等..."
              rows={4}
              className="w-full px-3 py-2 rounded text-sm outline-none transition-all resize-none"
              style={{
                background: "rgba(0,0,0,0.2)",
                border: "1px solid var(--border-default)",
                color: "var(--text-primary)",
              }}
              onFocus={(e) => (e.currentTarget.style.borderColor = "var(--accent-cyan)")}
              onBlur={(e) => (e.currentTarget.style.borderColor = "var(--border-default)")}
            />
          </div>

          {/* Queue Now */}
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="queueNow"
              checked={queueNow}
              onChange={(e) => setQueueNow(e.target.checked)}
              className="accent-[var(--accent-cyan)]"
            />
            <label htmlFor="queueNow" className="text-xs cursor-pointer" style={{ color: "var(--text-secondary)" }}>
              立即加入队列（否则为待处理状态）
            </label>
          </div>

          {/* Error */}
          {createMutation.isError && (
            <div
              className="text-xs px-2 py-1.5 rounded font-mono"
              style={{ background: "var(--accent-glow-red)", color: "var(--accent-red)" }}
            >
              {createMutation.error?.message}
            </div>
          )}

          {/* Submit */}
          <div className="flex gap-2 justify-end">
            <button
              type="button"
              onClick={onClose}
              className="text-xs px-4 py-2 rounded font-mono transition-colors hover:bg-[rgba(180,200,255,0.05)]"
              style={{ color: "var(--text-muted)", border: "1px solid var(--border-default)" }}
            >
              取消
            </button>
            <button
              type="submit"
              disabled={createMutation.isPending || !name.trim()}
              className="text-xs px-5 py-2 rounded font-bold tracking-wide transition-all hover:brightness-110 disabled:opacity-50 flex items-center gap-1"
              style={{
                background: "var(--accent-cyan)",
                color: "#fff",
                boxShadow: "0 0 12px rgba(74,158,255,0.2)",
              }}
            >
              <Plus size={14} />
              {createMutation.isPending ? "创建中..." : "创建任务"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
