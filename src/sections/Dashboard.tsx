import { useEffect, useState, type ReactNode } from 'react';
import { trpc } from '@/providers/trpc';

/* ─── 3D Ring Text ─── */
function RingText3D({ text, radius = 100 }: { text: string; radius?: number }) {
  const chars = text.split('');
  const angleStep = 360 / chars.length;

  return (
    <div className="ring-scene w-[220px] h-[220px] flex items-center justify-center">
      <div className="ring-container w-0 h-0">
        {chars.map((char, i) => (
          <span
            key={i}
            className="ring-char"
            style={{ transform: `rotateY(${i * angleStep}deg) translateZ(${radius}px)` }}
          >
            {char}
          </span>
        ))}
      </div>
    </div>
  );
}

/* ─── Live Clock ─── */
function LiveClock() {
  const [time, setTime] = useState(new Date());
  useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return (
    <div className="glass-panel p-4">
      <div className="section-label mb-2">系统时间</div>
      <div className="font-mono text-2xl font-bold tracking-wider" style={{ color: 'var(--accent-amber)' }}>
        {pad(time.getHours())}:{pad(time.getMinutes())}:{pad(time.getSeconds())}
      </div>
      <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
        {time.getFullYear()}.{pad(time.getMonth() + 1)}.{pad(time.getDate())}
      </div>
    </div>
  );
}

