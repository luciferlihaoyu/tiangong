/**
 * 天宫 MCP 接入管理 Tab
 * Task 6: MCP API Key management + audit log viewing
 *
 * 中国科幻风 UI — 与 Dashboard 风格统一
 */

import { useState, useEffect, useCallback } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

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
  let perms: string[] = [];
  try {
    perms = item.permissions ? JSON.parse(item.permissions)?.tools || [] : [];
  } catch {}

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

      <div className="flex flex-wrap gap-2 text-[10px]">
        <span className="font-mono" style={{ color: "var(--text-muted)" }}>
          {item.keyPreview}
        </span>
        <span
          className="font-mono py-0.5 px-1 rounded"
          style={{ background: "rgba(100,181,246,0.08)", color: "var(--accent-cyan)" }}
        >
          {item.rateLimit}/s
        </span>
        {perms.map(p => (
          <span
            key={p}
            className="py-0.5 px-1 rounded font-mono"
            style={{ background: "rgba(255,255,255,0.03)", color: "var(--text-muted)" }}
          >
            {p}
          </span>
        ))}
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
      {/* Stats */}
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

      {/* Log list */}
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
   Key Edit/View Dialog
   ═══════════════════════════════════════════ */

function EditKeyDialog({
  item,
  onClose,
  onSaved,
}: {
  item: McpKeyItem | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  if (!item) return null;

  const [name, setName] = useState(item.name);
  const [permissions, setPermissions] = useState(item.permissions || "");
  const [rateLimit, setRateLimit] = useState(String(item.rateLimit || 10));
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      await trpcCall("mcp.updateKey", {
        id: item.id,
        name,
        permissions: permissions || null,
        rateLimit: parseInt(rateLimit) || 10,
      });
      onSaved();
      onClose();
    } catch (e: any) {
      alert(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={!!item} onOpenChange={() => onClose()}>
      <DialogContent
        className="border-0 max-w-md"
        style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-default)" }}
      >
        <DialogHeader>
          <DialogTitle
            className="section-label"
          >
            编辑 API Key · EDIT
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3 mt-2">
          <div>
            <Label
              className="text-[10px] font-mono mb-1 block"
              style={{ color: "var(--text-muted)" }}
            >
              Key
            </Label>
            <Input
              value={item.keyPreview}
              disabled
              className="font-mono text-xs opacity-50"
              style={{
                background: "rgba(0,0,0,0.2)",
                border: "1px solid var(--border-default)",
                color: "var(--text-muted)",
              }}
            />
          </div>
          <div>
            <Label
              className="text-[10px] font-mono mb-1 block"
              style={{ color: "var(--text-muted)" }}
            >
              用途说明 · NAME
            </Label>
            <Input
              value={name}
              onChange={e => setName(e.target.value)}
              style={{
                background: "rgba(0,0,0,0.2)",
                border: "1px solid var(--border-default)",
                color: "var(--text-primary)",
              }}
            />
          </div>
          <div>
            <Label
              className="text-[10px] font-mono mb-1 block"
              style={{ color: "var(--text-muted)" }}
            >
              权限 JSON · PERMISSIONS
            </Label>
            <Input
              value={permissions}
              onChange={e => setPermissions(e.target.value)}
              placeholder='{"tools":["create_task"],"resources":["agents"]}'
              style={{
                background: "rgba(0,0,0,0.2)",
                border: "1px solid var(--border-default)",
                color: "var(--text-primary)",
              }}
            />
          </div>
          <div>
            <Label
              className="text-[10px] font-mono mb-1 block"
              style={{ color: "var(--text-muted)" }}
            >
              速率限制 /s · RATE LIMIT
            </Label>
            <Input
              value={rateLimit}
              onChange={e => setRateLimit(e.target.value)}
              type="number"
              min={1}
              max={100}
              style={{
                background: "rgba(0,0,0,0.2)",
                border: "1px solid var(--border-default)",
                color: "var(--text-primary)",
              }}
            />
          </div>
          <div className="flex gap-2 mt-2">
            <Button
              onClick={handleSave}
              disabled={saving}
              className="flex-1 text-xs font-bold"
              style={{ background: "var(--accent-gold)", color: "#000" }}
            >
              {saving ? "保存中..." : "保存"}
            </Button>
            <Button
              onClick={onClose}
              className="text-xs"
              variant="outline"
              style={{ border: "1px solid var(--border-default)", color: "var(--text-muted)" }}
            >
              取消
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ═══════════════════════════════════════════
   Create Key Dialog
   ═══════════════════════════════════════════ */

function CreateKeyDialog({
  open,
  onOpenChange,
  onCreated,
  agents,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: (fullKey: string) => void;
  agents: { id: number; name: string }[];
}) {
  const [name, setName] = useState("");
  const [agentId, setAgentId] = useState("");
  const [permissions, setPermissions] = useState("");
  const [rateLimit, setRateLimit] = useState("10");
  const [creating, setCreating] = useState(false);
  const [newKey, setNewKey] = useState("");

  const handleCreate = async () => {
    setCreating(true);
    try {
      const res = await trpcCall("mcp.createKey", {
        name,
        agentId: agentId ? parseInt(agentId) : undefined,
        permissions: permissions || null,
        rateLimit: parseInt(rateLimit) || 10,
      });

      const data = res?.result?.data?.json || res;
      if (data?.key) {
        setNewKey(data.key);
        onCreated(data.key);
      }
    } catch (e: any) {
      alert(e.message);
    } finally {
      setCreating(false);
    }
  };

  const handleClose = () => {
    setName("");
    setAgentId("");
    setPermissions("");
    setRateLimit("10");
    setNewKey("");
    onOpenChange(false);
  };

  if (newKey) {
    return (
      <Dialog open={open} onOpenChange={handleClose}>
        <DialogContent
          className="border-0 max-w-md"
          style={{
            background: "var(--bg-secondary)",
            border: "1px solid var(--border-default)",
          }}
        >
          <DialogHeader>
            <DialogTitle className="section-label">
              ✅ API Key 已创建
            </DialogTitle>
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
              ⚠️ 请立即复制此 Key，关闭后无法再次查看完整 Key。
            </p>
            <Button
              onClick={() => navigator.clipboard.writeText(newKey)}
              className="text-xs"
              style={{ background: "var(--accent-cyan)", color: "#fff" }}
            >
              📋 复制到剪贴板
            </Button>
            <Button
              onClick={handleClose}
              className="text-xs"
              variant="outline"
              style={{
                border: "1px solid var(--border-default)",
                color: "var(--text-muted)",
              }}
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
        className="border-0 max-w-md"
        style={{
          background: "var(--bg-secondary)",
          border: "1px solid var(--border-default)",
        }}
      >
        <DialogHeader>
          <DialogTitle className="section-label">
            创建 MCP API Key · NEW KEY
          </DialogTitle>
        </DialogHeader>
        <form
          onSubmit={e => {
            e.preventDefault();
            handleCreate();
          }}
          className="flex flex-col gap-3 mt-2"
        >
          <div>
            <Label
              className="text-[10px] font-mono mb-1 block"
              style={{ color: "var(--text-muted)" }}
            >
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
          <div>
            <Label
              className="text-[10px] font-mono mb-1 block"
              style={{ color: "var(--text-muted)" }}
            >
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
                <option key={a.id} value={String(a.id)}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label
              className="text-[10px] font-mono mb-1 block"
              style={{ color: "var(--text-muted)" }}
            >
              权限 JSON · PERMISSIONS (可选)
            </Label>
            <Input
              value={permissions}
              onChange={e => setPermissions(e.target.value)}
              placeholder='{"tools":["create_task"],"resources":["agents"]}'
              style={{
                background: "rgba(0,0,0,0.2)",
                border: "1px solid var(--border-default)",
                color: "var(--text-primary)",
              }}
            />
          </div>
          <div>
            <Label
              className="text-[10px] font-mono mb-1 block"
              style={{ color: "var(--text-muted)" }}
            >
              速率限制 /s · RATE LIMIT
            </Label>
            <Input
              value={rateLimit}
              onChange={e => setRateLimit(e.target.value)}
              type="number"
              min={1}
              max={100}
              style={{
                background: "rgba(0,0,0,0.2)",
                border: "1px solid var(--border-default)",
                color: "var(--text-primary)",
              }}
            />
          </div>
          <div className="flex gap-2 mt-2">
            <Button
              type="submit"
              disabled={creating}
              className="flex-1 text-xs font-bold"
              style={{
                background: "var(--accent-red)",
                color: "#fff",
                boxShadow: "0 0 12px rgba(194,58,48,0.2)",
              }}
            >
              {creating ? "创建中..." : "创建 Key"}
            </Button>
            <Button
              type="button"
              onClick={handleClose}
              className="text-xs"
              variant="outline"
              style={{
                border: "1px solid var(--border-default)",
                color: "var(--text-muted)",
              }}
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
  const [tab, setTab] = useState<"keys" | "audit">("keys");
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
    { key: "audit" as const, label: "审计日志", icon: "📋" },
  ];

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
              background:
                tab === t.key ? "var(--accent-glow-red)" : "transparent",
              color:
                tab === t.key
                  ? "var(--accent-red-bright)"
                  : "var(--text-muted)",
              border:
                tab === t.key
                  ? "1px solid rgba(194,58,48,0.2)"
                  : "1px solid transparent",
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
            <div
              className="text-center py-4 text-xs font-mono"
              style={{ color: "var(--text-muted)" }}
            >
              加载中...
            </div>
          )}
          {!loading && keys.length === 0 && (
            <div
              className="glass-panel p-8 text-center"
            >
              <div
                className="text-sm font-mono mb-2"
                style={{ color: "var(--text-muted)" }}
              >
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

      {/* Dialogs */}
      <EditKeyDialog
        item={editItem}
        onClose={() => setEditItem(null)}
        onSaved={fetchKeys}
      />
      <CreateKeyDialog
        open={showCreate}
        onOpenChange={setShowCreate}
        onCreated={() => fetchKeys()}
        agents={agents}
      />
    </div>
  );
}
