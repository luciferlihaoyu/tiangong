import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useNavigate } from "react-router";
import { useDataSource, type MockAgent, type MockOrg } from "@/hooks/useDataSource";
import { useDashboardStats } from "@/hooks/useDashboardStats";
import { useAuth } from "@/hooks/useAuth";
import { useWebSocket, type WSMessage } from "@/hooks/useWebSocket";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import McpPanel from "./McpPanel";

/* ═══════════════════════════════════════════
   辅助组件
   ═══════════════════════════════════════════ */

function RingText3D({ text, radius = 100 }: { text: string; radius?: number }) {
  const chars = text.split('');
  const angleStep = 360 / chars.length;
  return (
    <div className="ring-scene w-[200px] h-[200px] flex items-center justify-center">
      <div className="ring-container w-0 h-0">
        {chars.map((char, i) => (
          <span key={i} className="ring-char"
            style={{ transform: `rotateY(${i * angleStep}deg) translateZ(${radius}px)` }}>{char}</span>
        ))}
      </div>
    </div>
  );
}

function LiveClock() {
  const [time, setTime] = useState(new Date());
  useEffect(() => { const t = setInterval(() => setTime(new Date()), 1000); return () => clearInterval(t); }, []);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return (
    <div className="glass-panel p-4 sci-border">
      <div className="section-label mb-2">系统时间 · SYS_TIME</div>
      <div className="font-mono text-2xl font-bold tracking-wider" style={{ color: 'var(--accent-gold)' }}>
        {pad(time.getHours())}:{pad(time.getMinutes())}:{pad(time.getSeconds())}
      </div>
      <div className="text-xs mt-1 font-mono" style={{ color: 'var(--text-muted)' }}>{time.getFullYear()}.{pad(time.getMonth() + 1)}.{pad(time.getDate())}</div>
    </div>
  );
}

function SystemMonitor() {
  const [m, setM] = useState({ cpu: 42, ram: 68, net: 12 });
  useEffect(() => { const t = setInterval(() => setM({ cpu: 30 + Math.floor(Math.random() * 40), ram: 60 + Math.floor(Math.random() * 25), net: 5 + Math.floor(Math.random() * 20) }), 3000); return () => clearInterval(t); }, []);
  const bars = [
    { label: 'CPU', value: m.cpu, color: 'var(--accent-red)' },
    { label: 'RAM', value: m.ram, color: 'var(--accent-gold)' },
    { label: 'NET', value: m.net, color: 'var(--accent-cyan)' },
  ];
  return (
    <div className="glass-panel p-4 sci-border">
      <div className="section-label mb-3">系统资源 · SYS_RES</div>
      <div className="flex flex-col gap-3">
        {bars.map(b => (
          <div key={b.label}>
            <div className="flex justify-between text-xs mb-1">
              <span className="font-mono" style={{ color: 'var(--text-secondary)' }}>{b.label}</span>
              <span className="font-mono" style={{ color: b.color }}>{b.value}%</span>
            </div>
            <div className="progress-track"><div className="progress-fill transition-all duration-700" style={{ width: `${b.value}%`, background: b.color }} /></div>
          </div>
        ))}
      </div>
    </div>
  );
}

const statusCfg: Record<string, { dot: string; color: string; label: string }> = {
  online: { dot: 'status-dot-online', color: 'var(--success)', label: '在线' },
  busy: { dot: 'status-dot-busy', color: 'var(--accent-red)', label: '忙碌' },
  idle: { dot: 'status-dot-idle', color: 'var(--text-muted)', label: '空闲' },
};

function AgentCard({ agent, onStatusChange, onEdit, onDelete, onNavigateToMcp }: {
  agent: MockAgent;
  onStatusChange: (id: number, s: string) => void;
  onEdit: (a: MockAgent) => void; onDelete: (id: number) => void;
  onNavigateToMcp?: () => void;
}) {
  const c = statusCfg[agent.status] || statusCfg.idle;
  const caps = useMemo(() => { try { return agent.capabilities ? JSON.parse(agent.capabilities) as string[] : []; } catch { return []; } }, [agent.capabilities]);

  return (
    <div className="glass-panel p-4 sci-border transition-all group relative hover:border-[var(--accent-gold)]/30">
      <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity z-10">
        <button onClick={() => onEdit(agent)} className="text-[10px] px-1.5 py-0.5 rounded hover:bg-[rgba(100,181,246,0.1)]" style={{ color: 'var(--accent-cyan)' }}>编辑</button>
        <button onClick={() => onDelete(agent.id)} className="text-[10px] px-1.5 py-0.5 rounded hover:bg-[var(--accent-glow-red)]" style={{ color: 'var(--accent-red)' }}>删除</button>
      </div>
      <div className="flex items-center justify-between mb-3 pr-16">
        <div className="flex items-center gap-2">
          <span className={`status-dot ${c.dot}`} />
          <span className="text-sm font-bold tracking-wide" style={{ color: 'var(--text-primary)' }}>{agent.name}</span>
        </div>
        <span className="font-mono text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'var(--accent-glow-gold)', color: 'var(--accent-gold)' }}>{agent.agentId}</span>
      </div>
      {/* Source / Model / Role badges */}
      <div className="flex flex-wrap gap-1 mb-2">
        {agent.source && <span className="text-[10px] px-1.5 py-0.5 rounded font-mono" style={{ background: 'rgba(100,181,246,0.1)', color: 'var(--accent-cyan)' }}>{agent.source}</span>}
        {agent.model && <span className="text-[10px] px-1.5 py-0.5 rounded font-mono truncate max-w-[120px]" style={{ background: 'rgba(201,168,76,0.1)', color: 'var(--accent-gold)' }}>{agent.model.split('/').pop()}</span>}
        {agent.role && <span className="text-[10px] px-1.5 py-0.5 rounded font-mono" style={{ background: 'var(--accent-glow-red)', color: 'var(--accent-red-bright)' }}>{agent.role}</span>}
        <button onClick={e => { e.stopPropagation(); const o = ['idle', 'online', 'busy']; onStatusChange(agent.id, o[(o.indexOf(agent.status) + 1) % o.length]); }} className="text-[10px] px-1.5 py-0.5 rounded font-mono" style={{ background: 'var(--accent-glow-gold)', color: c.color }}>{c.label}</button>
      </div>
      {/* Capabilities */}
      {caps.length > 0 && (
        <div className="flex flex-wrap gap-0.5 mb-2">
          {caps.map((cap: string) => (
            <span key={cap} className="text-[9px] px-1 py-0 rounded font-mono" style={{ background: 'rgba(255,255,255,0.03)', color: 'var(--text-muted)' }}>{cap}</span>
          ))}
        </div>
      )}
      <div className="text-xs mb-2 truncate" style={{ color: 'var(--text-secondary)' }}>{agent.currentTask || agent.task || '等待任务'}</div>
      {agent.budgetCents !== undefined && agent.budgetCents > 0 && (
        <div className="text-[10px] font-mono mb-1" style={{ color: 'var(--text-muted)' }}>
          预算: ¥{(agent.budgetCents / 100).toFixed(0)} | 消耗: ¥{((agent.spentCents || 0) / 100).toFixed(0)}
        </div>
      )}
      {agent.lastHeartbeat && (
        <div className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>
          💓 {new Date(agent.lastHeartbeat).toLocaleTimeString()}
        </div>
      )}
      {/* 连接状态: 10分钟内有心跳=已连接, 有MCP Key无心跳=待接入 */}
      <div className="flex items-center gap-1 mt-1">
        {agent.lastHeartbeat && (Date.now() - new Date(agent.lastHeartbeat).getTime()) < 600000 ? (
          <span className="text-[10px] font-mono" style={{ color: 'var(--success)' }}>🟢 已连接</span>
        ) : agent.sourceApiKey ? (
          <span className="text-[10px] font-mono cursor-pointer hover:underline" style={{ color: 'var(--accent-gold)' }}
            onClick={(e) => { e.stopPropagation(); onNavigateToMcp?.(); }}>
            🟡 待接入
          </span>
        ) : (
          <span className="text-[10px] font-mono cursor-pointer hover:underline" style={{ color: 'var(--text-muted)' }}
            onClick={(e) => { e.stopPropagation(); onNavigateToMcp?.(); }}>
            ⚪ 未连接
          </span>
        )}
      </div>
      {agent.progress > 0 && <div className="progress-track mt-2"><div className="progress-fill" style={{ width: `${agent.progress}%` }} /></div>}
    </div>
  );
}

