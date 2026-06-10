/**
 * 天宫 MCP 接入管理 Tab
 * 中国科幻风 UI — 与 Dashboard 风格统一
 */

import { useState, useEffect, useCallback } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/* ═══════════════════════════════════════════
   MCP Tools & Resources 定义
   ═══════════════════════════════════════════ */

const MCP_TOOLS = [
  { id: "create_task", label: "创建任务", desc: "创建新任务，支持依赖" },
  { id: "update_task_status", label: "更新任务状态", desc: "状态机检查 + 自动触发下游" },
  { id: "send_message", label: "发送消息", desc: "Agent 间互发消息" },
  { id: "update_agent_status", label: "更新 Agent 状态", desc: "更新在线状态和当前任务" },
  { id: "heartbeat", label: "心跳上报", desc: "Agent 心跳保活" },
  { id: "list_agents", label: "查询 Agent 列表", desc: "获取所有 Agent" },
  { id: "list_tasks", label: "查询任务列表", desc: "获取所有任务" },
  { id: "list_messages", label: "查询消息记录", desc: "获取消息历史" },
];

const MCP_RESOURCES = [
  { id: "agents", label: "Agent 列表", desc: "tiangong://agents" },
  { id: "tasks", label: "任务列表", desc: "tiangong://tasks" },
  { id: "organization", label: "组织架构", desc: "tiangong://organization" },
  { id: "agent-detail", label: "Agent 详情", desc: "tiangong://agents/{id}" },
  { id: "task-dag", label: "任务 DAG", desc: "tiangong://tasks/dag" },
  { id: "agent-hierarchy", label: "层级树", desc: "tiangong://agents/hierarchy" },
];

/* ═══════════════════════════════════════════
   Types
   ═══════════════════════════════════════════ */

interface McpKeyItem {
  id: number;
  keyPreview: string;
  agentId: number | null;
  agentName: string | null;
  name: string;
  permissions: string | null;
  rateLimit: number;
  active: "true" | "false";
  lastUsedAt: string | null;
  createdAt: string;
}

interface AuditLogItem {
  id: number;
  keyId: number;
  tool: string;
  params: string | null;
  result: "success" | "error";
  error: string | null;
  durationMs: number | null;
  createdAt: string;
}

interface AuditStats {
  total: number;
  successCount: number;
  errorCount: number;
  errorRate: string;
  recentErrors: { id: number; keyId: number; tool: string; error: string | null; createdAt: string }[];
}

/* ═══════════════════════════════════════════
   Helper: parse/serialize permissions
   ═══════════════════════════════════════════ */

function parsePermissions(perms: string | null): { tools: string[]; resources: string[] } {
  try {
    const p = perms ? JSON.parse(perms) : {};
    return {
      tools: Array.isArray(p.tools) ? p.tools : [],
      resources: Array.isArray(p.resources) ? p.resources : [],
    };
  } catch {
    return { tools: [], resources: [] };
  }
}

function serializePermissions(tools: string[], resources: string[]): string {
  return JSON.stringify({ tools, resources });
}

/* ═══════════════════════════════════════════
   Helper: call tRPC via fetch
   ═══════════════════════════════════════════ */

async function trpcCall(path: string, input?: any): Promise<any> {
  const token = localStorage.getItem("tiangong_token");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const url = `/api/trpc/${path}`;
  const res = await fetch(url, {
    method: input !== undefined ? "POST" : "GET",
    headers,
    body: input !== undefined ? JSON.stringify(input) : undefined,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: `HTTP ${res.status}` }));
    throw new Error(err?.message || err?.[0]?.message || `HTTP ${res.status}`);
  }

  return res.json();
}

/* ═══════════════════════════════════════════
   Permission Checkbox Group (复用组件)
   ═══════════════════════════════════════════ */

