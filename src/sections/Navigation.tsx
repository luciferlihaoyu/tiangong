export default function Navigation() {
  const tabs = [
    { label: '全部', active: true },
    { label: '运行中', count: 5 },
    { label: '审核中', count: 2 },
    { label: '已归档', count: 0 },
  ];

  return (
    <nav className="fixed top-0 left-0 right-0 z-50 h-14 flex items-center justify-between px-6"
      style={{
        background: 'rgba(8, 12, 20, 0.88)',
        backdropFilter: 'blur(20px) saturate(150%)',
        borderBottom: '1px solid rgba(100, 180, 255, 0.08)',
      }}>
      {/* Left: Logo */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <div className="relative w-5 h-5">
            <div className="absolute inset-0 rounded-full border border-[#64b5f6]/50" />
            <div className="absolute inset-1 rounded-full bg-[#64b5f6]/60" style={{ boxShadow: '0 0 6px rgba(100,181,246,0.4)' }} />
          </div>
          <span className="font-bold text-sm tracking-wide" style={{ color: 'var(--text-primary)' }}>
            天宫
          </span>
        </div>
        <div className="h-4 w-px bg-[rgba(100,180,255,0.12)] mx-1" />
        <span className="section-label">v2.1.0</span>
      </div>

      {/* Center: Tabs */}
      <div className="hidden md:flex items-center gap-1">
        {tabs.map((tab) => (
          <button
            key={tab.label}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-all ${
              tab.active
                ? 'text-[var(--text-primary)]'
                : 'hover:text-[var(--text-secondary)]'
            }`}
            style={tab.active ? {
              background: 'rgba(100, 180, 255, 0.08)',
              boxShadow: 'inset 0 1px 0 rgba(100,180,255,0.1)',
            } : { color: 'var(--text-muted)' }}>
            {tab.label}
            {tab.count !== undefined && tab.count > 0 && (
              <span className="text-[10px] px-1 py-0.5 rounded"
                style={{ background: 'rgba(100,180,255,0.06)', color: 'var(--text-muted)' }}>
                {tab.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Right: Actions */}
      <div className="flex items-center gap-2">
        <span className="hidden sm:flex items-center gap-1.5 text-xs" style={{ color: 'var(--text-muted)' }}>
          <span className="status-dot status-dot-online" />
          系统正常
        </span>
        <div className="h-4 w-px bg-[rgba(100,180,255,0.1)] mx-1" />
        <button className="px-3 py-1.5 rounded-lg text-xs font-medium transition-all hover:brightness-110"
          style={{
            background: 'linear-gradient(135deg, rgba(33,150,243,0.15), rgba(100,181,246,0.1))',
            color: '#64b5f6',
            border: '1px solid rgba(100, 181, 246, 0.2)',
            boxShadow: '0 0 12px rgba(100,181,246,0.08)',
          }}>
          + 新建任务
        </button>
      </div>
    </nav>
  );
}
