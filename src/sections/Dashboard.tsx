import { useEffect, useState } from 'react';

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
            style={{
              transform: `rotateY(${i * angleStep}deg) translateZ(${radius}px)`,
            }}
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
  const timeStr = `${pad(time.getHours())}:${pad(time.getMinutes())}:${pad(time.getSeconds())}`;
  const dateStr = `${time.getFullYear()}.${pad(time.getMonth() + 1)}.${pad(time.getDate())}`;

  return (
    <div className="glass-panel p-4">
      <div className="section-label mb-2">系统时间</div>
      <div className="font-mono text-2xl font-bold tracking-wider" style={{ color: 'var(--accent-amber)' }}>
        {timeStr}
      </div>
      <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>{dateStr}</div>
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
              <div
                className="progress-fill transition-all duration-700"
                style={{ width: `${b.value}%`, background: b.color }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─── Agent Card ─── */
interface AgentData {
  id: string;
  name: string;
  system: string;
  status: 'online' | 'busy' | 'idle';
  task: string;
  progress: number;
  messages: number;
}

const AGENTS: AgentData[] = [
  { id: 'AG-01', name: 'CEO-01', system: 'Claude', status: 'online', task: '策略规划与目标对齐', progress: 78, messages: 142 },
  { id: 'AG-02', name: 'CTO-02', system: 'Codex', status: 'busy', task: '代码审查与架构评审', progress: 45, messages: 89 },
  { id: 'AG-03', name: 'CMO-03', system: 'Cursor', status: 'online', task: '用户增长数据分析', progress: 92, messages: 203 },
  { id: 'AG-04', name: 'COO-04', system: 'Claude', status: 'idle', task: '资源调度与成本控制', progress: 0, messages: 56 },
  { id: 'AG-05', name: 'DEV-05', system: 'GPT-4', status: 'busy', task: 'API网关部署 v2.1.0', progress: 63, messages: 178 },
  { id: 'AG-06', name: 'QA-06', system: 'Claude', status: 'online', task: '端到端自动化测试', progress: 34, messages: 67 },
];

function AgentCard({ agent }: { agent: AgentData }) {
  const statusConfig = {
    online: { dot: 'status-dot-online', label: '在线', color: '#5BA86C' },
    busy: { dot: 'status-dot-busy', label: '忙碌', color: '#D4943A' },
    idle: { dot: 'status-dot-idle', label: '空闲', color: 'var(--text-muted)' },
  };
  const cfg = statusConfig[agent.status];

  return (
    <div className="glass-panel p-4 hover:border-[var(--border-hover)] transition-all cursor-default">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className={`status-dot ${cfg.dot}`} />
          <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
            {agent.name}
          </span>
        </div>
        <span className="font-mono text-[10px] px-1.5 py-0.5 rounded"
          style={{ background: 'rgba(255,255,255,0.04)', color: 'var(--text-muted)' }}>
          {agent.id}
        </span>
      </div>

      <div className="flex items-center gap-1.5 mb-2">
        <span className="text-[10px] px-1.5 py-0.5 rounded"
          style={{ background: 'var(--accent-dim)', color: 'var(--accent-caramel)' }}>
          {agent.system}
        </span>
        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
          {agent.messages} 消息
        </span>
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
  const systems = [
    { name: 'Slack', status: 'connected', icon: 'S' },
    { name: 'Email', status: 'connected', icon: 'E' },
    { name: 'Webhook', status: 'connected', icon: 'W' },
    { name: 'GitHub', status: 'syncing', icon: 'G' },
    { name: 'Jira', status: 'connected', icon: 'J' },
    { name: 'Notion', status: 'disconnected', icon: 'N' },
  ];

  const statusColor = {
    connected: 'var(--success)',
    syncing: 'var(--warning)',
    disconnected: 'var(--text-muted)',
  };

  return (
    <div className="glass-panel p-4">
      <div className="section-label mb-3">系统接入</div>
      <div className="flex flex-col gap-2">
        {systems.map((s) => (
          <div key={s.name} className="flex items-center justify-between py-1">
            <div className="flex items-center gap-2">
              <span className="w-5 h-5 rounded flex items-center justify-center text-[10px] font-bold"
                style={{ background: 'rgba(255,255,255,0.05)', color: 'var(--text-secondary)' }}>
                {s.icon}
              </span>
              <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>{s.name}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: statusColor[s.status as keyof typeof statusColor] }} />
              <span className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>
                {s.status === 'connected' ? '已连接' : s.status === 'syncing' ? '同步中' : '断开'}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─── Task Timeline ─── */
function TaskTimeline() {
  const tasks = [
    { id: '#142', name: '数据清洗与结构化分析', agent: 'CEO-01', time: '2m 前', status: 'running' as const },
    { id: '#143', name: '用户行为路径建模', agent: 'CTO-02', time: '5m 前', status: 'running' as const },
    { id: '#144', name: 'API 网关性能优化', agent: 'DEV-05', time: '8m 前', status: 'pending' as const },
    { id: '#145', name: '多语言内容本地化', agent: 'CMO-03', time: '12m 前', status: 'done' as const },
    { id: '#146', name: '安全审计日志分析', agent: 'QA-06', time: '15m 前', status: 'running' as const },
    { id: '#147', name: '智能推荐算法调优', agent: 'CTO-02', time: '20m 前', status: 'pending' as const },
    { id: '#148', name: '数据库索引优化', agent: 'DEV-05', time: '25m 前', status: 'done' as const },
  ];

  const statusIcon = {
    running: <span className="status-dot status-dot-busy" />,
    pending: <span className="status-dot status-dot-idle" />,
    done: <span className="status-dot status-dot-online" />,
  };

  return (
    <div className="glass-panel p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="section-label">任务时间线</div>
        <span className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>
          7 个活跃任务
        </span>
      </div>
      <div className="flex flex-col gap-0 max-h-[200px] overflow-y-auto custom-scrollbar pr-1">
        {tasks.map((t) => (
          <div key={t.id}
            className="flex items-center gap-3 py-2 border-t border-white/5 first:border-t-0 transition-colors hover:bg-white/[0.02] rounded px-1">
            <div className="flex-shrink-0">{statusIcon[t.status]}</div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-mono text-[10px]" style={{ color: 'var(--accent-caramel)' }}>{t.id}</span>
                <span className="text-xs truncate" style={{ color: 'var(--text-secondary)' }}>{t.name}</span>
              </div>
            </div>
            <div className="flex-shrink-0 text-right">
              <span className="text-[10px] block" style={{ color: 'var(--text-muted)' }}>{t.agent}</span>
              <span className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>{t.time}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─── Stats Row ─── */
function StatsRow() {
  const stats = [
    { label: '活跃 Agent', value: '6', sub: '2 个忙碌中' },
    { label: '今日任务', value: '142', sub: '已完成 89' },
    { label: '消息总量', value: '12.3K', sub: '实时同步' },
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
  const links = [
    { label: 'GitHub', url: '#' },
    { label: '文档', url: '#' },
    { label: 'Discord', url: '#' },
    { label: 'Twitter', url: '#' },
  ];

  return (
    <div className="flex items-center justify-between py-2">
      <div className="flex items-center gap-4">
        {links.map((l) => (
          <a key={l.label} href={l.url}
            className="text-xs transition-colors hover:text-[var(--accent-caramel)]"
            style={{ color: 'var(--text-muted)' }}>
            {l.label}
          </a>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <span className="flex items-center gap-1.5 text-[10px]" style={{ color: 'var(--text-muted)' }}>
          <span className="w-1 h-1 rounded-full bg-[var(--success)]" />
          所有系统运行正常
        </span>
        <span className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>
          MIT License
        </span>
      </div>
    </div>
  );
}

/* ─── Main Dashboard ─── */
export default function Dashboard() {
  return (
    <div className="min-h-screen pt-14 pb-6 px-4 md:px-6 bg-grid"
      style={{ backgroundColor: 'var(--bg-primary)' }}>

      <div className="max-w-7xl mx-auto">
        {/* Top Row: Title + Clock + Monitor */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-4">
          {/* Left: Title + Ring Text */}
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
                多 Agent、多系统共用的统一消息中枢。像指挥交响乐团一样调度你的 AI 代理网络——任务追踪、全链路审计、成本控制，尽在天宫。
              </p>
              <div className="flex items-center gap-3 mt-4">
                <button className="px-4 py-2 rounded-lg text-xs font-medium transition-all"
                  style={{
                    background: 'var(--accent-dim)',
                    color: 'var(--accent-caramel)',
                    border: '1px solid rgba(212, 148, 58, 0.25)',
                  }}>
                  部署平台
                </button>
                <button className="px-4 py-2 rounded-lg text-xs transition-all hover:bg-white/5"
                  style={{ color: 'var(--text-secondary)', border: '1px solid var(--border-default)' }}>
                  查看文档 →
                </button>
              </div>
            </div>
          </div>

          {/* Right: Clock + Monitor */}
          <div className="flex flex-col gap-3">
            <LiveClock />
            <SystemMonitor />
          </div>
        </div>

        {/* Stats Row */}
        <div className="mb-4">
          <StatsRow />
        </div>

        {/* Middle Row: Agent Grid + Connection Panel */}
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-4 mb-4">
          {/* Agent Cards - takes 3 cols */}
          <div className="lg:col-span-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {AGENTS.map((agent) => (
              <AgentCard key={agent.id} agent={agent} />
            ))}
          </div>

          {/* Connection Panel */}
          <div className="lg:col-span-1">
            <ConnectionPanel />
          </div>
        </div>

        {/* Bottom Row: Task Timeline */}
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
