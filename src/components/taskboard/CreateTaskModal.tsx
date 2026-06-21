import { useState } from "react";
import { trpc } from "@/providers/trpc";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Plus, Target, AlertTriangle } from "lucide-react";
import type { Agent, Task } from "./types";
import { PRIORITY_LABELS } from "./types";

interface CreateTaskModalProps {
  open: boolean;
  onClose: () => void;
  agents: Agent[];
  allTasks: Task[];
}

export function CreateTaskModal({
  open,
  onClose,
  agents,
  allTasks,
}: CreateTaskModalProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState(0);
  const [labels, setLabels] = useState("");
  const [agentId, setAgentId] = useState<string>("");
  const [parentTaskId, setParentTaskId] = useState<string>("");

  const utils = trpc.useUtils();

  const createMutation = trpc.taskboard.create.useMutation({
    onSuccess: () => {
      reset();
      onClose();
      utils.taskboard.list.invalidate();
    },
  });

  const reset = () => {
    setName("");
    setDescription("");
    setPriority(0);
    setLabels("");
    setAgentId("");
    setParentTaskId("");
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    const boardLabels = labels
      .split(",")
      .map((l) => l.trim())
      .filter(Boolean);

    createMutation.mutate({
      name: name.trim(),
      description: description.trim() || undefined,
      priority,
      agentId: agentId ? Number(agentId) : undefined,
      parentTaskId: parentTaskId ? Number(parentTaskId) : undefined,
      boardLabels: boardLabels.length > 0 ? boardLabels : undefined,
    });
  };

  const parentTasks = allTasks.filter((t) => !t.parentTaskId);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent
        className="max-w-xl max-h-[90vh] overflow-hidden p-0 gap-0"
        style={{
          background: "var(--bg-secondary)",
          border: "1px solid var(--border-default)",
          boxShadow: "0 0 80px rgba(0,0,0,0.5), 0 0 20px rgba(74,158,255,0.08)",
        }}
      >
        <DialogHeader className="px-5 py-3" style={{ borderBottom: "1px solid var(--border-default)" }}>
          <div className="flex items-center gap-2">
            <Target size={18} style={{ color: "var(--accent-cyan)" }} />
            <DialogTitle className="text-sm font-bold" style={{ color: "var(--text-primary)" }}>
              创建新任务
            </DialogTitle>
          </div>
        </DialogHeader>

        <form
          onSubmit={handleSubmit}
          className="px-5 py-4 flex flex-col gap-4 overflow-y-auto custom-scrollbar"
          style={{ maxHeight: "calc(90vh - 60px)" }}
        >
          {/* Name */}
          <div>
            <label className="text-[10px] font-mono mb-1.5 block" style={{ color: "var(--text-muted)" }}>
              任务名称 · NAME *
            </label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="输入任务名称..."
              required
              autoFocus
            />
          </div>

          {/* Description */}
          <div>
            <label className="text-[10px] font-mono mb-1.5 block" style={{ color: "var(--text-muted)" }}>
              描述 · DESCRIPTION
            </label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="描述任务内容..."
              rows={3}
            />
          </div>

          {/* Priority + Labels */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] font-mono mb-1.5 block" style={{ color: "var(--text-muted)" }}>
                优先级 · PRIORITY
              </label>
              <Select value={String(priority)} onValueChange={(v) => setPriority(Number(v))}>
                <SelectTrigger>
                  <SelectValue placeholder="选择优先级" />
                </SelectTrigger>
                <SelectContent>
                  {[0, 1, 2, 3, 4, 5].map((p) => (
                    <SelectItem key={p} value={String(p)}>
                      P{p} — {PRIORITY_LABELS[p] || "普通"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-[10px] font-mono mb-1.5 block" style={{ color: "var(--text-muted)" }}>
                标签 · LABELS
              </label>
              <Input
                value={labels}
                onChange={(e) => setLabels(e.target.value)}
                placeholder="用逗号分隔..."
              />
            </div>
          </div>

          {/* Assignee + Parent */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] font-mono mb-1.5 block" style={{ color: "var(--text-muted)" }}>
                指派 Agent · ASSIGN
              </label>
              <Select value={agentId} onValueChange={setAgentId}>
                <SelectTrigger>
                  <SelectValue placeholder="选择 Agent" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">不指定</SelectItem>
                  {agents.map((a) => (
                    <SelectItem key={a.id} value={String(a.id)}>
                      #{a.id} {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-[10px] font-mono mb-1.5 block" style={{ color: "var(--text-muted)" }}>
                父任务 · PARENT
              </label>
              <Select value={parentTaskId} onValueChange={setParentTaskId}>
                <SelectTrigger>
                  <SelectValue placeholder="选择父任务" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">无</SelectItem>
                  {parentTasks.map((t) => (
                    <SelectItem key={t.id} value={String(t.id)}>
                      {t.taskId} · {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Error */}
          {createMutation.isError && (
            <div
              className="text-xs px-2 py-1.5 rounded font-mono flex items-center gap-1"
              style={{ background: "var(--accent-glow-red)", color: "var(--accent-red)" }}
            >
              <AlertTriangle size={12} />
              {createMutation.error?.message}
            </div>
          )}

          <Separator style={{ background: "var(--border-default)" }} />

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
      </DialogContent>
    </Dialog>
  );
}
