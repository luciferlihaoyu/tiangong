import { useLocation, useNavigate } from 'react-router';
import { useTheme } from '@/hooks/useTheme';
import { useVersion } from '@/hooks/useVersion';
import { useAuth } from '@/hooks/useAuth';
import { useWebSocket } from '@/hooks/useWebSocket';
import {
  LayoutDashboard,
  BarChart3,
  Radio,
  Bot,
  ClipboardList,
  Layout,
  GitBranch,
  DollarSign,
  Shield,
  Zap,
  Github,
  Mail,
  MessageSquare,
  Scale,
  Settings,
  User,
  LogOut,
} from 'lucide-react';

function SunIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="5" /><line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
      <line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" />
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

/* ── 导航分组定义 ── */
interface NavItem {
  path: string;
  label: string;
  icon: React.ReactNode;
}

interface NavGroup {
  title: string;
  items: NavItem[];
}

const navGroups: NavGroup[] = [
  {
    title: '监控',
    items: [
      { path: '/', label: '仪表盘', icon: <LayoutDashboard size={15} /> },
      { path: '/usage', label: '用量', icon: <BarChart3 size={15} /> },
      { path: '/events', label: '事件流', icon: <Radio size={15} /> },
    ],
  },
  {
    title: '管理',
    items: [
      { path: '/task-center', label: 'Agent', icon: <Bot size={15} /> },
      { path: '/missions', label: '任务', icon: <ClipboardList size={15} /> },
      { path: '/taskboard', label: '任务板', icon: <Layout size={15} /> },
      { path: '/dag', label: 'DAG', icon: <GitBranch size={15} /> },
    ],
  },
  {
    title: '系统',
    items: [
      { path: '/pricing', label: '定价', icon: <DollarSign size={15} /> },
      { path: '/guard', label: '熔断', icon: <Shield size={15} /> },
      { path: '/ops', label: 'Ops', icon: <Zap size={15} /> },
      { path: '/github', label: 'GitHub', icon: <Github size={15} /> },
    ],
  },
  {
    title: '工具',
    items: [
      { path: '/mailbox', label: '消息', icon: <Mail size={15} /> },
      { path: '/sessions', label: '会话', icon: <MessageSquare size={15} /> },
      { path: '/fusion', label: '审查', icon: <Scale size={15} /> },
    ],
  },
];

const SIDEBAR_WIDTH = 220;
const TOPBAR_HEIGHT = 48;

