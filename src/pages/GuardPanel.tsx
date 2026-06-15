/**
 * Phase 2: 高价模型熔断管理面板
 *
 * 功能：
 * - 查看/管理模型白名单
 * - 创建/撤销高价模型授权
 * - 查看熔断事件
 */
import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { Shield, ShieldOff, Plus, X, Clock, User, AlertTriangle } from "lucide-react";

interface AllowlistEntry {
  id: number;
  agentId: number;
  model: string;
  reason: string | null;
  createdBy: string | null;
  createdAt: string;
}

interface AuthEntry {
  id: number;
  agentId: number;
  model: string;
  reason: string;
  authorizedBy: string;
  expiresAt: string | null;
  active: string;
  createdAt: string;
}

function fmtDateTime(iso: string) {
  const d = new Date(iso);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const KNOWN_HIGH_COST = [
  "4sapi/gpt-5.5-high",
  "4sapi/claude-opus-4-8",
  "zeabur-ai/gpt-5.4-pro",
  "zeabur-ai/claude-opus-4-7",
  "zeabur-ai/claude-opus-4-6",
];

export default function GuardPanel() {
  const [agentId, setAgentId] = useState("");
  const [model, setModel] = useState("");
  const [reason, setReason] = useState("");
  const [authorizedBy, setAuthorizedBy] = useState("admin");
  const [expiresAt, setExpiresAt] = useState("");
  const [showAddAllowlist, setShowAddAllowlist] = useState(false);
  const [showCreateAuth, setShowCreateAuth] = useState(false);

  const allowlistQuery = trpc.guard.listAllowlist.useQuery(
    { agentId: agentId ? Number(agentId) : undefined },
    { retry: 1, staleTime: 10_000 }
  );
  const authQuery = trpc.guard.listAuth.useQuery(
    { agentId: agentId ? Number(agentId) : undefined, active: "true" },
    { retry: 1, staleTime: 10_000 }
  );

  const addAllowlist = trpc.guard.addAllowlist.useMutation({
    onSuccess: () => {
      allowlistQuery.refetch();
      setShowAddAllowlist(false);
      setModel("");
      setReason("");
    },
  });
  const removeAllowlist = trpc.guard.removeAllowlist.useMutation({
    onSuccess: () => allowlistQuery.refetch(),
  });
  const createAuth = trpc.guard.createAuth.useMutation({
    onSuccess: () => {
      authQuery.refetch();
      setShowCreateAuth(false);
      setModel("");
      setReason("");
      setExpiresAt("");
    },
  });
  const revokeAuth = trpc.guard.revokeAuth.useMutation({
    onSuccess: () => authQuery.refetch(),
  });

  const allowlist = (allowlistQuery.data as AllowlistEntry[]) || [];
  const auths = (authQuery.data as AuthEntry[]) || [];

  return (
    <div className="min-h-screen" style={{ background: "var(--bg-primary)" }}>
      <div className="max-w-6xl mx-auto px-4 sm:px-6 pt-24 pb-16">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-black tracking-wider" style={{ color: "var(--text-primary)" }}>
              模型熔断管理
            </h1>
            <p className="text-[10px] font-mono mt-1" style={{ color: "var(--text-muted)" }}>
              白名单 · 高价模型授权 · 熔断审计
            </p>
          </div>
        </div>

        {/* 已知高价模型 */}
        <div className="glass-panel p-4 sci-border mb-6">
          <div className="text-[10px] font-mono mb-3 uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
            已知高价模型 · KNOWN HIGH-COST MODELS
          </div>
          <div className="flex flex-wrap gap-2">
            {KNOWN_HIGH_COST.map((m) => (
              <div
                key={m}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-mono"
                style={{ background: "rgba(255,80,80,0.08)", border: "1px solid rgba(255,80,80,0.2)", color: "var(--danger)" }}
              >
                <AlertTriangle size={12} />
                {m}
              </div>
            ))}
          </div>
        </div>

        {/* Agent 筛选 */}
        <div className="mb-4">
          <label className="text-[10px] font-mono mb-1 block" style={{ color: "var(--text-muted)" }}>
            Agent ID
          </label>
          <input
            type="number"
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            placeholder="筛选 Agent ID..."
            className="px-3 py-2 rounded text-xs outline-none"
            style={{ background: "rgba(0,0,0,0.2)", border: "1px solid var(--border-default)", color: "var(--text-primary)", width: "200px" }}
          />
        </div>

        {/* 白名单 */}
        <div className="glass-panel p-4 sci-border mb-6">
          <div className="flex items-center justify-between mb-3">
            <div className="text-[10px] font-mono uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
              模型白名单 · MODEL ALLOWLIST
            </div>
            <button
              onClick={() => setShowAddAllowlist(true)}
              className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded font-mono"
              style={{ background: "rgba(74,158,255,0.1)", border: "1px solid rgba(74,158,255,0.3)", color: "var(--accent-cyan)" }}
            >
              <Plus size={12} /> 添加
            </button>
          </div>

          {showAddAllowlist && (
            <div className="mb-3 p-3 rounded" style={{ background: "rgba(74,158,255,0.05)", border: "1px solid rgba(74,158,255,0.15)" }}>
              <div className="flex flex-wrap gap-2 items-end">
                <div>
                  <label className="text-[9px] font-mono mb-1 block" style={{ color: "var(--text-muted)" }}>Agent ID</label>
                  <input
                    type="number"
                    value={agentId}
                    onChange={(e) => setAgentId(e.target.value)}
                    className="px-2 py-1.5 rounded text-xs outline-none"
                    style={{ background: "rgba(0,0,0,0.2)", border: "1px solid var(--border-default)", color: "var(--text-primary)", width: "100px" }}
                  />
                </div>
                <div>
                  <label className="text-[9px] font-mono mb-1 block" style={{ color: "var(--text-muted)" }}>模型</label>
                  <input
                    type="text"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    placeholder="例: volcengine-agent-plan/deepseek-v4-flash"
                    className="px-2 py-1.5 rounded text-xs outline-none"
                    style={{ background: "rgba(0,0,0,0.2)", border: "1px solid var(--border-default)", color: "var(--text-primary)", width: "300px" }}
                  />
                </div>
                <div>
                  <label className="text-[9px] font-mono mb-1 block" style={{ color: "var(--text-muted)" }}>原因</label>
                  <input
                    type="text"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="为什么添加？"
                    className="px-2 py-1.5 rounded text-xs outline-none"
                    style={{ background: "rgba(0,0,0,0.2)", border: "1px solid var(--border-default)", color: "var(--text-primary)", width: "200px" }}
                  />
                </div>
                <button
                  onClick={() => {
                    if (agentId && model) {
                      addAllowlist.mutate({
                        agentId: Number(agentId),
                        model,
                        reason: reason || undefined,
                        createdBy: "admin",
                      });
                    }
                  }}
                  className="px-3 py-1.5 rounded text-xs font-mono"
                  style={{ background: "var(--accent-cyan)", color: "#000" }}
                >
                  确认添加
                </button>
                <button
                  onClick={() => setShowAddAllowlist(false)}
                  className="px-3 py-1.5 rounded text-xs font-mono"
                  style={{ border: "1px solid var(--border-default)", color: "var(--text-muted)" }}
                >
                  取消
                </button>
              </div>
            </div>
          )}

          {allowlist.length === 0 ? (
            <div className="text-xs py-4" style={{ color: "var(--text-muted)" }}>
              暂无白名单条目
            </div>
          ) : (
            <div className="space-y-1">
              {allowlist.map((entry) => (
                <div
                  key={entry.id}
                  className="flex items-center justify-between gap-2 py-2 px-3 rounded text-xs"
                  style={{ background: "rgba(255,255,255,0.01)", border: "1px solid rgba(255,255,255,0.03)" }}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <Shield size={14} style={{ color: "var(--success)" }} />
                    <span className="font-mono" style={{ color: "var(--text-primary)" }}>{entry.model}</span>
                    <span className="text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>Agent #{entry.agentId}</span>
                    {entry.reason && (
                      <span className="text-[10px]" style={{ color: "var(--text-secondary)" }}>{entry.reason}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    <span className="text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>
                      {entry.createdBy} · {fmtDateTime(entry.createdAt)}
                    </span>
                    <button
                      onClick={() => removeAllowlist.mutate({ id: entry.id })}
                      className="p-1 rounded hover:bg-[rgba(255,80,80,0.1)]"
                      style={{ color: "var(--danger)" }}
                    >
                      <X size={12} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 高价模型授权 */}
        <div className="glass-panel p-4 sci-border">
          <div className="flex items-center justify-between mb-3">
            <div className="text-[10px] font-mono uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
              高价模型授权 · HIGH-COST MODEL AUTHORIZATIONS
            </div>
            <button
              onClick={() => setShowCreateAuth(true)}
              className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded font-mono"
              style={{ background: "rgba(255,200,50,0.1)", border: "1px solid rgba(255,200,50,0.3)", color: "var(--accent-gold)" }}
            >
              <Plus size={12} /> 新建授权
            </button>
          </div>

          {showCreateAuth && (
            <div className="mb-3 p-3 rounded" style={{ background: "rgba(255,200,50,0.05)", border: "1px solid rgba(255,200,50,0.15)" }}>
              <div className="flex flex-wrap gap-2 items-end">
                <div>
                  <label className="text-[9px] font-mono mb-1 block" style={{ color: "var(--text-muted)" }}>Agent ID</label>
                  <input
                    type="number"
                    value={agentId}
                    onChange={(e) => setAgentId(e.target.value)}
                    className="px-2 py-1.5 rounded text-xs outline-none"
                    style={{ background: "rgba(0,0,0,0.2)", border: "1px solid var(--border-default)", color: "var(--text-primary)", width: "100px" }}
                  />
                </div>
                <div>
                  <label className="text-[9px] font-mono mb-1 block" style={{ color: "var(--text-muted)" }}>模型</label>
                  <input
                    type="text"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    placeholder="例: 4sapi/gpt-5.5-high"
                    className="px-2 py-1.5 rounded text-xs outline-none"
                    style={{ background: "rgba(0,0,0,0.2)", border: "1px solid var(--border-default)", color: "var(--text-primary)", width: "300px" }}
                  />
                </div>
                <div>
                  <label className="text-[9px] font-mono mb-1 block" style={{ color: "var(--text-muted)" }}>原因</label>
                  <input
                    type="text"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="为什么需要这个模型？"
                    className="px-2 py-1.5 rounded text-xs outline-none"
                    style={{ background: "rgba(0,0,0,0.2)", border: "1px solid var(--border-default)", color: "var(--text-primary)", width: "200px" }}
                  />
                </div>
                <div>
                  <label className="text-[9px] font-mono mb-1 block" style={{ color: "var(--text-muted)" }}>授权人</label>
                  <input
                    type="text"
                    value={authorizedBy}
                    onChange={(e) => setAuthorizedBy(e.target.value)}
                    className="px-2 py-1.5 rounded text-xs outline-none"
                    style={{ background: "rgba(0,0,0,0.2)", border: "1px solid var(--border-default)", color: "var(--text-primary)", width: "100px" }}
                  />
                </div>
                <div>
                  <label className="text-[9px] font-mono mb-1 block" style={{ color: "var(--text-muted)" }}>过期时间（可选）</label>
                  <input
                    type="datetime-local"
                    value={expiresAt}
                    onChange={(e) => setExpiresAt(e.target.value)}
                    className="px-2 py-1.5 rounded text-xs outline-none"
                    style={{ background: "rgba(0,0,0,0.2)", border: "1px solid var(--border-default)", color: "var(--text-primary)" }}
                  />
                </div>
                <button
                  onClick={() => {
                    if (agentId && model && reason) {
                      createAuth.mutate({
                        agentId: Number(agentId),
                        model,
                        reason,
                        authorizedBy,
                        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
                      });
                    }
                  }}
                  className="px-3 py-1.5 rounded text-xs font-mono"
                  style={{ background: "var(--accent-gold)", color: "#000" }}
                >
                  确认授权
                </button>
                <button
                  onClick={() => setShowCreateAuth(false)}
                  className="px-3 py-1.5 rounded text-xs font-mono"
                  style={{ border: "1px solid var(--border-default)", color: "var(--text-muted)" }}
                >
                  取消
                </button>
              </div>
            </div>
          )}

          {auths.length === 0 ? (
            <div className="text-xs py-4" style={{ color: "var(--text-muted)" }}>
              暂无高价模型授权
            </div>
          ) : (
            <div className="space-y-1">
              {auths.map((auth) => {
                const expired = auth.expiresAt && new Date(auth.expiresAt) < new Date();
                return (
                  <div
                    key={auth.id}
                    className="flex items-center justify-between gap-2 py-2 px-3 rounded text-xs"
                    style={{
                      background: expired ? "rgba(255,80,80,0.03)" : "rgba(255,255,255,0.01)",
                      border: expired ? "1px solid rgba(255,80,80,0.1)" : "1px solid rgba(255,255,255,0.03)",
                    }}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      {expired ? (
                        <ShieldOff size={14} style={{ color: "var(--danger)" }} />
                      ) : (
                        <Shield size={14} style={{ color: "var(--accent-gold)" }} />
                      )}
                      <span className="font-mono" style={{ color: "var(--text-primary)" }}>{auth.model}</span>
                      <span className="text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>Agent #{auth.agentId}</span>
                      <span className="text-[10px]" style={{ color: "var(--text-secondary)" }}>{auth.reason}</span>
                    </div>
                    <div className="flex items-center gap-3 flex-shrink-0">
                      <span className="flex items-center gap-1 text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>
                        <User size={10} /> {auth.authorizedBy}
                      </span>
                      {auth.expiresAt && (
                        <span className="flex items-center gap-1 text-[10px] font-mono" style={{ color: expired ? "var(--danger)" : "var(--text-muted)" }}>
                          <Clock size={10} /> {expired ? "已过期" : fmtDateTime(auth.expiresAt)}
                        </span>
                      )}
                      {!expired && (
                        <button
                          onClick={() => revokeAuth.mutate({ id: auth.id })}
                          className="p-1 rounded hover:bg-[rgba(255,80,80,0.1)]"
                          style={{ color: "var(--danger)" }}
                        >
                          <X size={12} />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
