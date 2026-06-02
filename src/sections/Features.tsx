import { useEffect, useRef } from 'react';

const FEATURES = [
  { tag: 'ORG', title: '组织架构管理', desc: '层级、角色、汇报线。像管理真实团队一样管理 AI Agent。', metric: '无限层级' },
  { tag: 'GOAL', title: '目标对齐系统', desc: '每个任务追溯到公司使命，Agent 知道做什么更知道为什么。', metric: '100% 可追溯' },
  { tag: 'COST', title: '成本控制中心', desc: '月度预算，超支自动停止。追踪每个 Agent 每个任务的消耗。', metric: '零意外账单' },
  { tag: 'GOVT', title: '治理与审批', desc: '审批招聘、覆盖策略、暂停或终止 Agent。权限门控强制执行。', metric: '零权限滥用' },
  { tag: 'HB', title: '心跳调度执行', desc: '定时任务自动触发，客户支持、社媒、报告——全部自动化。', metric: '24/7 运行' },
  { tag: 'PORT', title: '模板可移植', desc: '导出/导入组织架构和配置。密钥脱敏，一次配置处处复用。', metric: '一键迁移' },
];

export default function Features() {
  const cardsRef = useRef<HTMLDivElement[]>([]);
  useEffect(() => {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          const el = entry.target as HTMLElement;
          el.style.opacity = '1';
          el.style.transform = 'translateY(0)';
          observer.unobserve(el);
        }
      });
    }, { threshold: 0.1 });
    cardsRef.current.forEach((c) => c && observer.observe(c));
    return () => observer.disconnect();
  }, []);

  return (
    <section className="relative z-10 w-full py-4 px-4 md:px-6">
      <div className="max-w-7xl mx-auto">
        <div className="glass-panel p-5 sci-border">
          <div className="section-label mb-4">PLATFORM CAPABILITIES · 平台能力</div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {FEATURES.map((f, i) => (
              <div key={i}
                ref={(el) => { if (el) cardsRef.current[i] = el; }}
                className="p-4 rounded transition-all duration-500 hover:bg-[rgba(180,200,255,0.02)]"
                style={{
                  border: '1px solid var(--border-default)',
                  opacity: 0,
                  transform: 'translateY(16px)',
                  transitionDelay: `${i * 80}ms`,
                }}>
                <div className="flex items-center gap-2 mb-2">
                  <span className="font-mono text-[10px] px-1.5 py-0.5 rounded"
                    style={{ background: 'var(--accent-glow-red)', color: 'var(--accent-red-bright)' }}>
                    {f.tag}
                  </span>
                  <span className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>{f.metric}</span>
                </div>
                <h3 className="text-sm font-bold mb-1" style={{ color: 'var(--text-primary)' }}>{f.title}</h3>
                <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
