import { useEffect, useRef } from 'react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);

const TASKS = [
  { number: '142', title: '数据清洗与结构化分析', agent: 'CEO-01', status: 'EXECUTING', progress: 78 },
  { number: '143', title: '用户行为路径建模', agent: 'CTO-02', status: 'SYNCING', progress: 45 },
  { number: '144', title: 'API 网关性能优化', agent: 'DEV-05', status: 'QUEUED', progress: 12 },
  { number: '145', title: '多语言内容本地化', agent: 'CMO-03', status: 'REVIEWING', progress: 92 },
  { number: '146', title: '安全审计日志分析', agent: 'QA-06', status: 'EXECUTING', progress: 63 },
];

export default function ExecutionCore() {
  const sectionRef = useRef<HTMLElement>(null);
  const cardsRef = useRef<HTMLDivElement[]>([]);
  const triggersRef = useRef<ScrollTrigger[]>([]);

  useEffect(() => {
    const ctx = gsap.context(() => {
      cardsRef.current.forEach((card) => {
        if (!card) return;
        const inner = card.querySelector('.task-inner') as HTMLElement;
        if (!inner) return;
        const tl = gsap.timeline({
          scrollTrigger: { trigger: card, start: 'top bottom', end: 'bottom top', scrub: true },
        });
        tl.fromTo(inner, { scale: 0.85, opacity: 0.2, filter: 'brightness(0.4) contrast(0.8)' },
          { scale: 1.02, opacity: 1, filter: 'brightness(1) contrast(1)', ease: 'power2.out' }, 0);
        tl.to(inner, { scale: 1.0, ease: 'power2.inOut' }, 0.3);
        tl.to(inner, { scale: 0.97, opacity: 0.5, filter: 'brightness(0.8) contrast(0.95)', ease: 'power2.in' }, 0.7);
        if (tl.scrollTrigger) triggersRef.current.push(tl.scrollTrigger);
      });
    }, sectionRef);
    return () => { triggersRef.current.forEach((st) => st.kill()); triggersRef.current = []; ctx.revert(); };
  }, []);

  const statusCfg: Record<string, { color: string; bg: string; label: string }> = {
    EXECUTING: { color: 'var(--accent-red)', bg: 'var(--accent-glow-red)', label: '执行中' },
    SYNCING: { color: 'var(--accent-cyan)', bg: 'rgba(74,158,255,0.1)', label: '同步中' },
    QUEUED: { color: 'var(--text-muted)', bg: 'rgba(180,200,255,0.03)', label: '队列中' },
    REVIEWING: { color: 'var(--accent-gold)', bg: 'var(--accent-glow-gold)', label: '审核中' },
  };

  return (
    <section ref={sectionRef} className="relative z-10 w-full py-4 px-4 md:px-6">
      <div className="max-w-7xl mx-auto">
        <div className="glass-panel p-5 sci-border">
          <div className="flex items-center justify-between mb-4">
            <div className="section-label">EXECUTION ENGINE · 执行引擎</div>
            <span className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>5 个活跃任务</span>
          </div>
          <div className="flex flex-col gap-3 max-w-2xl mx-auto">
            {TASKS.map((t, i) => {
              const cfg = statusCfg[t.status] || statusCfg.QUEUED;
              return (
                <div key={i} ref={(el) => { if (el) cardsRef.current[i] = el; }} className="w-full" style={{ transformOrigin: '0% 100%' }}>
                  <div className="task-inner p-4 rounded transition-all" style={{
                    background: i % 2 === 0
                      ? 'linear-gradient(135deg, rgba(194,58,48,0.04), rgba(0,0,0,0.2))'
                      : 'rgba(0,0,0,0.15)',
                    border: '1px solid var(--border-default)',
                  }}>
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1.5">
                          <span className="font-mono text-sm font-bold" style={{ color: 'var(--accent-gold)' }}>#{t.number}</span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded font-mono" style={{ background: cfg.bg, color: cfg.color }}>{cfg.label}</span>
                        </div>
                        <h3 className="text-sm font-bold truncate" style={{ color: 'var(--text-primary)' }}>{t.title}</h3>
                        <span className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>{t.agent}</span>
                      </div>
                      <div className="flex-shrink-0 w-20">
                        <div className="progress-track">
                          <div className="progress-fill" style={{ width: `${t.progress}%` }} />
                        </div>
                        <div className="text-right text-[10px] font-mono mt-1" style={{ color: 'var(--text-muted)' }}>{t.progress}%</div>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
