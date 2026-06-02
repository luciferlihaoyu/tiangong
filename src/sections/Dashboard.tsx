import { useState, useEffect, type ReactNode } from "react";
import { useDataSource, type MockAgent } from "@/hooks/useDataSource";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// ─── 3D Ring Text ───
function RingText3D({ text, radius = 100 }: { text: string; radius?: number }) {
  const chars = text.split('');
  const angleStep = 360 / chars.length;
  return (
    <div className="ring-scene w-[200px] h-[200px] flex items-center justify-center">
      <div className="ring-container w-0 h-0">
        {chars.map((char, i) => (
          <span key={i} className="ring-char"
            style={{ transform: `rotateY(${i * angleStep}deg) translateZ(${radius}px)` }}>
            {char}
          </span>
        ))}
      </div>
    </div>
  );
}

// ─── Live Clock ───
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

// ─── System Monitor ───
function SystemMonitor() {
  const [metrics, setMetrics] = useState({ cpu: 42, ram: 68, net: 12 });
  useEffect(() => {
    const t = setInterval(() => setMetrics({ cpu: 30 + Math.floor(Math.random() * 40), ram: 60 + Math.floor(Math.random() * 25), net: 5 + Math.floor(Math.random() * 20) }), 3000);
    return () => clearInterval(t);
  }, []);
  const bars = [
    { label: 'CPU', value: metrics.cpu, color: 'var(--accent-red)' },
    { label: 'RAM', value: metrics.ram, color: 'var(--accent-gold)' },
    { label: 'NET', value: metrics.net, color: 'var(--accent-cyan)' },
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

// ─── Stats Row ───
function StatsRow({ agents, tasks, totalMsgs, orgs }: { agents: MockAgent[]; tasks: { status: string }[]; totalMsgs: number; orgs: number }) {
  const onlineCount = agents.filter(a => a.status === 'online' || a.status === 'busy').length;
  const doneCount = tasks.filter(t => t.status === 'done').length;
  const stats = [
    { label: '活跃 Agent', value: String(onlineCount), sub: `${agents.length} 个总计` },
    { label: '今日任务', value: String(tasks.length), sub: `已完成 ${doneCount}` },
    { label: '消息总量', value: totalMsgs >= 1000 ? `${(totalMsgs / 1000).toFixed(1)}K` : String(totalMsgs), sub: '实时同步' },
    { label: '组织架构', value: String(orgs), sub: '个公司' },
  ];
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {stats.map(s => (
        <div key={s.label} className="glass-panel p-3 sci-border">
          <div className="text-[10px] mb-1 font-mono" style={{ color: 'var(--text-muted)' }}>{s.label}</div>
          <div className="font-mono text-lg font-bold" style={{ color: 'var(--accent-gold)' }}>{s.value}</div>
          <div className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>{s.sub}</div>
        </div>
      ))}
    </div>
  );
}

// ─── Connection Panel ───
function ConnectionPanel({ systems, onStatusChange }: { systems: { id: number; name: string; status: string }[]; onStatusChange?: (id: number, status: string) => void }) {
  const sc: Record<string, string> = { connected: 'var(--success)', syncing: 'var(--accent-gold)', disconnected: 'var(--text-muted)' };
  const st: Record<string, string> = { connected: '已连接', syncing: '同步中', disconnected: '断开' };
  return (
    <div className="glass-panel p-4 sci-border">
      <div className="section-label mb-3">系统接入 · SYS_CONN</div>
      <div className="flex flex-col gap-2">
        {systems.map(s => (
          <div key={s.id} className="flex items-center justify-between py-1">
            <div className="flex items-center gap-2">
              <span className="w-5 h-5 rounded-sm flex items-center justify-center text-[10px] font-bold"
                style={{ background: 'var(--accent-glow-red)', color: 'var(--accent-red)' }}>{s.name[0]}</span>
              <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>{s.name}</span>
            </div>
            <button onClick={() => { const o = ['disconnected', 'syncing', 'connected']; onStatusChange?.(s.id, o[(o.indexOf(s.status) + 1) % o.length]); }}
              className="flex items-center gap-1.5 hover:opacity-80 transition-opacity">
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: sc[s.status] }} />
              <span className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>{st[s.status]}</span>
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Task Timeline ───
function TaskTimeline({ tasks, agents, onProgress, onDelete }: {
  tasks: { id: number; taskId: string; name: string; status: string; progress: number; agentId: number | null }[];
  agents: MockAgent[]; onProgress?: (id: number, p: number, s: string) => void; onDelete?: (id: number) => void;
}) {
  const si: Record<string, ReactNode> = { running: <span className="status-dot status-dot-busy" />, pending: <span className="status-dot status-dot-idle" />, done: <span className="status-dot status-dot-online" />, failed: <span className="w-1.5 h-1.5 rounded-full bg-red-500" /> };
  return (
    <div className="glass-panel p-4 sci-border">
      <div className="flex items-center justify-between mb-3">
        <div className="section-label">任务时间线 · TASK_LOG</div>
        <span className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>{tasks.length} 个任务</span>
      </div>
      <div className="flex flex-col gap-0 max-h-[240px] overflow-y-auto custom-scrollbar pr-1">
        {tasks.map(t => (
          <div key={t.id} className="flex items-center gap-3 py-2 border-t first:border-t-0 hover:bg-[rgba(180,200,255,0.02)] rounded px-1 group" style={{ borderColor: 'var(--border-default)' }}>
            <div className="flex-shrink-0">{si[t.status] || si.pending}</div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-mono text-[10px] font-bold" style={{ color: 'var(--accent-gold)' }}>{t.taskId}</span>
                <span className="text-xs truncate" style={{ color: 'var(--text-secondary)' }}>{t.name}</span>
              </div>
              {t.agentId && <span className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>{agents.find(a => a.id === t.agentId)?.name || `Agent-${t.agentId}`}</span>}
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => { const n = Math.min(100, t.progress + 10); onProgress?.(t.id, n, n >= 100 ? 'done' : 'running'); }}
                className="text-[10px] px-1.5 py-0.5 rounded hover:bg-[rgba(180,200,255,0.04)] transition-colors" style={{ color: 'var(--text-muted)' }}>{t.progress}%</button>
              <button onClick={() => onDelete?.(t.id)} className="opacity-0 group-hover:opacity-100 text-[10px] px-1 rounded hover:bg-[var(--accent-glow-red)] transition-all" style={{ color: 'var(--accent-red)' }}>✕</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Agent Card ───
function AgentCard({ agent, onStatusChange, onEdit, onDelete }: {
  agent: MockAgent; onStatusChange: (id: number, s: string) => void;
  onEdit: (a: MockAgent) => void; onDelete: (id: number) => void;
}) {
  const cfg: Record<string, { dot: string; color: string }> = { online: { dot: 'status-dot-online', color: 'var(--success)' }, busy: { dot: 'status-dot-busy', color: 'var(--accent-red)' }, idle: { dot: 'status-dot-idle', color: 'var(--text-muted)' } };
  const sl: Record<string, string> = { online: '在线', busy: '忙碌', idle: '空闲' };
  const c = cfg[agent.status] || cfg.idle;
  return (
    <div className="glass-panel p-4 sci-border transition-all cursor-default group relative">
      {/* Edit/Delete buttons */}
      <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button onClick={() => onEdit(agent)} className="text-[10px] px-1.5 py-0.5 rounded hover:bg-[rgba(100,181,246,0.1)] transition-colors" style={{ color: 'var(--accent-cyan)' }}>编辑</button>
        <button onClick={() => onDelete(agent.id)} className="text-[10px] px-1.5 py-0.5 rounded hover:bg-[var(--accent-glow-red)] transition-colors" style={{ color: 'var(--accent-red)' }}>删除</button>
      </div>
      <div className="flex items-center justify-between mb-3 pr-16">
        <div className="flex items-center gap-2">
          <span className={`status-dot ${c.dot}`} />
          <span className="text-sm font-bold tracking-wide" style={{ color: 'var(--text-primary)' }}>{agent.name}</span>
        </div>
        <span className="font-mono text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'var(--accent-glow-gold)', color: 'var(--accent-gold)' }}>{agent.agentId}</span>
      </div>
      <div className="flex items-center gap-1.5 mb-2 flex-wrap">
        <span className="text-[10px] px-1.5 py-0.5 rounded font-mono" style={{ background: 'var(--accent-glow-red)', color: 'var(--accent-red-bright)' }}>{agent.system}</span>
        <button onClick={() => { const o = ['idle', 'online', 'busy']; onStatusChange(agent.id, o[(o.indexOf(agent.status) + 1) % o.length]); }}
          className="text-[10px] px-1.5 py-0.5 rounded hover:opacity-80 transition-opacity" style={{ color: c.color }}>{sl[agent.status] || agent.status}</button>
        <span className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>{agent.messagesCount} 消息</span>
      </div>
      <div className="text-xs mb-2 truncate" style={{ color: 'var(--text-secondary)' }}>{agent.task || '等待任务'}</div>
      {agent.progress > 0 && <div className="progress-track"><div className="progress-fill" style={{ width: `${agent.progress}%` }} /></div>}
    </div>
  );
}

// ─── Org Panel ───
function OrgPanel({ orgs, onDelete }: { orgs: { id: number; name: string; description: string | null; agents: number; createdAt: string }[]; onDelete: (id: number) => void }) {
  return (
    <div className="glass-panel p-4 sci-border">
      <div className="section-label mb-3">组织架构 · ORG</div>
      <div className="flex flex-col gap-2">
        {orgs.map(o => (
          <div key={o.id} className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-[rgba(180,200,255,0.02)] transition-colors">
            <div>
              <div className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>{o.name}</div>
              <div className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>{o.description || '-'} · {o.agents} 个Agent · {o.createdAt}</div>
            </div>
            <button onClick={() => onDelete(o.id)} className="text-[10px] px-1.5 py-0.5 rounded hover:bg-[var(--accent-glow-red)] transition-colors opacity-0 hover:opacity-100" style={{ color: 'var(--accent-red)' }}>删除</button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════
// MAIN DASHBOARD
// ═══════════════════════════════════════════════
export default function Dashboard() {
  const data = useDataSource();

  // Dialog states
  const [showAgentForm, setShowAgentForm] = useState(false);
  const [showTaskForm, setShowTaskForm] = useState(false);
  const [showOrgForm, setShowOrgForm] = useState(false);
  const [editAgent, setEditAgent] = useState<MockAgent | null>(null);

  const handleAddAgent = (v: Record<string, string>) => data.addAgent({ name: v.name, system: v.system, task: v.task, description: v.description });
  const handleEditAgent = (v: Record<string, string>) => { if (editAgent) { data.updateAgent(editAgent.id, { name: v.name, system: v.system, task: v.task, description: v.description }); setEditAgent(null); } };
  const handleAddTask = (v: Record<string, string>) => data.addTask({ name: v.name, agentId: v.agentId ? Number(v.agentId) : null, description: v.description });
  const handleAddOrg = (v: Record<string, string>) => data.addOrg({ name: v.name, description: v.description });

  return (
    <div className="relative z-10 min-h-screen pt-14 pb-6 px-4 md:px-6 bg-grid" style={{ backgroundColor: 'transparent' }}>
      <div className="max-w-7xl mx-auto">

        {/* ── Title Row ── */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-4">
          <div className="lg:col-span-2 glass-panel p-6 sci-border flex items-center gap-6">
            <div className="flex-shrink-0 hidden sm:block"><RingText3D text="TIANGONG-AGENT-HUB-MESSAGING-PLATFORM-" radius={90} /></div>
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-2 flex-wrap">
                <div className="section-label">TIANGONG DASHBOARD</div>
                <div className="h-3 w-px" style={{ background: 'var(--border-default)' }} />
                <div className="text-[10px] font-mono" style={{ color: 'var(--accent-red)' }}>中国空间站 · 核心舱</div>
              </div>
              <h1 className="text-2xl md:text-3xl font-black tracking-wider mb-2" style={{ color: 'var(--text-primary)' }}>天宫 Agent 消息平台</h1>
              <p className="text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>多 Agent、多系统共用的统一消息中枢。像指挥空间站一样调度你的 AI 代理网络。</p>
            </div>
          </div>
          <div className="flex flex-col gap-3">
            <LiveClock />
            <SystemMonitor />
          </div>
        </div>

        {/* ── Stats ── */}
        <div className="mb-4"><StatsRow agents={data.agents as MockAgent[]} tasks={data.tasks} totalMsgs={data.msgStats.total} orgs={data.orgs.length} /></div>

        {/* ── Action Bar ── */}
        <div className="flex flex-wrap gap-2 mb-4">
          <Dialog open={showAgentForm} onOpenChange={setShowAgentForm}>
            <DialogTrigger asChild>
              <button className="px-4 py-2 rounded text-xs font-bold tracking-wider transition-all hover:brightness-110" style={{ background: 'var(--accent-red)', color: '#fff', boxShadow: '0 0 12px rgba(194,58,48,0.2)' }}>+ 新建 Agent</button>
            </DialogTrigger>
            <DialogContent className="border-0" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-default)' }}>
              <DialogHeader><DialogTitle className="section-label">新建 Agent · NEW AGENT</DialogTitle></DialogHeader>
              <AgentForm onSubmit={handleAddAgent} onCancel={() => setShowAgentForm(false)} />
            </DialogContent>
          </Dialog>

          <Dialog open={showTaskForm} onOpenChange={setShowTaskForm}>
            <DialogTrigger asChild>
              <button className="px-4 py-2 rounded text-xs font-bold tracking-wider transition-all hover:brightness-110" style={{ background: 'var(--accent-gold)', color: '#000', boxShadow: '0 0 12px rgba(201,168,76,0.15)' }}>+ 新建任务</button>
            </DialogTrigger>
            <DialogContent className="border-0" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-default)' }}>
              <DialogHeader><DialogTitle className="section-label">新建任务 · NEW TASK</DialogTitle></DialogHeader>
              <TaskForm agents={data.agents as MockAgent[]} onSubmit={handleAddTask} onCancel={() => setShowTaskForm(false)} />
            </DialogContent>
          </Dialog>

          <Dialog open={showOrgForm} onOpenChange={setShowOrgForm}>
            <DialogTrigger asChild>
              <button className="px-4 py-2 rounded text-xs font-bold tracking-wider transition-all hover:bg-[rgba(180,200,255,0.06)]" style={{ color: 'var(--text-secondary)', border: '1px solid var(--border-default)' }}>+ 新建组织</button>
            </DialogTrigger>
            <DialogContent className="border-0" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-default)' }}>
              <DialogHeader><DialogTitle className="section-label">新建组织 · NEW ORG</DialogTitle></DialogHeader>
              <OrgForm onSubmit={handleAddOrg} onCancel={() => setShowOrgForm(false)} />
            </DialogContent>
          </Dialog>
        </div>

        {/* ── Agent Grid + Systems ── */}
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-4 mb-4">
          <div className="lg:col-span-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {data.agents.length === 0 ? (
              <div className="col-span-full glass-panel p-8 text-center text-sm font-mono" style={{ color: 'var(--text-muted)' }}>暂无 Agent，点击「新建 Agent」创建</div>
            ) : (data.agents as MockAgent[]).map(agent => (
              <AgentCard key={agent.id} agent={agent} onStatusChange={data.updateAgentStatus}
                onEdit={a => setEditAgent(a)} onDelete={data.deleteAgent} />
            ))}
          </div>
          <div className="lg:col-span-1 flex flex-col gap-3">
            <ConnectionPanel systems={data.systems} onStatusChange={data.updateSystemStatus} />
            <OrgPanel orgs={data.orgs} onDelete={data.deleteOrg} />
          </div>
        </div>

        {/* ── Task Timeline ── */}
        <div className="mb-4">
          <TaskTimeline tasks={data.tasks} agents={data.agents as MockAgent[]}
            onProgress={data.updateTaskProgress} onDelete={data.deleteTask} />
        </div>

        {/* ── Footer ── */}
        <div className="glass-panel px-4">
          <div className="flex items-center justify-between py-2">
            <div className="flex items-center gap-4">
              {['GitHub', '文档', 'Discord', 'Twitter'].map(l => (
                <a key={l} href="#" className="text-xs transition-colors hover:text-[var(--accent-red)]" style={{ color: 'var(--text-muted)' }}>{l}</a>
              ))}
            </div>
            <div className="flex items-center gap-3">
              <span className="flex items-center gap-1.5 text-[10px]" style={{ color: 'var(--text-muted)' }}><span className="w-1 h-1 rounded-full" style={{ background: 'var(--success)' }} />所有系统运行正常</span>
              <span className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>MIT License</span>
            </div>
          </div>
        </div>
      </div>

      {/* ── Edit Agent Dialog ── */}
      {editAgent && (
        <Dialog open={!!editAgent} onOpenChange={() => setEditAgent(null)}>
          <DialogContent className="border-0" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-default)' }}>
            <DialogHeader><DialogTitle className="section-label">编辑 Agent · EDIT {editAgent.agentId}</DialogTitle></DialogHeader>
            <AgentForm agent={editAgent} onSubmit={handleEditAgent} onCancel={() => setEditAgent(null)} />
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

// ─── Agent Form ──
function AgentForm({ agent, onSubmit, onCancel }: { agent?: MockAgent; onSubmit: (v: Record<string, string>) => void; onCancel: () => void }) {
  const [name, setName] = useState(agent?.name || '');
  const [system, setSystem] = useState(agent?.system || '');
  const [task, setTask] = useState(agent?.task || '');
  const [description, setDescription] = useState(agent?.description || '');
  return (
    <form onSubmit={e => { e.preventDefault(); onSubmit({ name, system, task, description }); }} className="flex flex-col gap-3 mt-2">
      <div><Label className="text-[10px] font-mono mb-1 block" style={{ color: 'var(--text-muted)' }}>名称 · NAME</Label>
        <Input value={name} onChange={e => setName(e.target.value)} placeholder="如: CEO-01" required
          style={{ background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }} /></div>
      <div><Label className="text-[10px] font-mono mb-1 block" style={{ color: 'var(--text-muted)' }}>系统 · SYSTEM</Label>
        <Input value={system} onChange={e => setSystem(e.target.value)} placeholder="如: Claude, GPT-4, Cursor" required
          style={{ background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }} /></div>
      <div><Label className="text-[10px] font-mono mb-1 block" style={{ color: 'var(--text-muted)' }}>当前任务 · TASK</Label>
        <Input value={task} onChange={e => setTask(e.target.value)} placeholder="任务描述"
          style={{ background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }} /></div>
      <div><Label className="text-[10px] font-mono mb-1 block" style={{ color: 'var(--text-muted)' }}>描述 · DESCRIPTION</Label>
        <Input value={description} onChange={e => setDescription(e.target.value)} placeholder="Agent 职责描述"
          style={{ background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }} /></div>
      <div className="flex gap-2 mt-2">
        <Button type="submit" className="flex-1 text-xs font-bold" style={{ background: 'var(--accent-red)', color: '#fff' }}>{agent ? '保存修改' : '创建 Agent'}</Button>
        <Button type="button" onClick={onCancel} className="text-xs" variant="outline" style={{ border: '1px solid var(--border-default)', color: 'var(--text-muted)' }}>取消</Button>
      </div>
    </form>
  );
}

// ─── Task Form ──
function TaskForm({ agents, onSubmit, onCancel }: { agents: MockAgent[]; onSubmit: (v: Record<string, string>) => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [agentId, setAgentId] = useState('');
  const [description, setDescription] = useState('');
  return (
    <form onSubmit={e => { e.preventDefault(); onSubmit({ name, agentId, description }); }} className="flex flex-col gap-3 mt-2">
      <div><Label className="text-[10px] font-mono mb-1 block" style={{ color: 'var(--text-muted)' }}>任务名称 · NAME</Label>
        <Input value={name} onChange={e => setName(e.target.value)} placeholder="如: 数据清洗" required
          style={{ background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }} /></div>
      <div><Label className="text-[10px] font-mono mb-1 block" style={{ color: 'var(--text-muted)' }}>分配 Agent · ASSIGN</Label>
        <select value={agentId} onChange={e => setAgentId(e.target.value)}
          className="w-full px-3 py-2 rounded text-sm outline-none"
          style={{ background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}>
          <option value="">不分配</option>
          {agents.map(a => <option key={a.id} value={String(a.id)}>{a.name} ({a.system})</option>)}
        </select></div>
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

// ─── Org Form ──
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