/* ═══════════════════════════════════════════
   组织架构 Tab
   ═══════════════════════════════════════════ */

function OrgTab() {
  const treeQuery = (window as any).__trpc ? null : null; // will use existing data
  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <OrgTreePanel />
      <div className="lg:col-span-2 flex flex-col gap-4">
        <DeptDetailPanel />
        <AgentAssignPanel />
      </div>
    </div>
  );
}

function OrgTreePanel() {
  const data = useDataSource();
  const orgs = data.orgs;
  const agents = data.agents as MockAgent[];

  // We build org hierarchy from agents' orgId and reportsTo
  const hierarchy = useMemo(() => {
    const roots = agents.filter(a => !a.reportsTo);
    const children = new Map<number, MockAgent[]>();
    for (const a of agents) {
      if (a.reportsTo) {
        const list = children.get(a.reportsTo) || [];
        list.push(a);
        children.set(a.reportsTo, list);
      }
    }
    return { roots, children };
  }, [agents]);

  const renderNode = (agent: MockAgent, depth: number = 0) => {
    const kids = hierarchy.children.get(agent.id) || [];
    return (
      <div key={agent.id} className="ml-4">
        <div className="flex items-center gap-2 py-1.5 px-2 rounded hover:bg-[rgba(180,200,255,0.03)] transition-colors" style={{ marginLeft: `${depth * 16}px` }}>
          <span className="w-2 h-2 rounded-full" style={{ background: statusCfg[agent.status]?.color || 'var(--text-muted)' }} />
          <span className="text-xs font-bold" style={{ color: 'var(--text-primary)' }}>{agent.name}</span>
          <span className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>{agent.role || agent.agentId}</span>
        </div>
        {kids.map(k => renderNode(k, depth + 1))}
      </div>
    );
  };

  return (
    <div className="glass-panel p-4 sci-border">
      <div className="section-label mb-3">组织架构 · ORG_HIERARCHY</div>
      {orgs.length === 0 ? (
        <div className="text-xs font-mono text-center py-4" style={{ color: 'var(--text-muted)' }}>暂无组织数据</div>
      ) : (
        <div className="flex flex-col gap-4">
          {orgs.map(org => (
            <div key={org.id}>
              <div className="flex items-center gap-2 mb-2">
                <span className="text-sm font-bold" style={{ color: 'var(--accent-gold)' }}>🏢 {org.name}</span>
                <span className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>{org.description}</span>
              </div>
              <div className="border-l pl-2" style={{ borderColor: 'var(--border-default)' }}>
                {hierarchy.roots.filter(r => r.orgId === org.id || !r.orgId).map(r => renderNode(r))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DeptDetailPanel() {
  return (
    <div className="glass-panel p-4 sci-border">
      <div className="section-label mb-3">部门概览 · DEPARTMENTS</div>
      <div className="text-xs font-mono text-center py-8" style={{ color: 'var(--text-muted)' }}>
        💡 请先部署后端并运行 `npm run db:seed` 以获取部门数据<br/>
        部门管理功能将通过 tRPC org 路由提供
      </div>
    </div>
  );
}

function AgentAssignPanel() {
  return (
    <div className="glass-panel p-4 sci-border">
      <div className="section-label mb-3">Agent 分配 · ASSIGN</div>
      <div className="text-xs font-mono text-center py-4" style={{ color: 'var(--text-muted)' }}>
        💡 部门分配功能：拖拽 Agent 到部门 / 通过 tRPC org.deptAssignAgent
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════
   任务编排 Tab — DAG 可视化
   ═══════════════════════════════════════════ */

function OrchTab() {
  const data = useDataSource();
  const tasks = data.tasks;
  const agents = data.agents as MockAgent[];

  // Build simple DAG from parentTaskId
  const dagNodes = useMemo(() => {
    return tasks.map(t => ({
      ...t,
      agentName: agents.find(a => a.id === t.agentId)?.name || null,
    }));
  }, [tasks, agents]);

  // Compute layers via BFS
  const layers = useMemo(() => {
    const parentMap = new Map<number, number[]>(); // parent -> children
    const hasParent = new Set<number>();
    for (const t of tasks) {
      if (t.parentTaskId) {
        const kids = parentMap.get(t.parentTaskId) || [];
        kids.push(t.id);
        parentMap.set(t.parentTaskId, kids);
        hasParent.add(t.id);
      }
    }
    // Find roots
    const queue: { id: number; layer: number }[] = [];
    const layermap = new Map<number, number>();
    for (const t of tasks) {
      if (!hasParent.has(t.id)) {
        queue.push({ id: t.id, layer: 0 });
        layermap.set(t.id, 0);
      }
    }
    while (queue.length > 0) {
      const { id, layer } = queue.shift()!;
      const kids = parentMap.get(id) || [];
      for (const kid of kids) {
        if (!layermap.has(kid) || layermap.get(kid)! < layer + 1) {
          layermap.set(kid, layer + 1);
          queue.push({ id: kid, layer: layer + 1 });
        }
      }
    }
    return layermap;
  }, [tasks]);

  const maxLayer = Math.max(0, ...layers.values());

  const statusColor: Record<string, string> = {
    pending: 'var(--text-muted)',
    queued: 'var(--accent-cyan)',
    running: 'var(--accent-gold)',
    done: 'var(--success)',
    failed: 'var(--accent-red)',
  };

  return (
    <div className="flex flex-col gap-4">
      {/* DAG Visual */}
      <div className="glass-panel p-4 sci-border overflow-x-auto">
        <div className="section-label mb-4">任务编排 DAG · TASK_DAG</div>
        {dagNodes.length === 0 ? (
          <div className="text-xs font-mono text-center py-8" style={{ color: 'var(--text-muted)' }}>暂无任务数据</div>
        ) : (
          <div className="relative" style={{ minHeight: `${(maxLayer + 1) * 100}px` }}>
            {Array.from({ length: maxLayer + 1 }).map((_, layer) => {
              const layerNodes = dagNodes.filter(n => layers.get(n.id) === layer);
              return (
                <div key={layer} className="flex justify-center gap-4 mb-4" style={{ position: 'relative', top: `${layer * 100}px` }}>
                  {layerNodes.map(node => (
                    <div key={node.id} className="flex flex-col items-center">
                      {/* Arrow from parents */}
                      {node.parentTaskId && (
                        <svg className="absolute" style={{ width: '100%', height: '40px', top: '-40px', left: 0, pointerEvents: 'none' }}>
                          <line x1="50%" y1="40" x2="50%" y2="0" stroke="var(--border-default)" strokeWidth="1" strokeDasharray="4 2" />
                        </svg>
                      )}
                      <div className="p-2 rounded text-center min-w-[100px] transition-all cursor-pointer"
                        style={{
                          background: 'var(--bg-card)',
                          border: `1px solid ${statusColor[node.status] || 'var(--border-default)'}`,
                          boxShadow: `0 0 8px ${statusColor[node.status] || 'rgba(255,255,255,0.02)'}`,
                        }}>
                        <div className="font-mono text-[10px]" style={{ color: 'var(--accent-gold)' }}>{node.taskId}</div>
                        <div className="text-xs mt-1 truncate max-w-[90px]" style={{ color: 'var(--text-primary)' }}>{node.name}</div>
                        <div className="flex items-center gap-1 mt-1 justify-center">
                          <span className="w-1.5 h-1.5 rounded-full" style={{ background: statusColor[node.status] }} />
                          <span className="text-[10px] font-mono" style={{ color: statusColor[node.status] }}>{node.status}</span>
                        </div>
                        {node.agentName && <div className="text-[9px] font-mono mt-1" style={{ color: 'var(--text-muted)' }}>@{node.agentName}</div>}
                      </div>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Task Table */}
      <div className="glass-panel p-4 sci-border">
        <div className="section-label mb-3">任务列表 · ALL TASKS</div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-default)' }}>
                {['ID', '名称', '状态', '进度', 'Agent', '优先级', '重试'].map(h => (
                  <th key={h} className="text-left py-1.5 px-2 font-mono" style={{ color: 'var(--text-muted)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {dagNodes.map(t => (
                <tr key={t.id} className="hover:bg-[rgba(180,200,255,0.02)]" style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                  <td className="py-1.5 px-2 font-mono" style={{ color: 'var(--accent-gold)' }}>{t.taskId}</td>
                  <td className="py-1.5 px-2" style={{ color: 'var(--text-secondary)' }}>{t.name}</td>
                  <td className="py-1.5 px-2"><span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full" style={{ background: statusColor[t.status] }} /><span style={{ color: statusColor[t.status] }}>{t.status}</span></span></td>
                  <td className="py-1.5 px-2 font-mono" style={{ color: 'var(--text-muted)' }}>{t.progress}%</td>
                  <td className="py-1.5 px-2" style={{ color: 'var(--text-secondary)' }}>{t.agentName || '-'}</td>
                  <td className="py-1.5 px-2 font-mono" style={{ color: 'var(--text-muted)' }}>{t.priority || 0}</td>
                  <td className="py-1.5 px-2 font-mono" style={{ color: 'var(--text-muted)' }}>{t.retryCount || 0}/{t.maxRetries || 3}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════
   连接面板
   ═══════════════════════════════════════════ */

function ConnectionPanel({ systems, onStatusChange }: {
  systems: { id: number; name: string; slug: string; status: string }[];
  onStatusChange: (id: number, s: string) => void;
}) {
  const sc: Record<string, string> = { connected: 'var(--success)', syncing: 'var(--accent-gold)', disconnected: 'var(--text-muted)' };
  const st: Record<string, string> = { connected: '已连接', syncing: '同步中', disconnected: '断开' };
  return (
    <div className="glass-panel p-4 sci-border">
      <div className="section-label mb-3">系统接入 · SYS_CONN</div>
      <div className="flex flex-col gap-2">
        {systems.map(s => (
          <div key={s.id} className="flex items-center justify-between py-1 group">
            <div className="flex items-center gap-2">
              <span className="w-5 h-5 rounded-sm flex items-center justify-center text-[10px] font-bold"
                style={{ background: 'var(--accent-glow-red)', color: 'var(--accent-red)' }}>{s.name[0]}</span>
              <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>{s.name}</span>
            </div>
            <button onClick={() => { const o = ['disconnected', 'syncing', 'connected']; onStatusChange(s.id, o[(o.indexOf(s.status) + 1) % o.length]); }}
              className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: sc[s.status] }} />
              <span className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>{st[s.status]}</span>
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════
   统计行
   ═══════════════════════════════════════════ */

function StatsRow({ agents, tasks, totalMsgs, orgs, todayCostCents }: {
  agents: MockAgent[]; tasks: { status: string }[]; totalMsgs: number; orgs: number; todayCostCents?: number;
}) {
  const onlineCount = agents.filter(a => a.status === 'online' || a.status === 'busy').length;
  const doneCount = tasks.filter(t => t.status === 'done').length;
  const failedCount = tasks.filter(t => t.status === 'failed').length;
  const todayTasks = tasks.filter(t => {
    const updated = (t as any).updatedAt || (t as any).createdAt;
    if (!updated) return false;
    const d = new Date(updated);
    const now = new Date();
    return d.toDateString() === now.toDateString();
  }).length;
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-5 gap-3">
      {[
        { label: '活跃 Agent', value: String(onlineCount), sub: `${agents.length} 个总计` },
        { label: '今日任务', value: String(todayTasks || tasks.length), sub: `完成 ${doneCount}` },
        { label: '今日成本', value: todayCostCents !== undefined ? `¥${(todayCostCents / 100).toFixed(2)}` : '—', sub: '元' },
        { label: '消息总量', value: totalMsgs >= 1000 ? `${(totalMsgs / 1000).toFixed(1)}K` : String(totalMsgs), sub: '实时同步' },
        { label: '组织', value: String(orgs), sub: '个公司' },
      ].map(s => (
        <div key={s.label} className="glass-panel p-3 sci-border">
          <div className="text-[10px] mb-1 font-mono" style={{ color: 'var(--text-muted)' }}>{s.label}</div>
          <div className="font-mono text-lg font-bold" style={{ color: 'var(--accent-gold)' }}>{s.value}</div>
          <div className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>{s.sub}</div>
        </div>
      ))}
    </div>
  );
}

/* ═══════════════════════════════════════════
   表单组件
   ═══════════════════════════════════════════ */

function AgentForm({ agent, onSubmit, onCancel }: { agent?: MockAgent; onSubmit: (v: Record<string, string>) => void; onCancel: () => void }) {
  const [name, setName] = useState(agent?.name || '');
  const [source, setSource] = useState(agent?.source || 'custom');
  const [model, setModel] = useState(agent?.model || '');
  const [role, setRole] = useState(agent?.role || '');
  const [description, setDescription] = useState(agent?.description || '');
  const [capabilities, setCapabilities] = useState(agent?.capabilities || '');
  return (
    <form onSubmit={e => { e.preventDefault(); onSubmit({ name, system: source, source, model, role, description, capabilities }); }} className="flex flex-col gap-3 mt-2">
      <div><Label className="text-[10px] font-mono mb-1 block" style={{ color: 'var(--text-muted)' }}>名称 · NAME</Label>
        <Input value={name} onChange={e => setName(e.target.value)} placeholder="如: 美智子" required
          style={{ background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }} /></div>
      <div className="grid grid-cols-3 gap-2">
        <div><Label className="text-[10px] font-mono mb-1 block" style={{ color: 'var(--text-muted)' }}>来源 · SOURCE</Label>
          <select value={source} onChange={e => setSource(e.target.value)} className="w-full px-2 py-1.5 rounded text-xs"
            style={{ background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}>
            <option value="openclaw">OpenClaw</option><option value="dify">Dify</option><option value="custom">Custom</option>
          </select></div>
        <div><Label className="text-[10px] font-mono mb-1 block" style={{ color: 'var(--text-muted)' }}>模型 · MODEL</Label>
          <Input value={model} onChange={e => setModel(e.target.value)} placeholder="deepseek-v4-pro"
            style={{ background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }} /></div>
        <div><Label className="text-[10px] font-mono mb-1 block" style={{ color: 'var(--text-muted)' }}>角色 · ROLE</Label>
          <Input value={role} onChange={e => setRole(e.target.value)} placeholder="如: CTO"
            style={{ background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }} /></div>
      </div>
      <div><Label className="text-[10px] font-mono mb-1 block" style={{ color: 'var(--text-muted)' }}>描述 · DESCRIPTION</Label>
        <Input value={description} onChange={e => setDescription(e.target.value)} placeholder="Agent 职责描述"
          style={{ background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }} /></div>
      <div><Label className="text-[10px] font-mono mb-1 block" style={{ color: 'var(--text-muted)' }}>能力 · CAPABILITIES (逗号分隔)</Label>
        <Input value={capabilities} onChange={e => setCapabilities(e.target.value)} placeholder="code, review, debug"
          style={{ background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }} /></div>
      <div className="flex gap-2 mt-2">
        <Button type="submit" className="flex-1 text-xs font-bold" style={{ background: 'var(--accent-red)', color: '#fff' }}>{agent ? '保存修改' : '创建 Agent'}</Button>
        <Button type="button" onClick={onCancel} className="text-xs" variant="outline" style={{ border: '1px solid var(--border-default)', color: 'var(--text-muted)' }}>取消</Button>
      </div>
    </form>
  );
}

function TaskForm({ agents, onSubmit, onCancel }: { agents: MockAgent[]; onSubmit: (v: Record<string, string>) => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [agentId, setAgentId] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState('0');
  return (
    <form onSubmit={e => { e.preventDefault(); onSubmit({ name, agentId, description, priority }); }} className="flex flex-col gap-3 mt-2">
      <div><Label className="text-[10px] font-mono mb-1 block" style={{ color: 'var(--text-muted)' }}>任务名称 · NAME</Label>
        <Input value={name} onChange={e => setName(e.target.value)} placeholder="如: 数据清洗" required
          style={{ background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }} /></div>
      <div className="grid grid-cols-2 gap-2">
        <div><Label className="text-[10px] font-mono mb-1 block" style={{ color: 'var(--text-muted)' }}>分配 Agent · ASSIGN</Label>
          <select value={agentId} onChange={e => setAgentId(e.target.value)} className="w-full px-2 py-1.5 rounded text-xs"
            style={{ background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}>
            <option value="">不分配</option>
            {agents.map(a => <option key={a.id} value={String(a.id)}>{a.name} ({a.source})</option>)}
          </select></div>
        <div><Label className="text-[10px] font-mono mb-1 block" style={{ color: 'var(--text-muted)' }}>优先级 · PRIORITY</Label>
          <Input value={priority} onChange={e => setPriority(e.target.value)} type="number" min="0" max="100"
            style={{ background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }} /></div>
      </div>
      <div><Label className="text-[10px] font-mono mb-1 block" style={{ color: 'var(--text-muted)' }}>描述 · DESCRIPTION</Label>
        <Input value={description} onChange={e => setDescription(e.target.value)} placeholder="任务描述"
          style={{ background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }} /></div>
      <div className="flex gap-2 mt-2">
        <Button type="submit" className="flex-1 text-xs font-bold" style={{ background: 'var(--accent-gold)', color: '#000' }}>创建任务</Button>
        <Button type="button" onClick={onCancel} className="text-xs" variant="outline" style={{ border: '1px solid var(--border-default)', color: 'var(--text-muted)' }}>取消</Button>
      </div>
    </form>
  );
}

function OrgForm({ onSubmit, onCancel }: { onSubmit: (v: Record<string, string>) => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  return (
    <form onSubmit={e => { e.preventDefault(); onSubmit({ name, description }); }} className="flex flex-col gap-3 mt-2">
      <div><Label className="text-[10px] font-mono mb-1 block" style={{ color: 'var(--text-muted)' }}>组织名称 · NAME</Label>
        <Input value={name} onChange={e => setName(e.target.value)} placeholder="如: 天宫科技" required
          style={{ background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }} /></div>
      <div><Label className="text-[10px] font-mono mb-1 block" style={{ color: 'var(--text-muted)' }}>描述 · DESCRIPTION</Label>
        <Input value={description} onChange={e => setDescription(e.target.value)} placeholder="组织描述"
          style={{ background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }} /></div>
      <div className="flex gap-2 mt-2">
        <Button type="submit" className="flex-1 text-xs font-bold" style={{ background: 'var(--accent-cyan)', color: '#fff' }}>创建组织</Button>
        <Button type="button" onClick={onCancel} className="text-xs" variant="outline" style={{ border: '1px solid var(--border-default)', color: 'var(--text-muted)' }}>取消</Button>
      </div>
    </form>
  );
}

/* ═══════════════════════════════════════════
   消息面板组件
   ═══════════════════════════════════════════ */

interface DisplayMessage {
  id: number;
  fromAgent: number;
  toAgent: number;
  content: string;
  type: string;
  status: string;
  createdAt: string;
  readAt?: string | null;
}

function MessagePanel({
  agents,
  lastWsMessage,
  wsConnected,
}: {
  agents: MockAgent[];
  lastWsMessage: WSMessage | null;
  wsConnected: boolean;
}) {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<number | null>(null);
  const [sendContent, setSendContent] = useState("");
  const [conversationMsgs, setConversationMsgs] = useState<DisplayMessage[]>([]);
  const [loadingConv, setLoadingConv] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const agentMap = useMemo(() => {
    const m = new Map<number, MockAgent>();
    for (const a of agents) m.set(a.id, a);
    return m;
  }, [agents]);

  // Fetch recent messages on mount
  useEffect(() => {
    fetch("/api/trpc/message.list")
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data)) {
          setMessages(data.slice(0, 50).reverse());
        } else if (Array.isArray(data?.result?.data)) {
          setMessages(data.result.data.slice(0, 50).reverse());
        }
      })
      .catch(() => {});
  }, []);

  // Listen for new messages from WebSocket
  useEffect(() => {
    if (!lastWsMessage) return;
    if (lastWsMessage.type === "new_message" && lastWsMessage.message) {
      const msg = lastWsMessage.message as DisplayMessage;
      setMessages((prev) => {
        // Avoid duplicates
        if (prev.some((m) => m.id === msg.id)) return prev;
        return [...prev, msg].slice(-100);
      });
    }
    if (lastWsMessage.type === "message_read" && lastWsMessage.messageId) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === lastWsMessage.messageId ? { ...m, status: "read", readAt: new Date().toISOString() } : m
        )
      );
    }
  }, [lastWsMessage]);

  // Fetch conversation when selecting an agent
  useEffect(() => {
    if (selectedAgentId === null) {
      setConversationMsgs([]);
      return;
    }
    setLoadingConv(true);
    // Use the first agent as "me" (just pick the first agent in the list)
    const myId = agents[0]?.id;
    if (!myId) {
      setLoadingConv(false);
      return;
    }
    fetch(
      `/api/trpc/message.conversation?input=${encodeURIComponent(JSON.stringify({ from: myId, to: selectedAgentId }))}`
    )
      .then((r) => r.json())
      .then((data) => {
        const msgs = Array.isArray(data) ? data : data?.result?.data || [];
        setConversationMsgs(msgs);
      })
      .catch(() => {})
      .finally(() => setLoadingConv(false));
  }, [selectedAgentId, agents]);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [conversationMsgs]);

  const handleSend = useCallback(async () => {
    if (!sendContent.trim() || selectedAgentId === null) return;
    const myId = agents[0]?.id;
    if (!myId) return;

    try {
      const res = await fetch("/api/trpc/message.send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fromAgent: myId,
          toAgent: selectedAgentId,
          content: sendContent.trim(),
          type: "command",
        }),
      });
      const data = await res.json();
      if (data?.result?.data?.success || data?.success) {
        // Add optimistic message
        const newMsg: DisplayMessage = {
          id: Date.now(),
          fromAgent: myId,
          toAgent: selectedAgentId,
          content: sendContent.trim(),
          type: "command",
          status: "sent",
          createdAt: new Date().toISOString(),
        };
        setConversationMsgs((prev) => [...prev, newMsg]);
        setSendContent("");
      }
    } catch (err) {
      console.warn("Failed to send message:", err);
    }
  }, [sendContent, selectedAgentId, agents]);

  const statusLabel = (s: string) => {
    switch (s) {
      case "sent":
        return "已发送";
      case "delivered":
        return "已送达";
      case "read":
        return "已读";
      default:
        return s;
    }
  };

  const statusColor = (s: string) => {
    switch (s) {
      case "sent":
        return "var(--text-muted)";
      case "delivered":
        return "var(--accent-cyan)";
      case "read":
        return "var(--success)";
      default:
        return "var(--text-muted)";
    }
  };

  return (
    <div className="glass-panel p-4 sci-border flex flex-col" style={{ minHeight: "400px" }}>
      <div className="flex items-center justify-between mb-3">
        <div className="section-label">消息面板 · MESSAGES</div>
        <div className="flex items-center gap-2">
          <span
            className="w-2 h-2 rounded-full"
            style={{ background: wsConnected ? "var(--success)" : "var(--accent-red)" }}
          />
          <span className="text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>
            {wsConnected ? "WS 已连接" : "WS 离线"}
          </span>
        </div>
      </div>

      <div className="flex gap-3 flex-1 min-h-0">
        {/* Agent list sidebar */}
        <div className="w-40 flex-shrink-0 border-r overflow-y-auto custom-scrollbar" style={{ borderColor: "var(--border-default)" }}>
          <div className="text-[10px] font-mono mb-2 px-1" style={{ color: "var(--text-muted)" }}>
            选择 Agent
          </div>
          {agents.map((agent) => (
            <button
              key={agent.id}
              onClick={() => setSelectedAgentId(agent.id)}
              className="w-full text-left px-2 py-1.5 rounded text-xs transition-colors flex items-center gap-1.5"
              style={{
                background:
                  selectedAgentId === agent.id ? "var(--accent-glow-red)" : "transparent",
                color:
                  selectedAgentId === agent.id
                    ? "var(--accent-red-bright)"
                    : "var(--text-secondary)",
              }}
            >
              <span
                className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                style={{
                  background:
                    agent.status === "online" || agent.status === "busy"
                      ? "var(--success)"
                      : "var(--text-muted)",
                }}
              />
              <span className="truncate">{agent.name}</span>
            </button>
          ))}
        </div>

        {/* Conversation / message area */}
        <div className="flex-1 flex flex-col min-w-0">
          {selectedAgentId === null ? (
            <div
              className="flex-1 flex items-center justify-center text-xs font-mono"
              style={{ color: "var(--text-muted)" }}
            >
              👈 选择一个 Agent 查看对话
            </div>
          ) : (
            <>
              {/* Conversation header */}
              <div
                className="flex items-center gap-2 pb-2 mb-2"
                style={{ borderBottom: "1px solid var(--border-default)" }}
              >
                <span className="text-sm font-bold" style={{ color: "var(--text-primary)" }}>
                  {agentMap.get(selectedAgentId)?.name || `Agent #${selectedAgentId}`}
                </span>
                <span
                  className="text-[10px] font-mono px-1.5 py-0.5 rounded"
                  style={{ background: "var(--accent-glow-gold)", color: "var(--accent-gold)" }}
                >
                  {agentMap.get(selectedAgentId)?.agentId || ""}
                </span>
              </div>

              {/* Messages */}
              <div className="flex-1 overflow-y-auto custom-scrollbar mb-2 space-y-2" style={{ maxHeight: "300px" }}>
                {loadingConv ? (
                  <div className="text-center text-xs font-mono py-4" style={{ color: "var(--text-muted)" }}>
                    加载中...
                  </div>
                ) : conversationMsgs.length === 0 ? (
                  <div className="text-center text-xs font-mono py-4" style={{ color: "var(--text-muted)" }}>
                    暂无消息
                  </div>
                ) : (
                  conversationMsgs.map((msg) => {
                    const isMe = msg.fromAgent === agents[0]?.id;
                    return (
                      <div
                        key={msg.id}
                        className={`flex ${isMe ? "justify-end" : "justify-start"}`}
                      >
                        <div
                          className="max-w-[80%] px-3 py-2 rounded-lg text-xs"
                          style={{
                            background: isMe
                              ? "var(--accent-glow-red)"
                              : "rgba(255,255,255,0.05)",
                            border: isMe
                              ? "1px solid rgba(194,58,48,0.2)"
                              : "1px solid var(--border-default)",
                          }}
                        >
                          <div style={{ color: "var(--text-primary)", wordBreak: "break-word" }}>
                            {msg.content}
                          </div>
                          <div className="flex items-center gap-2 mt-1">
                            <span className="text-[9px] font-mono" style={{ color: "var(--text-muted)" }}>
                              {new Date(msg.createdAt).toLocaleTimeString()}
                            </span>
                            {isMe && (
                              <span
                                className="text-[9px] font-mono"
                                style={{ color: statusColor(msg.status) }}
                              >
                                {statusLabel(msg.status)}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
                <div ref={messagesEndRef} />
              </div>

              {/* Send input */}
              <div className="flex gap-2">
                <input
                  type="text"
                  value={sendContent}
                  onChange={(e) => setSendContent(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleSend();
                    }
                  }}
                  placeholder="输入消息..."
                  className="flex-1 px-3 py-2 rounded text-xs"
                  style={{
                    background: "rgba(0,0,0,0.2)",
                    border: "1px solid var(--border-default)",
                    color: "var(--text-primary)",
                  }}
                />
                <button
                  onClick={handleSend}
                  disabled={!sendContent.trim()}
                  className="px-4 py-2 rounded text-xs font-bold transition-all"
                  style={{
                    background: sendContent.trim()
                      ? "var(--accent-red)"
                      : "rgba(255,255,255,0.05)",
                    color: sendContent.trim() ? "#fff" : "var(--text-muted)",
                    opacity: sendContent.trim() ? 1 : 0.5,
                  }}
                >
                  发送
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════
   主 DASHBOARD — v2 多 Tab
   ═══════════════════════════════════════════ */

type MainTab = 'dashboard' | 'org' | 'orch' | 'mcp';

export default function Dashboard() {
  const data = useDataSource();
  const stats = useDashboardStats();
  const auth = useAuth();
  const navigate = useNavigate();
  const { connected: wsConnected, lastMessage: lastWsMessage } = useWebSocket();

  const [mainTab, setMainTab] = useState<MainTab>('dashboard');
  const [filterTab, setFilterTab] = useState('all');

  // Track agent online status from WebSocket events
  const [wsAgentStatuses, setWsAgentStatuses] = useState<Map<number, string>>(new Map());

  useEffect(() => {
    if (!lastWsMessage) return;
    if (lastWsMessage.type === "agent_status" && lastWsMessage.agentId && lastWsMessage.status) {
      setWsAgentStatuses((prev) => {
        const next = new Map(prev);
        next.set(lastWsMessage.agentId, lastWsMessage.status);
        return next;
      });
    }
  }, [lastWsMessage]);

  // Merge WebSocket status with agent data
  const agentsWithWS = useMemo(() => {
    return (data.agents as MockAgent[]).map((a) => {
      const wsStatus = wsAgentStatuses.get(a.id);
      if (wsStatus) {
        return { ...a, status: wsStatus };
      }
      return a;
    });
  }, [data.agents, wsAgentStatuses]);

  // Dialogs
  const [showAgentForm, setShowAgentForm] = useState(false);
  const [showTaskForm, setShowTaskForm] = useState(false);
  const [showOrgForm, setShowOrgForm] = useState(false);
  const [editAgent, setEditAgent] = useState<MockAgent | null>(null);

  const filteredTasks = (() => {
    switch (filterTab) {
      case 'running': return data.tasks.filter(t => t.status === 'running');
      case 'review': return data.tasks.filter(t => t.status === 'pending' || t.status === 'queued');
      case 'archived': return data.tasks.filter(t => t.status === 'done' || t.status === 'failed');
      default: return data.tasks;
    }
  })();

  const filteredAgents = filterTab === 'running'
    ? agentsWithWS.filter(a => a.status === 'online' || a.status === 'busy')
    : agentsWithWS;

  const mainTabs: { key: MainTab; label: string; icon: string }[] = [
    { key: 'dashboard', label: '仪表盘', icon: '📊' },
    { key: 'org', label: '组织架构', icon: '🏢' },
    { key: 'orch', label: '任务编排', icon: '🔗' },
    { key: 'mcp', label: 'MCP接入', icon: '🔌' },
  ];

  const filterTabs = [
    { key: 'all', label: '全部' },
    { key: 'running', label: '运行中' },
    { key: 'review', label: '审核中' },
    { key: 'archived', label: '已归档' },
  ];

  const handleAddAgent = (v: Record<string, string>) => { data.addAgent(v); setShowAgentForm(false); };
  const handleEditAgent = (v: Record<string, string>) => { if (editAgent) { data.updateAgent(editAgent.id, { name: v.name, system: v.system, source: v.source, model: v.model, role: v.role, description: v.description, capabilities: v.capabilities }); setEditAgent(null); } };
  const handleAddTask = (v: Record<string, string>) => { data.addTask(v); setShowTaskForm(false); };
  const handleAddOrg = (v: Record<string, string>) => { data.addOrg(v); setShowOrgForm(false); };

  return (
    <div className="relative z-10 min-h-screen pt-4 pb-6 px-4 md:px-6 bg-grid" style={{ backgroundColor: 'transparent' }}>
      <div className="max-w-7xl mx-auto">

        {/* ── 标题行 ── */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-4">
          <div className="lg:col-span-2 glass-panel p-6 sci-border flex items-center gap-6">
            <div className="flex-shrink-0 hidden sm:block"><RingText3D text="TIANGONG-AGENT-HUB-MESSAGING-PLATFORM-" radius={90} /></div>
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-2 flex-wrap">
                <div className="section-label">TIANGONG DASHBOARD v2</div>
                <div className="h-3 w-px" style={{ background: 'var(--border-default)' }} />
                <div className="text-[10px] font-mono" style={{ color: 'var(--accent-red)' }}>中国空间站 · 核心舱</div>
              </div>
              <h1 className="text-2xl md:text-3xl font-black tracking-wider mb-2" style={{ color: 'var(--text-primary)' }}>天宫 Agent 消息平台</h1>
              <p className="text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>多 Agent 协作 · 任务编排 · 组织管理 — 像指挥空间站一样调度 AI 网络。</p>
            </div>
          </div>
          <div className="flex flex-col gap-3">
            <LiveClock />
            <SystemMonitor />
          </div>
        </div>

        {/* ── 主 Tab 导航 ── */}
        <div className="flex items-center gap-1 mb-4">
          {mainTabs.map(tab => (
            <button key={tab.key} onClick={() => setMainTab(tab.key)}
              className="flex items-center gap-1.5 px-4 py-2 rounded text-sm font-bold transition-all"
              style={{
                background: mainTab === tab.key ? 'var(--accent-glow-red)' : 'transparent',
                color: mainTab === tab.key ? 'var(--accent-red-bright)' : 'var(--text-muted)',
                border: mainTab === tab.key ? '1px solid rgba(194,58,48,0.2)' : '1px solid transparent',
              }}>
              <span>{tab.icon}</span> {tab.label}
            </button>
          ))}
          <div className="flex-1" />
          <div className="flex items-center gap-2">
            {auth.isAuthenticated && <span className="text-[10px] font-mono px-2 py-1 rounded" style={{ background: 'var(--accent-glow-gold)', color: 'var(--accent-gold)' }}>{auth.user?.name || '管理员'}</span>}
            {!auth.isAuthenticated && <button onClick={() => navigate('/login')} className="text-[10px] font-mono px-2 py-1 rounded hover:bg-[rgba(180,200,255,0.04)] transition-colors" style={{ color: 'var(--text-muted)', border: '1px solid var(--border-default)' }}>登录</button>}
          </div>
        </div>

        {/* ── 仪表盘 Tab ── */}
        {mainTab === 'dashboard' && (
          <>
            <div className="mb-4"><StatsRow agents={stats.agents} tasks={stats.tasks} totalMsgs={stats.totalMsgs} orgs={stats.orgs} todayCostCents={stats.todayCostCents} /></div>
            {/* Filter + Actions */}
            <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
              <div className="flex items-center gap-1">
                {filterTabs.map(tab => (
                  <button key={tab.key} onClick={() => setFilterTab(tab.key)}
                    className="px-3 py-1.5 rounded text-xs transition-all"
                    style={{
                      background: filterTab === tab.key ? 'var(--accent-glow-red)' : 'transparent',
                      color: filterTab === tab.key ? 'var(--accent-red-bright)' : 'var(--text-muted)',
                      border: filterTab === tab.key ? '1px solid rgba(194,58,48,0.2)' : '1px solid transparent',
                    }}>{tab.label}</button>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <Dialog open={showAgentForm} onOpenChange={setShowAgentForm}>
                  <DialogTrigger asChild><button className="px-3 py-1.5 rounded text-xs font-bold tracking-wider transition-all hover:brightness-110" style={{ background: 'var(--accent-red)', color: '#fff', boxShadow: '0 0 12px rgba(194,58,48,0.2)' }}>+ Agent</button></DialogTrigger>
                  <DialogContent className="border-0 max-w-lg" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-default)' }}>
                    <DialogHeader><DialogTitle className="section-label">新建 Agent · NEW AGENT</DialogTitle></DialogHeader>
                    <AgentForm onSubmit={handleAddAgent} onCancel={() => setShowAgentForm(false)} />
                  </DialogContent>
                </Dialog>
                <Dialog open={showTaskForm} onOpenChange={setShowTaskForm}>
                  <DialogTrigger asChild><button className="px-3 py-1.5 rounded text-xs font-bold tracking-wider transition-all hover:brightness-110" style={{ background: 'var(--accent-gold)', color: '#000', boxShadow: '0 0 12px rgba(201,168,76,0.15)' }}>+ 任务</button></DialogTrigger>
                  <DialogContent className="border-0" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-default)' }}>
                    <DialogHeader><DialogTitle className="section-label">新建任务 · NEW TASK</DialogTitle></DialogHeader>
                    <TaskForm agents={data.agents as MockAgent[]} onSubmit={handleAddTask} onCancel={() => setShowTaskForm(false)} />
                  </DialogContent>
                </Dialog>
                <Dialog open={showOrgForm} onOpenChange={setShowOrgForm}>
                  <DialogTrigger asChild><button className="px-3 py-1.5 rounded text-xs font-bold tracking-wider transition-all hover:bg-[rgba(180,200,255,0.06)]" style={{ color: 'var(--text-secondary)', border: '1px solid var(--border-default)' }}>+ 组织</button></DialogTrigger>
                  <DialogContent className="border-0" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-default)' }}>
                    <DialogHeader><DialogTitle className="section-label">新建组织 · NEW ORG</DialogTitle></DialogHeader>
                    <OrgForm onSubmit={handleAddOrg} onCancel={() => setShowOrgForm(false)} />
                  </DialogContent>
                </Dialog>
              </div>
            </div>
            {/* Agent Grid + Systems */}
            <div className="grid grid-cols-1 lg:grid-cols-4 gap-4 mb-6">
              <div className="lg:col-span-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {filteredAgents.length === 0 ? (
                  <div className="col-span-full glass-panel p-8 text-center text-sm font-mono" style={{ color: 'var(--text-muted)' }}>暂无 Agent · 请点击「+ Agent」创建</div>
                ) : filteredAgents.map(agent => (
                  <AgentCard key={agent.id} agent={agent}
                    onStatusChange={data.updateAgentStatus}
                    onEdit={a => setEditAgent(a)}
                    onDelete={data.deleteAgent}
                    onNavigateToMcp={() => setMainTab('mcp')} />
                ))}
              </div>
              <div className="lg:col-span-1">
                <ConnectionPanel systems={data.systems} onStatusChange={data.updateSystemStatus} />
              </div>
            </div>
            {/* Message Panel */}
            <div className="mb-6">
              <MessagePanel agents={agentsWithWS} lastWsMessage={lastWsMessage} wsConnected={wsConnected} />
            </div>

            {/* Task list */}
            <div className="glass-panel p-4 sci-border">
              <div className="section-label mb-3">任务列表 · TASKS ({filteredTasks.length})</div>
              <div className="flex flex-col gap-1 max-h-[300px] overflow-y-auto custom-scrollbar">
                {filteredTasks.map(t => (
                  <div key={t.id} className="flex items-center gap-3 py-2 px-2 rounded hover:bg-[rgba(180,200,255,0.02)]">
                    <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: t.status === 'done' ? 'var(--success)' : t.status === 'running' ? 'var(--accent-red)' : t.status === 'failed' ? 'var(--accent-red)' : 'var(--text-muted)' }} />
                    <span className="font-mono text-[10px]" style={{ color: 'var(--accent-gold)' }}>{t.taskId}</span>
                    <span className="text-xs flex-1 truncate" style={{ color: 'var(--text-secondary)' }}>{t.name}</span>
                    <span className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>{t.progress}%</span>
                    <button onClick={() => data.updateTaskProgress(t.id, Math.min(100, t.progress + 10), t.progress + 10 >= 100 ? 'done' : 'running')} className="text-[10px] px-1.5 py-0.5 rounded hover:bg-[rgba(180,200,255,0.04)]" style={{ color: 'var(--text-muted)' }}>+10%</button>
                    <button onClick={() => data.deleteTask(t.id)} className="text-[10px] px-1 rounded hover:bg-[var(--accent-glow-red)]" style={{ color: 'var(--accent-red)' }}>✕</button>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        {/* ── 组织架构 Tab ── */}
        {mainTab === 'org' && <OrgTab />}

        {/* ── 任务编排 Tab ── */}
        {mainTab === 'orch' && <OrchTab />}

        {/* ── MCP 接入 Tab ── */}
        {mainTab === 'mcp' && <McpPanel />}

        {/* ── 底部 ── */}
        <div className="mt-6 glass-panel px-4">
          <div className="flex items-center justify-between py-2">
            <div className="flex items-center gap-4">
              {['GitHub', '文档', 'Discord'].map(l => (
                <a key={l} href="#" className="text-xs transition-colors hover:text-[var(--accent-red)]" style={{ color: 'var(--text-muted)' }}>{l}</a>
              ))}
            </div>
            <div className="flex items-center gap-3">
              <span className="flex items-center gap-1.5 text-[10px]" style={{ color: 'var(--text-muted)' }}><span className="w-1 h-1 rounded-full" style={{ background: data.hasBackend ? 'var(--success)' : 'var(--accent-red)' }} />{data.hasBackend ? 'API 已连接' : '离线模式'}</span>
              <span className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>MIT License</span>
            </div>
          </div>
        </div>
      </div>

      {/* ── Edit Agent Dialog ── */}
      {editAgent && (
        <Dialog open={!!editAgent} onOpenChange={() => setEditAgent(null)}>
          <DialogContent className="border-0 max-w-lg" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-default)' }}>
            <DialogHeader><DialogTitle className="section-label">编辑 Agent · EDIT {editAgent.agentId}</DialogTitle></DialogHeader>
            <AgentForm agent={editAgent} onSubmit={handleEditAgent} onCancel={() => setEditAgent(null)} />
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