/* ── TopBar ── */
function TopBar() {
  const navigate = useNavigate();
  const { theme, toggle } = useTheme();
  const { data: version } = useVersion();
  const { user, isAuthenticated, logout } = useAuth();

  return (
    <header
      className="fixed top-0 left-0 right-0 z-50 flex items-center justify-between px-4"
      style={{
        height: TOPBAR_HEIGHT,
        background: theme === 'dark' ? 'rgba(5, 5, 8, 0.95)' : 'rgba(236, 238, 243, 0.95)',
        backdropFilter: 'blur(20px) saturate(150%)',
        borderBottom: '1px solid var(--border-default)',
        transition: 'background 0.5s ease',
      }}
    >
      {/* Left: Logo */}
      <div className="flex items-center gap-3">
        <button onClick={() => navigate('/')} className="flex items-center gap-2 cursor-pointer hover:opacity-80 transition-opacity" title="返回首页">
          <div
            className="relative w-6 h-6 flex items-center justify-center rounded-sm"
            style={{
              background: 'var(--accent-red)',
              boxShadow: '0 0 8px rgba(194, 58, 48, 0.4)',
            }}
          >
            <span className="text-white text-[9px] font-black tracking-tighter">天宫</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="font-black text-sm tracking-widest" style={{ color: 'var(--text-primary)' }}>
              天宫
            </span>
            <span className="text-[9px] tracking-wider" style={{ color: 'var(--accent-gold)' }}>
              TIANGONG
            </span>
          </div>
        </button>
        <div className="h-3 w-px" style={{ background: 'var(--border-default)' }} />
        <span className="font-mono text-[10px] tracking-wider hidden sm:inline" style={{ color: 'var(--text-muted)' }} title={version?.commit || 'unknown'}>
          v{version?.version || '...'}
          {version?.shortCommit && (
            <span className="ml-1 text-[8px] opacity-60">({version.shortCommit})</span>
          )}
        </span>
      </div>

      {/* Right: User + Theme */}
      <div className="flex items-center gap-3">
        <button onClick={toggle} className="theme-toggle p-1.5 rounded hover:bg-[rgba(180,200,255,0.04)] transition-colors" title={theme === 'dark' ? '切换亮色' : '切换暗色'}>
          {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
        </button>

        {isAuthenticated && user ? (
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-mono px-2 py-1 rounded hidden sm:inline-flex items-center gap-1" style={{ background: 'var(--accent-glow-gold)', color: 'var(--accent-gold)' }}>
              <User size={10} />
              {user.name || user.username || '管理员'}
            </span>
            <button
              onClick={() => navigate('/account')}
              className="p-1.5 rounded hover:bg-[rgba(180,200,255,0.04)] transition-colors"
              title="账户设置"
              style={{ color: 'var(--text-muted)' }}
            >
              <Settings size={14} />
            </button>
            <button
              onClick={logout}
              className="p-1.5 rounded hover:bg-[rgba(180,200,255,0.04)] transition-colors"
              title="退出登录"
              style={{ color: 'var(--text-muted)' }}
            >
              <LogOut size={14} />
            </button>
          </div>
        ) : (
          <button
            onClick={() => navigate('/login')}
            className="text-[10px] font-mono px-2 py-1 rounded hover:bg-[rgba(180,200,255,0.04)] transition-colors"
            style={{ color: 'var(--text-muted)', border: '1px solid var(--border-default)' }}
          >
            登录
          </button>
        )}
      </div>
    </header>
  );
}

/* ── Sidebar ── */
function Sidebar() {
  const location = useLocation();
  const navigate = useNavigate();
  const { connected: wsConnected } = useWebSocket();

  const isActive = (path: string) => {
    if (path === '/') {
      return location.pathname === '/' || location.pathname === '/index.html';
    }
    return location.pathname === path;
  };

  return (
    <aside
      className="fixed left-0 z-40 flex flex-col"
      style={{
        top: TOPBAR_HEIGHT,
        width: SIDEBAR_WIDTH,
        bottom: 0,
        background: 'rgba(5, 5, 8, 0.95)',
        borderRight: '1px solid var(--border-default)',
        backdropFilter: 'blur(12px)',
      }}
    >
      {/* Navigation Groups */}
      <nav className="flex-1 overflow-y-auto custom-scrollbar py-3 px-2">
        {navGroups.map((group) => (
          <div key={group.title} className="mb-4">
            <div
              className="px-3 py-1.5 text-[10px] font-mono font-bold tracking-[0.15em] uppercase"
              style={{ color: 'var(--text-muted)' }}
            >
              {group.title}
            </div>
            <div className="flex flex-col gap-0.5">
              {group.items.map((item) => {
                const active = isActive(item.path);
                return (
                  <button
                    key={item.path}
                    onClick={() => navigate(item.path)}
                    className="flex items-center gap-2.5 px-3 py-2 rounded text-xs font-medium transition-all text-left"
                    style={{
                      background: active ? 'var(--accent-glow-red)' : 'transparent',
                      color: active ? 'var(--accent-red-bright)' : 'var(--text-secondary)',
                      borderLeft: active ? '2px solid var(--accent-red)' : '2px solid transparent',
                    }}
                  >
                    <span
                      style={{
                        color: active ? 'var(--accent-red-bright)' : 'var(--text-muted)',
                      }}
                    >
                      {item.icon}
                    </span>
                    <span>{item.label}</span>
                    {active && (
                      <span className="ml-auto w-1 h-1 rounded-full" style={{ background: 'var(--accent-red)' }} />
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* Bottom Status */}
      <div
        className="px-3 py-2.5 flex items-center gap-2"
        style={{
          borderTop: '1px solid var(--border-default)',
        }}
      >
        <span
          className="w-2 h-2 rounded-full flex-shrink-0"
          style={{
            background: wsConnected ? 'var(--success)' : 'var(--accent-red)',
            boxShadow: wsConnected ? '0 0 6px var(--success)' : '0 0 6px var(--accent-red)',
          }}
        />
        <span className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>
          {wsConnected ? '系统在线' : '连接断开'}
        </span>
      </div>
    </aside>
  );
}

/* ── Layout Export ── */
export function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative min-h-screen" style={{ backgroundColor: 'var(--bg-primary)' }}>
      <TopBar />
      <Sidebar />
      <main
        className="relative"
        style={{
          marginLeft: SIDEBAR_WIDTH,
          paddingTop: TOPBAR_HEIGHT,
          minHeight: '100vh',
        }}
      >
        {children}
      </main>
    </div>
  );
}

/* ── Legacy default export for direct use (if any) ── */
export default function Navigation() {
  return null;
}