/* ─── System Monitor ─── */
function SystemMonitor() {
  const [metrics, setMetrics] = useState({ cpu: 42, ram: 68, net: 12 });
  useEffect(() => {
    const timer = setInterval(() => {
      setMetrics({
        cpu: 30 + Math.floor(Math.random() * 40),
        ram: 60 + Math.floor(Math.random() * 25),
        net: 5 + Math.floor(Math.random() * 20),
      });
    }, 3000);
    return () => clearInterval(timer);
  }, []);
  const bars = [
    { label: 'CPU', value: metrics.cpu, color: '#5BA86C' },
    { label: 'RAM', value: metrics.ram, color: '#D4943A' },
    { label: 'NET', value: metrics.net, color: '#6B9ECF' },
  ];
  return (
    <div className="glass-panel p-4">
      <div className="section-label mb-3">系统资源</div>
      <div className="flex flex-col gap-3">
        {bars.map((b) => (
          <div key={b.label}>
            <div className="flex justify-between text-xs mb-1">
              <span style={{ color: 'var(--text-secondary)' }}>{b.label}</span>
              <span className="font-mono" style={{ color: b.color }}>{b.value}%</span>
            </div>
            <div className="progress-track">
              <div className="progress-fill transition-all duration-700" style={{ width: `${b.value}%`, background: b.color }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─── Agent Card ─── */
const statusConfig: Record<string, { dot: string; color: string }> = {
  online: { dot: 'status-dot-online', color: '#5BA86C' },
  busy: { dot: 'status-dot-busy', color: '#D4943A' },
  idle: { dot: 'status-dot-idle', color: 'var(--text-muted)' },
};

const statusLabel: Record<string, string> = { online: '在线', busy: '忙碌', idle: '空闲' };

function AgentCard({ agent }: { agent: { id: number; agentId: string; name: string; system: string; status: string; task: string | null; progress: number; messagesCount: number } }) {
  const cfg = statusConfig[agent.status] || statusConfig.idle;
  const utils = trpc.useUtils();
  const updateMutation = trpc.agent.updateStatus.useMutation({
    onSuccess: () => utils.agent.list.invalidate(),
  });

  const cycleStatus = () => {
    const order = ['idle', 'online', 'busy'];
    const next = order[(order.indexOf(agent.status) + 1) % order.length];
    updateMutation.mutate({ id: agent.id, status: next as 'idle' | 'online' | 'busy' });
  };

  return (
    <div className="glass-panel p-4 transition-all cursor-default">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className={`status-dot ${cfg.dot}`} />
          <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{agent.name}</span>
        </div>
        <span className="font-mono text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'rgba(255,255,255,0.04)', color: 'var(--text-muted)' }}>
          {agent.agentId}
        </span>
      </div>
      <div className="flex items-center gap-1.5 mb-2">
        <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'var(--accent-dim)', color: 'var(--accent-caramel)' }}>
          {agent.system}
        </span>
        <button onClick={cycleStatus} className="text-[10px] px-1.5 py-0.5 rounded hover:bg-white/5 transition-colors" style={{ color: cfg.color }}>
          {statusLabel[agent.status] || agent.status}
        </button>
        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{agent.messagesCount} 消息</span>
      </div>
      <div className="text-xs mb-2 truncate" style={{ color: 'var(--text-secondary)' }}>
        {agent.task || '等待任务'}
      </div>
      {agent.progress > 0 && (
        <div className="progress-track">
          <div className="progress-fill" style={{ width: `${agent.progress}%` }} />
        </div>
      )}
    </div>
  );
}

/* ─── System Connection Panel ─── */
function ConnectionPanel() {
  const { data: systems } = trpc.system.list.useQuery();
  const utils = trpc.useUtils();
  const updateMutation = trpc.system.updateStatus.useMutation({
    onSuccess: () => utils.system.list.invalidate(),
  });

  const statusColor: Record<string, string> = {
    connected: 'var(--success)',
    syncing: 'var(--warning)',
    disconnected: 'var(--text-muted)',
  };
  const statusText: Record<string, string> = {
    connected: '已连接',
    syncing: '同步中',
    disconnected: '断开',
  };

  const cycleStatus = (id: number, current: string) => {
    const order = ['disconnected', 'syncing', 'connected'];
    const next = order[(order.indexOf(current) + 1) % order.length];
    updateMutation.mutate({ id, status: next as 'connected' | 'syncing' | 'disconnected' });
  };

  return (
    <div className="glass-panel p-4">
      <div className="section-label mb-3">系统接入</div>
      <div className="flex flex-col gap-2">
        {systems?.map((s) => (
          <div key={s.id} className="flex items-center justify-between py-1">
            <div className="flex items-center gap-2">
              <span className="w-5 h-5 rounded flex items-center justify-center text-[10px] font-bold"
                style={{ background: 'rgba(255,255,255,0.05)', color: 'var(--text-secondary)' }}>
                {s.name[0]}
              </span>
              <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>{s.name}</span>
            </div>
            <button onClick={() => cycleStatus(s.id, s.status)} className="flex items-center gap-1.5 hover:opacity-80 transition-opacity">
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: statusColor[s.status] }} />
              <span className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>{statusText[s.status]}</span>
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─── Task Timeline ─── */
function TaskTimeline() {
  const { data: tasks } = trpc.task.list.useQuery();
  const utils = trpc.useUtils();
  const updateMutation = trpc.task.updateProgress.useMutation({
    onSuccess: () => utils.task.list.invalidate(),
  });

  const statusIcon: Record<string, ReactNode> = {
    running: <span className="status-dot status-dot-busy" />,
    pending: <span className="status-dot status-dot-idle" />,
    done: <span className="status-dot status-dot-online" />,
    failed: <span className="w-1.5 h-1.5 rounded-full bg-red-500" />,
  };


  return (
    <div className="glass-panel p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="section-label">任务时间线</div>
        <span className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>
          {tasks?.length ?? 0} 个任务
        </span>
      </div>
      <div className="flex flex-col gap-0 max-h-[200px] overflow-y-auto custom-scrollbar pr-1">
        {tasks?.map((t) => (
          <div key={t.id}
            className="flex items-center gap-3 py-2 border-t border-white/5 first:border-t-0 transition-colors hover:bg-white/[0.02] rounded px-1">
            <div className="flex-shrink-0">{statusIcon[t.status]}</div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-mono text-[10px]" style={{ color: 'var(--accent-caramel)' }}>{t.taskId}</span>
                <span className="text-xs truncate" style={{ color: 'var(--text-secondary)' }}>{t.name}</span>
              </div>
            </div>
            <div className="flex-shrink-0 flex items-center gap-2">
              <button
                onClick={() => {
                  const next = Math.min(100, t.progress + 10);
                  const st = next >= 100 ? 'done' : 'running';
                  updateMutation.mutate({ id: t.id, progress: next, status: st as 'running' | 'done' | 'pending' | 'failed' });
                }}
                className="text-[10px] px-1.5 py-0.5 rounded hover:bg-white/5 transition-colors"
                style={{ color: 'var(--text-muted)' }}>
                {t.progress}%
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─── Stats Row ─── */
function StatsRow() {
  const { data: agents } = trpc.agent.list.useQuery();
  const { data: tasks } = trpc.task.list.useQuery();
  const { data: msgStats } = trpc.message.stats.useQuery();

  const onlineCount = agents?.filter((a) => a.status === 'online' || a.status === 'busy').length ?? 0;
  const doneCount = tasks?.filter((t) => t.status === 'done').length ?? 0;
  const totalTasks = tasks?.length ?? 0;

  const stats = [
    { label: '活跃 Agent', value: String(onlineCount), sub: `${agents?.length ?? 0} 个总计` },
    { label: '今日任务', value: String(totalTasks), sub: `已完成 ${doneCount}` },
    { label: '消息总量', value: msgStats ? `${(msgStats.total / 1000).toFixed(1)}K` : '0', sub: '实时同步' },
    { label: '系统延迟', value: '12ms', sub: '网络正常' },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {stats.map((s) => (
        <div key={s.label} className="glass-panel p-3">
          <div className="text-[10px] mb-1" style={{ color: 'var(--text-muted)' }}>{s.label}</div>
          <div className="font-mono text-lg font-bold" style={{ color: 'var(--accent-amber)' }}>{s.value}</div>
          <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{s.sub}</div>
        </div>
      ))}
    </div>
  );
}

/* ─── Footer Links ─── */
function FooterLinks() {
  return (
    <div className="flex items-center justify-between py-2">
      <div className="flex items-center gap-4">
        {['GitHub', '文档', 'Discord', 'Twitter'].map((l) => (
          <a key={l} href="#" className="text-xs transition-colors hover:text-[var(--accent-caramel)]" style={{ color: 'var(--text-muted)' }}>{l}</a>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <span className="flex items-center gap-1.5 text-[10px]" style={{ color: 'var(--text-muted)' }}>
          <span className="w-1 h-1 rounded-full bg-[var(--success)]" />所有系统运行正常
        </span>
        <span className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>MIT License</span>
      </div>
    </div>
  );
}

/* ─── Main Dashboard ─── */
export default function Dashboard() {
  const { data: agents, isLoading: agentsLoading } = trpc.agent.list.useQuery();

  return (
    <div className="min-h-screen pt-14 pb-6 px-4 md:px-6 bg-grid" style={{ backgroundColor: 'var(--bg-primary)' }}>
      <div className="max-w-7xl mx-auto">
        {/* Top Row */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-4">
          <div className="lg:col-span-2 glass-panel p-6 flex items-center gap-6">
            <div className="flex-shrink-0 hidden sm:block">
              <RingText3D text="TIANGONG-AGENT-HUB-MESSAGING-PLATFORM-" radius={90} />
            </div>
            <div className="flex-1">
              <div className="section-label mb-2">TIANGONG DASHBOARD</div>
              <h1 className="text-2xl md:text-3xl font-bold mb-2" style={{ color: 'var(--text-primary)' }}>
                天宫 Agent 消息平台
              </h1>
              <p className="text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                多 Agent、多系统共用的统一消息中枢。像指挥交响乐团一样调度你的 AI 代理网络。
              </p>
              <div className="flex items-center gap-3 mt-4">
                <button className="px-4 py-2 rounded-lg text-xs font-medium transition-all"
                  style={{ background: 'var(--accent-dim)', color: 'var(--accent-caramel)', border: '1px solid rgba(212,148,58,0.25)' }}>
                  部署平台
                </button>
                <button className="px-4 py-2 rounded-lg text-xs transition-all hover:bg-white/5"
                  style={{ color: 'var(--text-secondary)', border: '1px solid var(--border-default)' }}>
                  查看文档 →
                </button>
              </div>
            </div>
          </div>
          <div className="flex flex-col gap-3">
            <LiveClock />
            <SystemMonitor />
          </div>
        </div>

        {/* Stats */}
        <div className="mb-4"><StatsRow /></div>

        {/* Agent Grid + Systems */}
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-4 mb-4">
          <div className="lg:col-span-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {agentsLoading ? (
              <div className="col-span-full glass-panel p-8 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
                加载 Agent 数据中...
              </div>
            ) : (
              agents?.map((agent) => <AgentCard key={agent.id} agent={agent} />)
            )}
          </div>
          <div className="lg:col-span-1">
            <ConnectionPanel />
          </div>
        </div>

        {/* Task Timeline */}
        <div className="mb-4">
          <TaskTimeline />
        </div>

        {/* Footer */}
        <div className="glass-panel px-4">
          <FooterLinks />
        </div>
      </div>
    </div>
  );
}
