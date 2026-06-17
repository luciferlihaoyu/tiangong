/**
 * P11: GitHub App Integration Panel
 *
 * Features:
 * - GitHub App readiness display (app id, installation, private key status)
 * - Repo management (add, list)
 * - Agent permission management (grant, revoke)
 * - PR approval queue (register, approve, reject, audit)
 */
import { useState } from "react";
import { trpc } from "@/providers/trpc";
import {
  GitBranch,
  CheckCircle2,
  XCircle,
  Clock,
  Shield,
  Key,
  Plus,
  Trash2,
  Eye,
  RefreshCw,
  Lock,
  Unlock,
  ExternalLink,
} from "lucide-react";

/* ═══════════════════════════════════════════
   辅助函数
   ═══════════════════════════════════════════ */

function fmtDateTime(iso: string | null | undefined) {
  if (!iso) return "-";
  const d = new Date(iso);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function StatusBadge({ value }: { value: string }) {
  const config: Record<string, { color: string; label: string }> = {
    pending: { color: "var(--accent-gold)", label: "待审批" },
    approved: { color: "var(--success)", label: "已批准" },
    rejected: { color: "var(--danger)", label: "已拒绝" },
    merged: { color: "var(--accent-cyan)", label: "已合并" },
    closed: { color: "var(--text-muted)", label: "已关闭" },
  };
  const c = config[value] || { color: "var(--text-muted)", label: value };
  return (
    <span
      className="inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded"
      style={{ background: `${c.color}15`, color: c.color, border: `1px solid ${c.color}30` }}
    >
      {c.label}
    </span>
  );
}

function YesNo({ value }: { value: boolean }) {
  return value ? (
    <span className="flex items-center gap-1 text-[10px]" style={{ color: "var(--success)" }}>
      <CheckCircle2 size={10} /> 已配置
    </span>
  ) : (
    <span className="flex items-center gap-1 text-[10px]" style={{ color: "var(--text-muted)" }}>
      <XCircle size={10} /> 未配置
    </span>
  );
}

/* ═══════════════════════════════════════════
   子组件: Readiness
   ═══════════════════════════════════════════ */

function ReadinessPanel({ readiness, onRefresh }: { readiness: any; onRefresh: () => void }) {
  if (!readiness) {
    return (
      <div className="glass-panel p-4 sci-border">
        <div className="text-xs" style={{ color: "var(--text-muted)" }}>加载中...</div>
      </div>
    );
  }

  return (
    <div className="glass-panel p-4 sci-border">
      <div className="flex items-center justify-between mb-3">
        <div className="text-[10px] font-mono uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
          GitHub App 连接状态
        </div>
        <button
          onClick={onRefresh}
          className="text-[10px] font-mono px-2 py-1 rounded hover:bg-[rgba(180,200,255,0.05)]"
          style={{ color: "var(--text-muted)", border: "1px solid var(--border-default)" }}
        >
          <RefreshCw size={12} />
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <div className="p-2 rounded text-center" style={{ background: "rgba(255,255,255,0.02)" }}>
          <div className="text-[9px] font-mono mb-1" style={{ color: "var(--text-muted)" }}>App ID</div>
          <YesNo value={readiness.appIdConfigured} />
          {readiness.appIdConfigured && readiness.appId && (
            <div className="text-[8px] mt-0.5 font-mono" style={{ color: "var(--text-muted)" }}>{readiness.appId}</div>
          )}
        </div>
        <div className="p-2 rounded text-center" style={{ background: "rgba(255,255,255,0.02)" }}>
          <div className="text-[9px] font-mono mb-1" style={{ color: "var(--text-muted)" }}>Private Key</div>
          <YesNo value={readiness.privateKeyConfigured} />
        </div>
        <div className="p-2 rounded text-center" style={{ background: "rgba(255,255,255,0.02)" }}>
          <div className="text-[9px] font-mono mb-1" style={{ color: "var(--text-muted)" }}>Installation ID</div>
          <YesNo value={readiness.installationIdConfigured} />
          {readiness.installationIdConfigured && readiness.installationId && (
            <div className="text-[8px] mt-0.5 font-mono" style={{ color: "var(--text-muted)" }}>{readiness.installationId}</div>
          )}
        </div>
        <div className="p-2 rounded text-center" style={{ background: "rgba(255,255,255,0.02)" }}>
          <div className="text-[9px] font-mono mb-1" style={{ color: "var(--text-muted)" }}>Webhook</div>
          <YesNo value={readiness.webhookSecretConfigured} />
        </div>
        <div className="p-2 rounded text-center" style={{ background: readiness.ready ? "rgba(0,255,0,0.03)" : "rgba(255,0,0,0.03)" }}>
          <div className="text-[9px] font-mono mb-1" style={{ color: "var(--text-muted)" }}>就绪</div>
          <span
            className="flex items-center justify-center gap-1 text-[10px]"
            style={{ color: readiness.ready ? "var(--success)" : "var(--danger)" }}
          >
            {readiness.ready ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
            {readiness.ready ? "已就绪" : "未就绪"}
          </span>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════
   子组件: Repos
   ═══════════════════════════════════════════ */

function RepoPanel({ repos, onRefresh }: { repos: any[]; onRefresh: () => void }) {
  const [showAdd, setShowAdd] = useState(false);
  const [owner, setOwner] = useState("luciferlihaoyu");
  const [name, setName] = useState("tiangong");
  const [msg, setMsg] = useState("");

  const addMut = trpc.github.addRepo.useMutation({
    onSuccess: (data: any) => {
      if (data.success) {
        setMsg("已添加");
        setShowAdd(false);
        onRefresh();
      } else {
        setMsg(`错误: ${data.error ?? "未知错误"}`);
      }
    },
    onError: (e) => setMsg(`错误: ${e.message}`),
  });

  return (
    <div className="glass-panel p-4 sci-border">
      <div className="flex items-center justify-between mb-3">
        <div className="text-[10px] font-mono uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
          管理仓库 · REPOS
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => { setShowAdd(false); onRefresh(); }}
            className="text-[10px] font-mono px-2 py-1 rounded hover:bg-[rgba(180,200,255,0.05)]"
            style={{ color: "var(--text-muted)", border: "1px solid var(--border-default)" }}
          >
            <RefreshCw size={12} />
          </button>
          <button
            onClick={() => setShowAdd(true)}
            className="flex items-center gap-1 text-[10px] font-mono px-2 py-1 rounded"
            style={{ background: "var(--accent-cyan)", color: "#000" }}
          >
            <Plus size={12} /> 添加
          </button>
        </div>
      </div>

      {msg && (
        <div className="text-[10px] font-mono mb-2 px-2 py-1 rounded" style={{ background: "rgba(255,255,255,0.03)", color: "var(--text-muted)" }}>
          {msg}
        </div>
      )}

      {showAdd && (
        <div className="mb-3 p-3 rounded" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)" }}>
          <div className="flex gap-2 mb-2">
            <input
              value={owner}
              onChange={(e) => setOwner(e.target.value)}
              placeholder="owner"
              className="flex-1 px-2 py-1.5 rounded text-xs font-mono outline-none"
              style={{ background: "rgba(0,0,0,0.2)", border: "1px solid var(--border-default)", color: "var(--text-primary)" }}
            />
            <span className="self-center text-xs" style={{ color: "var(--text-muted)" }}>/</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="repo"
              className="flex-1 px-2 py-1.5 rounded text-xs font-mono outline-none"
              style={{ background: "rgba(0,0,0,0.2)", border: "1px solid var(--border-default)", color: "var(--text-primary)" }}
            />
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => { if (owner && name) addMut.mutate({ owner, name }); }}
              disabled={!owner || !name || addMut.isPending}
              className="px-3 py-1 rounded text-[10px] font-mono disabled:opacity-40"
              style={{ background: "var(--accent-cyan)", color: "#000" }}
            >
              {addMut.isPending ? "添加中..." : "确认添加"}
            </button>
            <button
              onClick={() => setShowAdd(false)}
              className="px-3 py-1 rounded text-[10px] font-mono"
              style={{ border: "1px solid var(--border-default)", color: "var(--text-muted)" }}
            >
              取消
            </button>
          </div>
        </div>
      )}

      {repos.length === 0 ? (
        <div className="text-xs py-2" style={{ color: "var(--text-muted)" }}>
          暂无仓库 — 点击「添加」以上手。
        </div>
      ) : (
        <div className="space-y-1">
          {repos.map((r: any) => (
            <div
              key={r.id}
              className="flex items-center justify-between gap-2 py-1.5 px-2 rounded text-[10px] font-mono"
              style={{ background: "rgba(255,255,255,0.01)", border: "1px solid rgba(255,255,255,0.03)" }}
            >
              <div className="flex items-center gap-2">
                <GitBranch size={12} style={{ color: "var(--accent-cyan)" }} />
                <a
                  href={`https://github.com/${r.owner}/${r.name}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 transition-opacity hover:opacity-80"
                  style={{ color: "var(--text-primary)" }}
                >
                  <span>{r.fullName}</span>
                  <ExternalLink size={10} style={{ color: "var(--text-muted)" }} />
                </a>
                <span style={{ color: "var(--text-muted)" }}>分支: {r.defaultBranch}</span>
              </div>
              <span style={{ color: "var(--text-muted)" }}>权限: {r.permissionCount ?? 0}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════
   子组件: Permissions
   ═══════════════════════════════════════════ */

function PermissionPanel({
  repoId,
  permissions,
  agents,
  onRefresh,
}: {
  repoId: number;
  permissions: any[];
  agents: any[];
  onRefresh: () => void;
}) {
  const [showGrant, setShowGrant] = useState(false);
  const [selAgent, setSelAgent] = useState(0);
  const [selLevel, setSelLevel] = useState<"read" | "push" | "admin">("push");

  const grantMut = trpc.github.grantPermission.useMutation({
    onSuccess: () => { setShowGrant(false); onRefresh(); },
    onError: (e) => alert(e.message),
  });
  const revokeMut = trpc.github.revokePermission.useMutation({
    onSuccess: () => onRefresh(),
    onError: (e) => alert(e.message),
  });

  const permColors: Record<string, string> = {
    read: "var(--accent-cyan)",
    push: "var(--accent-gold)",
    admin: "var(--danger)",
  };

  return (
    <div className="glass-panel p-4 sci-border">
      <div className="flex items-center justify-between mb-3">
        <div className="text-[10px] font-mono uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
          权限管理 · PERMISSIONS
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onRefresh}
            className="text-[10px] font-mono px-2 py-1 rounded hover:bg-[rgba(180,200,255,0.05)]"
            style={{ color: "var(--text-muted)", border: "1px solid var(--border-default)" }}
          >
            <RefreshCw size={12} />
          </button>
          <button
            onClick={() => setShowGrant(true)}
            className="flex items-center gap-1 text-[10px] font-mono px-2 py-1 rounded"
            style={{ background: "var(--accent-cyan)", color: "#000" }}
          >
            <Plus size={12} /> 授权
          </button>
        </div>
      </div>

      {showGrant && (
        <div className="mb-3 p-3 rounded" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)" }}>
          <div className="flex gap-2 mb-2">
            <select
              value={selAgent}
              onChange={(e) => setSelAgent(Number(e.target.value))}
              className="flex-1 px-2 py-1.5 rounded text-xs font-mono outline-none"
              style={{ background: "rgba(0,0,0,0.2)", border: "1px solid var(--border-default)", color: "var(--text-primary)" }}
            >
              <option value={0}>选择 Agent</option>
              {agents.map((a: any) => (
                <option key={a.id} value={a.id}>{a.name || a.agentId}</option>
              ))}
            </select>
            <select
              value={selLevel}
              onChange={(e) => setSelLevel(e.target.value as any)}
              className="px-2 py-1.5 rounded text-xs font-mono outline-none"
              style={{ background: "rgba(0,0,0,0.2)", border: "1px solid var(--border-default)", color: "var(--text-primary)" }}
            >
              <option value="read">read</option>
              <option value="push">push</option>
              <option value="admin">admin</option>
            </select>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => { if (selAgent) grantMut.mutate({ agentId: selAgent, repoId, permissionLevel: selLevel }); }}
              disabled={!selAgent}
              className="px-3 py-1 rounded text-[10px] font-mono disabled:opacity-40"
              style={{ background: "var(--accent-cyan)", color: "#000" }}
            >
              授权
            </button>
            <button
              onClick={() => setShowGrant(false)}
              className="px-3 py-1 rounded text-[10px] font-mono"
              style={{ border: "1px solid var(--border-default)", color: "var(--text-muted)" }}
            >
              取消
            </button>
          </div>
        </div>
      )}

      {permissions.length === 0 ? (
        <div className="text-xs py-2" style={{ color: "var(--text-muted)" }}>
          暂无权限
        </div>
      ) : (
        <div className="space-y-1">
          {permissions.map((p: any) => {
            const agent = agents.find((a: any) => a.id === p.agentId);
            return (
              <div
                key={p.id}
                className="flex items-center justify-between gap-2 py-1.5 px-2 rounded text-[10px] font-mono"
                style={{ background: "rgba(255,255,255,0.01)", border: "1px solid rgba(255,255,255,0.03)" }}
              >
                <div className="flex items-center gap-2">
                  <Shield size={12} style={{ color: permColors[p.permissionLevel] }} />
                  <span style={{ color: "var(--text-primary)" }}>{agent?.name || `Agent #${p.agentId}`}</span>
                  <span
                    className="px-1.5 py-0.5 rounded text-[8px]"
                    style={{
                      background: `${permColors[p.permissionLevel]}15`,
                      color: permColors[p.permissionLevel],
                      border: `1px solid ${permColors[p.permissionLevel]}30`,
                    }}
                  >
                    {p.permissionLevel}
                  </span>
                </div>
                <button
                  onClick={() => revokeMut.mutate({ permId: p.id })}
                  className="p-1 rounded hover:bg-[rgba(255,255,255,0.05)]"
                  style={{ color: "var(--text-muted)" }}
                  title="撤销权限"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════
   子组件: PR Approval Queue
   ═══════════════════════════════════════════ */

function PRApprovalPanel({
  repoId,
  repos,
  agents,
  onRefresh,
}: {
  repoId: number;
  repos: any[];
  agents: any[];
  onRefresh: () => void;
}) {
  const [showRegister, setShowRegister] = useState(false);
  const [prNumber, setPrNumber] = useState("");
  const [prTitle, setPrTitle] = useState("");
  const [prBody, setPrBody] = useState("");
  const [registerAgentId, setRegisterAgentId] = useState<number>(0);
  const [selectedPR, setSelectedPR] = useState<number | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [showReject, setShowReject] = useState<number | null>(null);

  const prsQuery = trpc.github.listPRs.useQuery({ repoId, limit: 30 }, { retry: 1, staleTime: 5_000 });
  const prDetailQuery = trpc.github.getPR.useQuery(
    { prId: selectedPR ?? 0 },
    { retry: 1, staleTime: 5_000, enabled: !!selectedPR }
  );
  const registerMut = trpc.github.registerPR.useMutation({
    onSuccess: (data: any) => {
      if (data.success) {
        setShowRegister(false);
        setPrNumber("");
        setPrTitle("");
        setPrBody("");
        onRefresh();
        prsQuery.refetch();
      } else {
        alert(`注册失败: ${data.error ?? "未知错误"}${data.detail ? " - " + data.detail : ""}`);
      }
    },
    onError: (e) => alert(`错误: ${e.message}`),
  });
  const approveMut = trpc.github.approvePR.useMutation({
    onSuccess: (data: any) => {
      if (data.success) {
        const mergeMsg = data.mergeSkipped
          ? ` (GitHub 合并跳过: ${data.mergeSkippedReason ?? "配置未就绪"})`
          : " (已合并)";
        alert(`PR 已批准${mergeMsg}`);
        onRefresh();
        prsQuery.refetch();
        if (selectedPR) prDetailQuery.refetch();
      } else {
        alert(`批准失败: ${data.error ?? "未知错误"}`);
      }
    },
    onError: (e) => alert(`错误: ${e.message}`),
  });
  const rejectMut = trpc.github.rejectPR.useMutation({
    onSuccess: (data: any) => {
      if (data.success) {
        setShowReject(null);
        setRejectReason("");
        onRefresh();
        prsQuery.refetch();
        if (selectedPR) prDetailQuery.refetch();
      } else {
        alert(`拒绝失败: ${data.error ?? "未知错误"}`);
      }
    },
    onError: (e) => alert(`错误: ${e.message}`),
  });

  const prs = (prsQuery.data ?? []) as any[];
  const prDetail = prDetailQuery.data as any;
  const repo = repos.find((r: any) => r.id === repoId);
  const meizhiziAgent = agents.find((a: any) =>
    String(a.agentId ?? "").toLowerCase().includes("meizhizi") ||
    String(a.name ?? "").includes("美智子")
  );
  const effectiveRegisterAgentId = registerAgentId || meizhiziAgent?.id || 0;

  return (
    <div className="glass-panel p-4 sci-border">
      <div className="flex items-center justify-between mb-3">
        <div className="text-[10px] font-mono uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
          PR 审批队列 · APPROVAL QUEUE
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              prsQuery.refetch();
              if (selectedPR) prDetailQuery.refetch();
            }}
            className="text-[10px] font-mono px-2 py-1 rounded hover:bg-[rgba(180,200,255,0.05)]"
            style={{ color: "var(--text-muted)", border: "1px solid var(--border-default)" }}
          >
            <RefreshCw size={12} />
          </button>
          <button
            onClick={() => setShowRegister(true)}
            className="flex items-center gap-1 text-[10px] font-mono px-2 py-1 rounded"
            style={{ background: "var(--accent-gold)", color: "#000" }}
          >
            <Plus size={12} /> 注册 PR
          </button>
        </div>
      </div>

      {!repoId && (
        <div className="text-xs py-2" style={{ color: "var(--text-muted)" }}>
          请先选择一个仓库。
        </div>
      )}

      {showRegister && repoId > 0 && (
        <div className="mb-3 p-3 rounded" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)" }}>
          <div className="text-[10px] font-mono mb-2" style={{ color: "var(--text-muted)" }}>
            注册 GitHub PR 进入审批队列
          </div>
          <div className="space-y-2">
            <div>
              <label className="text-[9px] font-mono block mb-0.5" style={{ color: "var(--text-muted)" }}>提交助手</label>
              <select
                value={effectiveRegisterAgentId}
                onChange={(e) => setRegisterAgentId(Number(e.target.value))}
                className="w-full px-2 py-1.5 rounded text-xs font-mono outline-none"
                style={{ background: "rgba(0,0,0,0.2)", border: "1px solid var(--border-default)", color: "var(--text-primary)" }}
              >
                <option value={0}>选择提交助手</option>
                {agents.map((a: any) => (
                  <option key={a.id} value={a.id}>{a.name || a.agentId}</option>
                ))}
              </select>
              <div className="text-[9px] font-mono mt-1" style={{ color: "var(--text-muted)" }}>默认使用美智子；该助手必须有 push/admin 仓库权限。</div>
            </div>
            <div>
              <label className="text-[9px] font-mono block mb-0.5" style={{ color: "var(--text-muted)" }}>PR 编号</label>
              <input
                type="number"
                value={prNumber}
                onChange={(e) => setPrNumber(e.target.value)}
                placeholder="例: 42"
                className="w-full px-2 py-1.5 rounded text-xs font-mono outline-none"
                style={{ background: "rgba(0,0,0,0.2)", border: "1px solid var(--border-default)", color: "var(--text-primary)" }}
              />
            </div>
            <div>
              <label className="text-[9px] font-mono block mb-0.5" style={{ color: "var(--text-muted)" }}>标题</label>
              <input
                value={prTitle}
                onChange={(e) => setPrTitle(e.target.value)}
                placeholder="PR 标题"
                className="w-full px-2 py-1.5 rounded text-xs font-mono outline-none"
                style={{ background: "rgba(0,0,0,0.2)", border: "1px solid var(--border-default)", color: "var(--text-primary)" }}
              />
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => {
                  if (effectiveRegisterAgentId && prNumber && prTitle) {
                    registerMut.mutate({ agentId: effectiveRegisterAgentId, repoId, prNumber: parseInt(prNumber), title: prTitle, body: prBody || undefined });
                  }
                }}
                disabled={!effectiveRegisterAgentId || !prNumber || !prTitle || registerMut.isPending}
                className="px-3 py-1 rounded text-[10px] font-mono disabled:opacity-40"
                style={{ background: "var(--accent-gold)", color: "#000" }}
              >
                {registerMut.isPending ? "注册中..." : "注册"}
              </button>
              <button
                onClick={() => setShowRegister(false)}
                className="px-3 py-1 rounded text-[10px] font-mono"
                style={{ border: "1px solid var(--border-default)", color: "var(--text-muted)" }}
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {prsQuery.isLoading && (
        <div className="text-xs py-2" style={{ color: "var(--text-muted)" }}>加载中...</div>
      )}

      {!prsQuery.isLoading && prs.length === 0 && (
        <div className="text-xs py-2" style={{ color: "var(--text-muted)" }}>
          暂无 PR
        </div>
      )}

      {prs.length > 0 && (
        <div className="space-y-1 max-h-60 overflow-y-auto custom-scrollbar">
          {prs.map((pr: any) => (
            <div
              key={pr.id}
              className="flex items-center justify-between gap-2 py-2 px-2 rounded text-[10px] font-mono cursor-pointer"
              style={{
                background: selectedPR === pr.id ? "rgba(74,158,255,0.05)" : "rgba(255,255,255,0.01)",
                border: selectedPR === pr.id ? "1px solid rgba(74,158,255,0.2)" : "1px solid rgba(255,255,255,0.03)",
              }}
              onClick={() => setSelectedPR(pr.id)}
            >
              <div className="flex items-center gap-2 min-w-0">
                <span style={{ color: "var(--accent-cyan)" }}>#{pr.prNumber}</span>
                <span className="truncate max-w-32" style={{ color: "var(--text-primary)" }}>
                  {repo ? `${repo.owner}/${repo.name} ` : ""}{pr.title}
                </span>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                <StatusBadge value={pr.status} />
                {pr.status === "pending" && (
                  <>
                    <button
                      onClick={(e) => { e.stopPropagation(); approveMut.mutate({ prId: pr.id }); }}
                      className="p-1 rounded hover:bg-[rgba(0,255,0,0.1)]"
                      style={{ color: "var(--success)" }}
                      title="批准"
                    >
                      <CheckCircle2 size={14} />
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); setShowReject(pr.id); setRejectReason(""); }}
                      className="p-1 rounded hover:bg-[rgba(255,0,0,0.1)]"
                      style={{ color: "var(--danger)" }}
                      title="拒绝"
                    >
                      <XCircle size={14} />
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {showReject !== null && (
        <div className="mt-2 p-3 rounded" style={{ background: "rgba(255,0,0,0.03)", border: "1px solid rgba(255,0,0,0.1)" }}>
          <div className="text-[10px] font-mono mb-2" style={{ color: "var(--danger)" }}>拒绝原因（可选）</div>
          <input
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            placeholder="填写拒绝原因..."
            className="w-full px-2 py-1.5 rounded text-xs font-mono outline-none mb-2"
            style={{ background: "rgba(0,0,0,0.2)", border: "1px solid var(--border-default)", color: "var(--text-primary)" }}
          />
          <div className="flex gap-2">
            <button
              onClick={() => rejectMut.mutate({ prId: showReject, reason: rejectReason || undefined })}
              className="px-3 py-1 rounded text-[10px] font-mono"
              style={{ background: "var(--danger)", color: "#fff" }}
            >
              确认拒绝
            </button>
            <button
              onClick={() => setShowReject(null)}
              className="px-3 py-1 rounded text-[10px] font-mono"
              style={{ border: "1px solid var(--border-default)", color: "var(--text-muted)" }}
            >
              取消
            </button>
          </div>
        </div>
      )}

      {prDetail && (
        <div className="mt-3 p-3 rounded" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)" }}>
          <div className="text-[10px] font-mono mb-2" style={{ color: "var(--text-muted)" }}>PR 详情</div>
          <div className="space-y-1 text-[10px] font-mono">
            <div style={{ color: "var(--text-primary)" }}>标题: {prDetail.title}</div>
            {prDetail.branchName && (
              <div style={{ color: "var(--text-secondary)" }}>
                分支: {prDetail.branchName} → {prDetail.baseBranch || "main"}
              </div>
            )}
            {prDetail.headSha && (
              <div style={{ color: "var(--text-muted)" }}>SHA: {prDetail.headSha.slice(0, 12)}</div>
            )}
            <div className="flex items-center gap-2">
              <StatusBadge value={prDetail.status} />
              {prDetail.approvedAt && (
                <span style={{ color: "var(--text-muted)" }}>批准: {fmtDateTime(prDetail.approvedAt)}</span>
              )}
              {prDetail.mergedAt && (
                <span style={{ color: "var(--accent-cyan)" }}>合并: {fmtDateTime(prDetail.mergedAt)}</span>
              )}
            </div>
          </div>

          {prDetail.auditLog && prDetail.auditLog.length > 0 && (
            <div className="mt-2">
              <div className="text-[9px] font-mono mb-1" style={{ color: "var(--text-muted)" }}>审批记录</div>
              <div className="space-y-0.5">
                {prDetail.auditLog.map((a: any) => {
                  const agent = agents.find((ag: any) => ag.id === a.agentId);
                  const actionColors: Record<string, string> = {
                    register: "var(--accent-cyan)",
                    approve: "var(--success)",
                    reject: "var(--danger)",
                    merge: "var(--accent-cyan)",
                    revoke: "var(--accent-gold)",
                  };
                  return (
                    <div key={a.id} className="flex items-center gap-2 text-[9px] font-mono">
                      <span style={{ color: actionColors[a.action] || "var(--text-muted)" }}>
                        {a.action}
                      </span>
                      <span style={{ color: "var(--text-muted)" }}>
                        {agent?.name || "Agent"}#{a.agentId}
                      </span>
                      <span style={{ color: "var(--text-muted)" }}>
                        {fmtDateTime(a.createdAt)}
                      </span>
                      {a.reason && (
                        <span className="truncate max-w-32" style={{ color: "var(--text-secondary)" }}>
                          — {a.reason}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════
   主页面
   ═══════════════════════════════════════════ */

export default function GitHubPanel() {
  const [selectedRepoId, setSelectedRepoId] = useState<number>(0);

  const statusQuery = trpc.github.status.useQuery(undefined, { retry: 1, staleTime: 10_000 });
  const bootstrapMut = trpc.github.bootstrapDefault.useMutation({
    onSuccess: (data: any) => {
      if (data.success) {
        handleRefresh();
        if (data.repo?.id) setSelectedRepoId(data.repo.id);
        alert(`已初始化 ${data.repo?.fullName ?? "tiangong"}，授权给 ${data.agent?.name ?? "美智子"}`);
      } else {
        alert(`初始化失败: ${data.error ?? "未知错误"}`);
      }
    },
    onError: (e) => alert(`初始化失败: ${e.message}`),
  });
  const listReposQuery = trpc.github.listRepos.useQuery(undefined, { retry: 1, staleTime: 10_000 });
  const listAgentsQuery = trpc.github.listAgents.useQuery(undefined, { retry: 1, staleTime: 10_000 });
  const listPermsQuery = trpc.github.listPermissions.useQuery(
    { repoId: selectedRepoId || undefined },
    { retry: 1, staleTime: 5_000, enabled: !!selectedRepoId }
  );

  const status = statusQuery.data as any;
  const readiness = status?.readiness;
  const repos = (listReposQuery.data ?? []) as any[];
  const agents = (listAgentsQuery.data ?? []) as any[];
  const permissions = (listPermsQuery.data ?? []) as any[];

  const handleRefresh = () => {
    statusQuery.refetch();
    listReposQuery.refetch();
    listAgentsQuery.refetch();
    if (selectedRepoId) listPermsQuery.refetch();
  };

  return (
    <div className="min-h-screen" style={{ background: "var(--bg-primary)" }}>
      <div className="max-w-6xl mx-auto px-4 sm:px-6 pt-24 pb-16">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-black tracking-wider" style={{ color: "var(--text-primary)" }}>
              GitHub 集成
            </h1>
            <p className="text-[10px] font-mono mt-1" style={{ color: "var(--text-muted)" }}>
              GitHub App · PR 审批 · 权限管理
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => bootstrapMut.mutate()}
              disabled={bootstrapMut.isPending}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded font-mono disabled:opacity-50"
              style={{ background: "var(--accent-gold)", color: "#000" }}
            >
              <Shield size={14} /> {bootstrapMut.isPending ? "初始化中" : "初始化天宫权限"}
            </button>
            <button
              onClick={handleRefresh}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded font-mono hover:bg-[rgba(180,200,255,0.05)] transition-colors"
              style={{ color: "var(--text-muted)", border: "1px solid var(--border-default)" }}
            >
              <RefreshCw size={14} /> 刷新
            </button>
          </div>
        </div>

        <div className="mb-4">
          <ReadinessPanel readiness={readiness} onRefresh={handleRefresh} />
        </div>

        {repos.length > 0 && (
          <div className="flex items-center gap-2 mb-4 flex-wrap">
            <span className="text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>选择仓库:</span>
            {repos.map((r: any) => (
              <button
                key={r.id}
                onClick={() => setSelectedRepoId(r.id)}
                className="px-2 py-1 rounded text-[10px] font-mono transition-colors"
                style={{
                  background: selectedRepoId === r.id ? "rgba(74,158,255,0.1)" : "rgba(255,255,255,0.02)",
                  color: selectedRepoId === r.id ? "var(--accent-cyan)" : "var(--text-muted)",
                  border: selectedRepoId === r.id ? "1px solid rgba(74,158,255,0.25)" : "1px solid rgba(255,255,255,0.05)",
                }}
              >
                <GitBranch size={10} className="inline mr-1" />
                {r.fullName}
              </button>
            ))}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-4">
          <div className="lg:col-span-1 space-y-4">
            <RepoPanel repos={repos} onRefresh={handleRefresh} />
            {selectedRepoId > 0 && (
              <PermissionPanel
                repoId={selectedRepoId}
                permissions={permissions}
                agents={agents}
                onRefresh={handleRefresh}
              />
            )}
          </div>
          <div className="lg:col-span-2">
            <PRApprovalPanel
              repoId={selectedRepoId}
              repos={repos}
              agents={agents}
              onRefresh={handleRefresh}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
