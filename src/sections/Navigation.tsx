import { useNavigate } from 'react-router';
import { useTheme } from '@/hooks/useTheme';

function SunIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="5" /><line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
      <line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" />
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

export default function Navigation() {
  const navigate = useNavigate();
  const { theme, toggle } = useTheme();
  const tabs = [
    { label: '全部', active: true },
    { label: '运行中', count: 5 },
    { label: '审核中', count: 2 },
    { label: '已归档', count: 0 },
  ];

  return (
    <nav className="fixed top-0 left-0 right-0 z-50 h-14 flex items-center justify-between px-6"
      style={{
        background: theme === 'dark' ? 'rgba(5, 5, 8, 0.9)' : 'rgba(236, 238, 243, 0.9)',
        backdropFilter: 'blur(20px) saturate(150%)',
        borderBottom: '1px solid var(--border-default)',
        transition: 'background 0.5s ease',
      }}>
      {/* Left: Logo + 中式印章 */}
      <div className="flex items-center gap-3">
        <button onClick={() => navigate('/')} className="flex items-center gap-2.5 cursor-pointer hover:opacity-80 transition-opacity" title="返回首页">
          {/* 中式印章Logo */}
          <div className="relative w-7 h-7 flex items-center justify-center rounded-sm"
            style={{
              background: 'var(--accent-red)',
              boxShadow: '0 0 8px rgba(194, 58, 48, 0.4)',
            }}>
            <span className="text-white text-[10px] font-black tracking-tighter">天宫</span>
          </div>
          <div>
            <span className="font-black text-sm tracking-widest" style={{ color: 'var(--text-primary)' }}>
              天宫
            </span>
            <span className="text-[9px] ml-1.5 tracking-wider" style={{ color: 'var(--accent-gold)' }}>
              TIANGONG
            </span>
          </div>
        </button>
        <div className="h-4 w-px" style={{ background: 'var(--border-default)' }} />
        <span className="font-mono text-[10px] tracking-wider" style={{ color: 'var(--text-muted)' }}>v2.1.0</span>
      </div>

      {/* Center: Tabs */}
      <div className="hidden md:flex items-center gap-1">
        {tabs.map((tab) => (
          <button key={tab.label}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs transition-all"
            style={{
              background: tab.active ? 'var(--accent-glow-red)' : 'transparent',
              color: tab.active ? 'var(--accent-red-bright)' : 'var(--text-muted)',
              border: tab.active ? '1px solid rgba(194, 58, 48, 0.2)' : '1px solid transparent',
            }}>
            {tab.label}
            {tab.count !== undefined && tab.count > 0 && (
              <span className="text-[9px] px-1 py-0.5 rounded font-mono"
                style={{ background: 'var(--accent-glow-gold)', color: 'var(--accent-gold)' }}>
                {tab.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Right: Actions */}
      <div className="flex items-center gap-3">
        <span className="hidden sm:flex items-center gap-1.5 text-xs" style={{ color: 'var(--text-muted)' }}>
          <span className="status-dot status-dot-online" />
          系统正常
        </span>

        {/* 账户设置 */}
        <button onClick={() => navigate('/account')} className="text-xs font-mono px-2 py-1 rounded hover:bg-[rgba(180,200,255,0.04)] transition-colors" style={{ color: 'var(--text-muted)', border: '1px solid var(--border-default)' }} title="账户设置">
          ⚙️
        </button>

        {/* 主题切换 */}
        <button onClick={toggle} className="theme-toggle" title={theme === 'dark' ? '切换亮色' : '切换暗色'}>
          {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
        </button>

        <div className="h-4 w-px" style={{ background: 'var(--border-default)' }} />

        {/* 新建任务按钮 */}
        <button className="px-3 py-1.5 rounded text-xs font-bold tracking-wide transition-all hover:brightness-110"
          style={{
            background: 'var(--accent-red)',
            color: '#fff',
            boxShadow: '0 0 12px rgba(194, 58, 48, 0.25)',
          }}>
          + 新建任务
        </button>
      </div>
    </nav>
  );
}