function PermissionGroup({
  title,
  items,
  selected,
  onChange,
}: {
  title: string;
  items: { id: string; label: string; desc: string }[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const allIds = items.map(i => i.id);
  const allSelected = allIds.every(id => selected.includes(id));
  const someSelected = allIds.some(id => selected.includes(id));

  const toggleAll = () => {
    if (allSelected) {
      onChange(selected.filter(id => !allIds.includes(id)));
    } else {
      const toAdd = allIds.filter(id => !selected.includes(id));
      onChange([...selected, ...toAdd]);
    }
  };

  const toggleOne = (id: string) => {
    if (selected.includes(id)) {
      onChange(selected.filter(s => s !== id));
    } else {
      onChange([...selected, id]);
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] font-mono font-bold" style={{ color: "var(--text-secondary)" }}>
          {title} ({selected.filter(id => allIds.includes(id)).length}/{items.length})
        </span>
        <label className="flex items-center gap-1 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={allSelected}
            ref={el => { if (el) el.indeterminate = someSelected && !allSelected; }}
            onChange={toggleAll}
            className="w-3 h-3 rounded"
            style={{ accentColor: "var(--accent-gold)" }}
          />
          <span className="text-[9px] font-mono" style={{ color: "var(--accent-gold)" }}>全选</span>
        </label>
      </div>
      <div className="grid grid-cols-2 gap-1">
        {items.map(item => (
          <label
            key={item.id}
            className="flex items-center gap-1.5 px-2 py-1 rounded cursor-pointer select-none transition-all hover:bg-[rgba(255,255,255,0.03)]"
            style={{
              border: selected.includes(item.id)
                ? "1px solid rgba(194,168,50,0.2)"
                : "1px solid transparent",
              background: selected.includes(item.id)
                ? "rgba(194,168,50,0.05)"
                : "transparent",
            }}
          >
            <input
              type="checkbox"
              checked={selected.includes(item.id)}
              onChange={() => toggleOne(item.id)}
              className="w-3 h-3 rounded flex-shrink-0"
              style={{ accentColor: "var(--accent-gold)" }}
            />
            <div className="flex flex-col min-w-0">
              <span
                className="text-[11px] leading-tight truncate"
                style={{ color: selected.includes(item.id) ? "var(--accent-gold)" : "var(--text-muted)" }}
              >
                {item.label}
              </span>
              <span className="text-[9px] font-mono truncate" style={{ color: "var(--text-muted)", opacity: 0.5 }}>
                {item.desc}
              </span>
            </div>
          </label>
        ))}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════
   API Key Row
   ═══════════════════════════════════════════ */

function ApiKeyRow({
  item,
  onRevoke,
  onActivate,
  onDelete,
  onEdit,
}: {
  item: McpKeyItem;
  onRevoke: () => void;
  onActivate: () => void;
  onDelete: () => void;
  onEdit: () => void;
}) {
  const isActive = item.active === "true";
  const { tools, resources } = parsePermissions(item.permissions);
  const allPerms = [...tools.map(t => MCP_TOOLS.find(m => m.id === t)?.label || t), ...resources.map(r => MCP_RESOURCES.find(m => m.id === r)?.label || r)];
  const [showFullKey, setShowFullKey] = useState(false);
  const [fullKey, setFullKey] = useState("");
  const [loadingKey, setLoadingKey] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleReveal = async () => {
    if (showFullKey) {
      setShowFullKey(false);
      setFullKey("");
      return;
    }
    setLoadingKey(true);
    try {
      const res = await trpcCall(`mcp.revealKey?input=${encodeURIComponent(JSON.stringify({id:item.id}))}`);
      const data = res?.result?.data?.json || res?.result?.data || res;
      if (data?.key) {
        setFullKey(data.key);
        setShowFullKey(true);
      }
    } catch (e: any) {
      alert(e.message);
    } finally {
      setLoadingKey(false);
    }
  };

  const handleCopy = async () => {
    if (fullKey) {
      await navigator.clipboard.writeText(fullKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div
      className="glass-panel p-3 sci-border flex flex-col gap-2 transition-all hover:border-[var(--accent-gold)]/30"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span
            className="w-2 h-2 rounded-full flex-shrink-0"
            style={{ background: isActive ? "var(--success)" : "var(--text-muted)" }}
          />
          <span
            className="text-sm font-bold tracking-wide"
            style={{ color: "var(--text-primary)" }}
          >
            {item.name}
          </span>
          {item.agentName && (
            <span
              className="text-[10px] font-mono px-1.5 py-0.5 rounded"
              style={{ background: "var(--accent-glow-gold)", color: "var(--accent-gold)" }}
            >
              @{item.agentName}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {isActive ? (
            <button
              onClick={onRevoke}
              className="text-[10px] px-1.5 py-0.5 rounded hover:bg-[var(--accent-glow-red)] transition-colors"
              style={{ color: "var(--accent-red)" }}
            >
              撤销
            </button>
          ) : (
            <button
              onClick={onActivate}
              className="text-[10px] px-1.5 py-0.5 rounded hover:bg-[var(--accent-glow-gold)] transition-colors"
              style={{ color: "var(--accent-gold)" }}
            >
              启用
            </button>
          )}
          <button
            onClick={onEdit}
            className="text-[10px] px-1.5 py-0.5 rounded hover:bg-[rgba(100,181,246,0.1)] transition-colors"
            style={{ color: "var(--accent-cyan)" }}
          >
            编辑
          </button>
          <button
            onClick={onDelete}
            className="text-[10px] px-1 rounded hover:bg-[var(--accent-glow-red)] transition-colors"
            style={{ color: "var(--accent-red)" }}
          >
            ✕
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 text-[10px] items-center">
        <span className="font-mono" style={{ color: showFullKey ? "var(--accent-red-bright)" : "var(--text-muted)" }}>
          {showFullKey ? fullKey : item.keyPreview}
        </span>
        <button
          onClick={handleReveal}
          disabled={loadingKey}
          className="font-mono py-0.5 px-1.5 rounded transition-all hover:brightness-110"
          style={{ background: showFullKey ? "rgba(194,58,48,0.15)" : "rgba(100,181,246,0.08)", color: showFullKey ? "var(--accent-red)" : "var(--accent-cyan)", border: `1px solid ${showFullKey ? "rgba(194,58,48,0.2)" : "rgba(100,181,246,0.15)"}` }}
        >
          {loadingKey ? "..." : showFullKey ? "👁️ 隐藏" : "👁️ 查看"}
        </button>
        {showFullKey && (
          <button
            onClick={handleCopy}
            className="font-mono py-0.5 px-1.5 rounded transition-all hover:brightness-110"
            style={{ background: copied ? "rgba(0,200,100,0.15)" : "rgba(194,168,50,0.08)", color: copied ? "var(--success)" : "var(--accent-gold)", border: `1px solid ${copied ? "rgba(0,200,100,0.2)" : "rgba(194,168,50,0.15)"}` }}
          >
            {copied ? "✅ 已复制" : "📋 复制"}
          </button>
        )}
        <span
          className="font-mono py-0.5 px-1 rounded"
          style={{ background: "rgba(100,181,246,0.08)", color: "var(--accent-cyan)" }}
        >
          {item.rateLimit} QPS
        </span>
        {allPerms.length > 0 ? allPerms.slice(0, 4).map(p => (
          <span
            key={p}
            className="py-0.5 px-1 rounded font-mono"
            style={{ background: "rgba(255,255,255,0.03)", color: "var(--text-muted)" }}
          >
            {p}
          </span>
        )) : (
          <span className="py-0.5 px-1 rounded font-mono" style={{ color: "var(--accent-red)", opacity: 0.6 }}>
            无权限
          </span>
        )}
        {allPerms.length > 4 && (
          <span className="font-mono" style={{ color: "var(--text-muted)" }}>+{allPerms.length - 4}</span>
        )}
      </div>

      {item.lastUsedAt && (
        <div className="text-[9px] font-mono" style={{ color: "var(--text-muted)" }}>
          最近调用: {new Date(item.lastUsedAt).toLocaleString()}
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════
   Audit Log Tab
   ═══════════════════════════════════════════ */

function AuditLogPanel() {
  const [logs, setLogs] = useState<AuditLogItem[]>([]);
  const [stats, setStats] = useState<AuditStats | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    try {
      const [logData, statsData] = await Promise.all([
        trpcCall("mcp.getAuditLog", { limit: 100 }),
        trpcCall("mcp.getAuditStats"),
      ]);
      setLogs(Array.isArray(logData) ? logData : logData?.result?.data?.json || []);
      setStats(statsData?.result?.data?.json || statsData);
    } catch (e) {
      console.error("Failed to fetch audit logs:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  const resultColor = (r: string) =>
    r === "success" ? "var(--success)" : "var(--accent-red)";

  return (
    <div className="flex flex-col gap-4">
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { label: "总调用", value: stats.total },
            { label: "成功", value: stats.successCount },
            { label: "失败", value: stats.errorCount },
            { label: "失败率", value: stats.errorRate },
          ].map(s => (
            <div key={s.label} className="glass-panel p-3 sci-border text-center">
              <div className="text-[10px] mb-1 font-mono" style={{ color: "var(--text-muted)" }}>
                {s.label}
              </div>
              <div
                className="font-mono text-lg font-bold"
                style={{ color: "var(--accent-gold)" }}
              >
                {s.value}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="glass-panel p-4 sci-border">
        <div className="section-label mb-3">
          调用日志 · AUDIT_LOG ({logs.length})
        </div>
        <div className="overflow-x-auto max-h-[400px] overflow-y-auto custom-scrollbar">
          <table className="w-full text-xs">
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border-default)" }}>
                {["时间", "工具", "结果", "耗时", "Key ID", "错误"].map(h => (
                  <th
                    key={h}
                    className="text-left py-1.5 px-2 font-mono"
                    style={{ color: "var(--text-muted)" }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {logs.map(l => (
                <tr
                  key={l.id}
                  className="hover:bg-[rgba(180,200,255,0.02)]"
                  style={{ borderBottom: "1px solid rgba(255,255,255,0.03)" }}
                >
                  <td
                    className="py-1.5 px-2 font-mono text-[10px]"
                    style={{ color: "var(--text-muted)" }}
                  >
                    {new Date(l.createdAt).toLocaleTimeString()}
                  </td>
                  <td
                    className="py-1.5 px-2 font-mono"
                    style={{ color: "var(--text-secondary)" }}
                  >
                    {l.tool}
                  </td>
                  <td className="py-1.5 px-2">
                    <span style={{ color: resultColor(l.result) }}>{l.result}</span>
                  </td>
                  <td
                    className="py-1.5 px-2 font-mono"
                    style={{ color: "var(--text-muted)" }}
                  >
                    {l.durationMs ? `${l.durationMs}ms` : "-"}
                  </td>
                  <td
                    className="py-1.5 px-2 font-mono"
                    style={{ color: "var(--text-muted)" }}
                  >
                    #{l.keyId}
                  </td>
                  <td
                    className="py-1.5 px-2 text-[10px] max-w-[200px] truncate"
                    style={{ color: "var(--accent-red)" }}
                  >
                    {l.error || "-"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {logs.length === 0 && (
            <div
              className="text-center py-8 text-xs font-mono"
              style={{ color: "var(--text-muted)" }}
            >
              {loading ? "加载中..." : "暂无调用记录"}
            </div>
          )}
        </div>
      </div>

      <button
        onClick={fetchLogs}
        className="self-end px-3 py-1.5 rounded text-xs font-mono transition-all hover:brightness-110"
        style={{
          background: "var(--accent-glow-red)",
          color: "var(--accent-red-bright)",
          border: "1px solid rgba(194,58,48,0.15)",
        }}
      >
        刷新日志
      </button>
    </div>
  );
}

/* ═══════════════════════════════════════════
   Permission Edit Dialog (新建/编辑共用)
   ═══════════════════════════════════════════ */

function PermissionEditDialog({
  open,
  item,
  agents,
  onClose,
  onSaved,
}: {
  open: boolean;
  item: McpKeyItem | null;
  agents: { id: number; name: string }[];
  onClose: () => void;
  onSaved: (fullKey?: string) => void;
}) {
  const isEdit = !!item;
  const parsed = parsePermissions(item?.permissions ?? null);

  const [name, setName] = useState(item?.name || "");
  const [agentId, setAgentId] = useState(item?.agentId ? String(item.agentId) : "");
  const [selectedTools, setSelectedTools] = useState<string[]>(parsed.tools);
  const [selectedResources, setSelectedResources] = useState<string[]>(parsed.resources);
  const [rateLimit, setRateLimit] = useState(String(item?.rateLimit || 10));
  const [saving, setSaving] = useState(false);
  const [newKey, setNewKey] = useState("");

  const handleSave = async () => {
    setSaving(true);
    try {
      const perms = serializePermissions(selectedTools, selectedResources);
      if (isEdit) {
        await trpcCall("mcp.updateKey", {
          id: item!.id,
          name,
          permissions: perms,
          rateLimit: parseInt(rateLimit) || 10,
        });
        onSaved();
        onClose();
      } else {
        const res = await trpcCall("mcp.createKey", {
          name,
          agentId: agentId ? parseInt(agentId) : undefined,
          permissions: perms,
          rateLimit: parseInt(rateLimit) || 10,
        });
        const data = res?.result?.data?.json || res?.result?.data || res;
        if (data?.key) {
          setNewKey(data.key);
          onSaved(data.key);
          // 不自动关闭 — 让用户看到 Key 后再手动关闭
        } else {
          // 没返回 key 就直接关闭刷新
          onSaved();
          handleClose();
        }
      }
    } catch (e: any) {
      alert(e.message);
    } finally {
      setSaving(false);
    }
  };

  const handleClose = () => {
    setName("");
    setAgentId("");
    setSelectedTools([]);
    setSelectedResources([]);
    setRateLimit("10");
    setNewKey("");
    onClose();
  };

  // 显示新创建的 Key
  if (newKey) {
    const handleCopyAndClose = async () => {
      await navigator.clipboard.writeText(newKey);
      handleClose();
    };

    return (
      <Dialog open={open} onOpenChange={handleClose}>
        <DialogContent
          className="border-0 max-w-md"
          style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-default)" }}
        >
          <DialogHeader>
            <DialogTitle className="section-label">✅ API Key 已创建</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3 mt-2">
            <div
              className="text-sm font-mono p-3 rounded text-center break-all"
              style={{
                background: "rgba(194,58,48,0.1)",
                border: "1px solid rgba(194,58,48,0.2)",
                color: "var(--accent-red-bright)",
              }}
            >
              {newKey}
            </div>
            <p className="text-xs" style={{ color: "var(--text-secondary)" }}>
              ⚠️ 请立即复制此 Key，关闭后需通过「查看」按钮再次获取。
            </p>
            <div className="flex gap-2">
              <Button
                onClick={() => navigator.clipboard.writeText(newKey)}
                className="flex-1 text-xs"
                style={{ background: "var(--accent-cyan)", color: "#fff" }}
              >
                📋 复制
              </Button>
              <Button
                onClick={handleCopyAndClose}
                className="flex-1 text-xs font-bold"
                style={{ background: "var(--accent-red)", color: "#fff" }}
              >
                📋 复制并关闭
              </Button>
            </div>
            <Button
              onClick={handleClose}
              className="text-xs"
              variant="outline"
              style={{ border: "1px solid var(--border-default)", color: "var(--text-muted)" }}
            >
              关闭
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent
        className="border-0 max-w-lg max-h-[85vh] overflow-y-auto custom-scrollbar"
        style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-default)" }}
      >
        <DialogHeader>
          <DialogTitle className="section-label">
            {isEdit ? "编辑 API Key · EDIT" : "创建 MCP API Key · NEW KEY"}
          </DialogTitle>
        </DialogHeader>
        <form
          onSubmit={e => { e.preventDefault(); handleSave(); }}
          className="flex flex-col gap-4 mt-2"
        >
          {/* 用途说明 */}
          <div>
            <Label className="text-[10px] font-mono mb-1 block" style={{ color: "var(--text-muted)" }}>
              用途说明 · NAME
            </Label>
            <Input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="如: 美智子 OpenClaw 接入"
              required
              style={{
                background: "rgba(0,0,0,0.2)",
                border: "1px solid var(--border-default)",
                color: "var(--text-primary)",
              }}
            />
          </div>

          {/* 关联 Agent（仅新建时显示） */}
          {!isEdit && (
            <div>
              <Label className="text-[10px] font-mono mb-1 block" style={{ color: "var(--text-muted)" }}>
                关联 Agent · AGENT
              </Label>
              <select
                value={agentId}
                onChange={e => setAgentId(e.target.value)}
                className="w-full px-2 py-1.5 rounded text-xs"
                style={{
                  background: "rgba(0,0,0,0.2)",
                  border: "1px solid var(--border-default)",
                  color: "var(--text-primary)",
                }}
              >
                <option value="">不关联</option>
                {agents.map(a => (
                  <option key={a.id} value={String(a.id)}>{a.name}</option>
                ))}
              </select>
            </div>
          )}

          {/* Tools 权限 */}
          <PermissionGroup
            title="Tools · 可执行操作"
            items={MCP_TOOLS}
            selected={selectedTools}
            onChange={setSelectedTools}
          />

          {/* Resources 权限 */}
          <PermissionGroup
            title="Resources · 可读取数据"
            items={MCP_RESOURCES}
            selected={selectedResources}
            onChange={setSelectedResources}
          />

          {/* 速率限制 */}
          <div>
            <Label className="text-[10px] font-mono mb-1 block" style={{ color: "var(--text-muted)" }}>
              速率限制 (QPS) · RATE LIMIT
            </Label>
            <div className="flex items-center gap-2">
              <Input
                value={rateLimit}
                onChange={e => setRateLimit(e.target.value)}
                type="number"
                min={1}
                max={1000}
                className="w-24"
                style={{
                  background: "rgba(0,0,0,0.2)",
                  border: "1px solid var(--border-default)",
                  color: "var(--text-primary)",
                }}
              />
              <span className="text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>
                次/秒 — 每秒允许的最大请求数
              </span>
            </div>
          </div>

          {/* 按钮 */}
          <div className="flex gap-2 mt-1">
            <Button
              type="submit"
              disabled={saving}
              className="flex-1 text-xs font-bold"
              style={{
                background: isEdit ? "var(--accent-gold)" : "var(--accent-red)",
                color: isEdit ? "#000" : "#fff",
                boxShadow: isEdit ? "none" : "0 0 12px rgba(194,58,48,0.2)",
              }}
            >
              {saving ? "保存中..." : isEdit ? "保存修改" : "创建 Key"}
            </Button>
            <Button
              type="button"
              onClick={handleClose}
              className="text-xs"
              variant="outline"
              style={{ border: "1px solid var(--border-default)", color: "var(--text-muted)" }}
            >
              取消
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ═══════════════════════════════════════════
   Main MCP Panel
   ═══════════════════════════════════════════ */

export default function McpPanel() {
  const [keys, setKeys] = useState<McpKeyItem[]>([]);
  const [agents, setAgents] = useState<{ id: number; name: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<"keys" | "audit" | "guide">("keys");
  const [editItem, setEditItem] = useState<McpKeyItem | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const fetchKeys = useCallback(async () => {
    setLoading(true);
    try {
      const [keyData, agentData] = await Promise.all([
        trpcCall("mcp.listKeys"),
        trpcCall("agent.list"),
      ]);
      const normalizedKeys =
        (keyData?.result?.data?.json || keyData?.result?.data || keyData)?.map?.(
          (k: any) => ({ ...k, key: undefined })
        ) || [];
      const normalizedAgents =
        (agentData?.result?.data?.json || agentData?.result?.data || agentData)?.map?.(
          (a: any) => ({ id: a.id, name: a.name })
        ) || [];
      setKeys(normalizedKeys);
      setAgents(normalizedAgents);
    } catch (e) {
      console.error("Failed to fetch MCP keys:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchKeys();
  }, [fetchKeys]);

  const handleRevoke = async (id: number) => {
    try {
      await trpcCall("mcp.revokeKey", { id });
      fetchKeys();
    } catch (e: any) {
      alert(e.message);
    }
  };

  const handleActivate = async (id: number) => {
    try {
      await trpcCall("mcp.activateKey", { id });
      fetchKeys();
    } catch (e: any) {
      alert(e.message);
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm("确定要永久删除此 Key？此操作不可恢复。")) return;
    try {
      await trpcCall("mcp.deleteKey", { id });
      fetchKeys();
    } catch (e: any) {
      alert(e.message);
    }
  };

  const tabs = [
    { key: "keys" as const, label: "API Keys", icon: "🔑" },
    { key: "guide" as const, label: "接入指南", icon: "📖" },
    { key: "audit" as const, label: "审计日志", icon: "📋" },
  ];

  // Heartbeat test
  const [heartbeatAgentId, setHeartbeatAgentId] = useState("");
  const [heartbeatResult, setHeartbeatResult] = useState<string | null>(null);
  const [heartbeatLoading, setHeartbeatLoading] = useState(false);

  const handleHeartbeatTest = async () => {
    if (!heartbeatAgentId) return;
    setHeartbeatLoading(true);
    setHeartbeatResult(null);
    try {
      const res = await trpcCall("agent.updateHeartbeat", { id: parseInt(heartbeatAgentId) });
      const data = res?.result?.data?.json || res?.result?.data || res;
      setHeartbeatResult(data?.claimedTask
        ? `✅ 心跳成功！已自动认领任务: ${data.claimedTask.name}`
        : "✅ 心跳成功！当前无待认领任务"
      );
      // 刷新页面以更新 Agent 列表中的心跳时间和连接状态
      setTimeout(() => window.location.reload(), 1500);
    } catch (e: any) {
      setHeartbeatResult(`❌ 失败: ${e.message}`);
    } finally {
      setHeartbeatLoading(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Sub-tabs */}
      <div className="flex items-center gap-1">
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className="flex items-center gap-1.5 px-4 py-2 rounded text-sm font-bold transition-all"
            style={{
              background: tab === t.key ? "var(--accent-glow-red)" : "transparent",
              color: tab === t.key ? "var(--accent-red-bright)" : "var(--text-muted)",
              border: tab === t.key ? "1px solid rgba(194,58,48,0.2)" : "1px solid transparent",
            }}
          >
            <span>{t.icon}</span> {t.label}
          </button>
        ))}
        <div className="flex-1" />
        {tab === "keys" && (
          <button
            onClick={() => setShowCreate(true)}
            className="px-3 py-1.5 rounded text-xs font-bold tracking-wider transition-all hover:brightness-110"
            style={{
              background: "var(--accent-red)",
              color: "#fff",
              boxShadow: "0 0 12px rgba(194,58,48,0.2)",
            }}
          >
            + 新建 Key
          </button>
        )}
      </div>

      {/* Keys Tab */}
      {tab === "keys" && (
        <>
          {loading && (
            <div className="text-center py-4 text-xs font-mono" style={{ color: "var(--text-muted)" }}>
              加载中...
            </div>
          )}
          {!loading && keys.length === 0 && (
            <div className="glass-panel p-8 text-center">
              <div className="text-sm font-mono mb-2" style={{ color: "var(--text-muted)" }}>
                暂无 MCP API Key
              </div>
              <p className="text-xs" style={{ color: "var(--text-secondary)" }}>
                点击「+ 新建 Key」创建第一个 MCP 接入密钥
              </p>
            </div>
          )}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {keys.map(k => (
              <ApiKeyRow
                key={k.id}
                item={k}
                onRevoke={() => handleRevoke(k.id)}
                onActivate={() => handleActivate(k.id)}
                onDelete={() => handleDelete(k.id)}
                onEdit={() => setEditItem(k)}
              />
            ))}
          </div>
        </>
      )}

      {/* Audit Log Tab */}
      {tab === "audit" && <AuditLogPanel />}

      {/* Guide Tab */}
      {tab === "guide" && (
        <div className="flex flex-col gap-4">
          {/* 接入步骤 */}
          <div className="glass-panel p-5 sci-border">
            <div className="section-label mb-4">🚀 Agent 接入指南 · ONBOARDING</div>
            <div className="flex flex-col gap-4">
              {/* Step 1 */}
              <div className="flex gap-3">
                <div className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold"
                  style={{ background: "var(--accent-red)", color: "#fff" }}>1</div>
                <div className="flex-1">
                  <div className="text-sm font-bold mb-1" style={{ color: "var(--text-primary)" }}>
                    创建 MCP API Key
                  </div>
                  <p className="text-xs mb-2" style={{ color: "var(--text-secondary)" }}>
                    在「API Keys」标签页中为你的 Agent 创建一个 Key，选择需要的 Tools 和 Resources 权限。
                  </p>
                  <button onClick={() => setTab("keys")} className="text-xs font-mono px-2 py-1 rounded"
                    style={{ background: "var(--accent-glow-gold)", color: "var(--accent-gold)" }}>
                    前往创建 →
                  </button>
                </div>
              </div>

              {/* Step 2 */}
              <div className="flex gap-3">
                <div className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold"
                  style={{ background: "var(--accent-gold)", color: "#000" }}>2</div>
                <div className="flex-1">
                  <div className="text-sm font-bold mb-1" style={{ color: "var(--text-primary)" }}>
                    配置心跳 Cron 任务
                  </div>
                  <p className="text-xs mb-2" style={{ color: "var(--text-secondary)" }}>
                    在 OpenClaw 中设置定时心跳，每 5 分钟向天宫上报一次。替换下方命令中的 AGENT_ID 和 BASE_URL。
                  </p>
                  <div className="p-3 rounded font-mono text-xs overflow-x-auto"
                    style={{ background: "rgba(0,0,0,0.3)", border: "1px solid var(--border-default)", color: "var(--accent-cyan)" }}>
                    {`# 心跳上报 curl 命令
curl -X POST https://tiangg.zeabur.app/api/trpc/agent.updateHeartbeat \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer YOUR_MCP_KEY" \\
  -d '{"id": AGENT_DB_ID}'`}
                  </div>
                  <p className="text-[10px] mt-1 font-mono" style={{ color: "var(--text-muted)" }}>
                    💡 提示：将 AGENT_DB_ID 替换为 Agent 在天宫中的数字 ID，YOUR_MCP_KEY 替换为步骤1创建的 Key
                  </p>
                </div>
              </div>

              {/* Step 3 */}
              <div className="flex gap-3">
                <div className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold"
                  style={{ background: "var(--accent-cyan)", color: "#fff" }}>3</div>
                <div className="flex-1">
                  <div className="text-sm font-bold mb-1" style={{ color: "var(--text-primary)" }}>
                    验证在线状态
                  </div>
                  <p className="text-xs mb-2" style={{ color: "var(--text-secondary)" }}>
                    使用下方的心跳测试按钮手动触发一次心跳，确认 Agent 出现在仪表盘的「已连接」列表中。
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* 心跳测试 */}
          <div className="glass-panel p-5 sci-border">
            <div className="section-label mb-3">💓 心跳测试 · HEARTBEAT TEST</div>
            <div className="flex items-end gap-3">
              <div className="flex-1">
                <Label className="text-[10px] font-mono mb-1 block" style={{ color: "var(--text-muted)" }}>
                  选择 Agent
                </Label>
                <select
                  value={heartbeatAgentId}
                  onChange={e => setHeartbeatAgentId(e.target.value)}
                  className="w-full px-2 py-1.5 rounded text-xs"
                  style={{
                    background: "rgba(0,0,0,0.2)",
                    border: "1px solid var(--border-default)",
                    color: "var(--text-primary)",
                  }}
                >
                  <option value="">-- 选择 Agent --</option>
                  {agents.map(a => (
                    <option key={a.id} value={String(a.id)}>{a.name} (ID: {a.id})</option>
                  ))}
                </select>
              </div>
              <button
                onClick={handleHeartbeatTest}
                disabled={heartbeatLoading || !heartbeatAgentId}
                className="px-4 py-1.5 rounded text-xs font-bold transition-all hover:brightness-110 disabled:opacity-50"
                style={{ background: "var(--accent-red)", color: "#fff" }}
              >
                {heartbeatLoading ? "发送中..." : "💓 发送心跳"}
              </button>
            </div>
            {heartbeatResult && (
              <div className="mt-3 p-2 rounded text-xs font-mono"
                style={{
                  background: heartbeatResult.startsWith("✅") ? "rgba(0,200,100,0.1)" : "rgba(194,58,48,0.1)",
                  border: `1px solid ${heartbeatResult.startsWith("✅") ? "rgba(0,200,100,0.2)" : "rgba(194,58,48,0.2)"}`,
                  color: heartbeatResult.startsWith("✅") ? "var(--success)" : "var(--accent-red)",
                }}
              >
                {heartbeatResult}
              </div>
            )}
          </div>

          {/* MCP 协议说明 */}
          <div className="glass-panel p-5 sci-border">
            <div className="section-label mb-3">📡 MCP 协议说明 · PROTOCOL</div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <div className="text-xs font-bold mb-1" style={{ color: "var(--accent-gold)" }}>Tools（可执行操作）</div>
                <div className="flex flex-col gap-1">
                  {MCP_TOOLS.map(t => (
                    <div key={t.id} className="text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>
                      <span style={{ color: "var(--accent-cyan)" }}>{t.id}</span> — {t.desc}
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <div className="text-xs font-bold mb-1" style={{ color: "var(--accent-gold)" }}>Resources（可读取数据）</div>
                <div className="flex flex-col gap-1">
                  {MCP_RESOURCES.map(r => (
                    <div key={r.id} className="text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>
                      <span style={{ color: "var(--accent-cyan)" }}>{r.desc}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Dialogs — 新建和编辑共用一个组件 */}
      <PermissionEditDialog
        open={showCreate}
        item={null}
        agents={agents}
        onClose={() => setShowCreate(false)}
        onSaved={() => { setShowCreate(false); fetchKeys(); }}
      />
      <PermissionEditDialog
        open={!!editItem}
        item={editItem}
        agents={agents}
        onClose={() => setEditItem(null)}
        onSaved={() => { setEditItem(null); fetchKeys(); }}
      />
    </div>
  );
}
