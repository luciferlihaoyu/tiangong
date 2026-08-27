import { useEffect, useMemo, useRef } from 'react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { trpc } from '@/providers/trpc';

gsap.registerPlugin(ScrollTrigger);

/** 视为「活跃」的任务状态（task.status 枚举：running/pending/done/failed/queued）。 */
const ACTIVE_STATUSES = new Set(['running', 'queued', 'executing', 'pending']);

/** 看板展示状态 ← task.status / boardStatus 映射。 */
function toDisplayStatus(t: { status: string; boardStatus?: string | null }): string {
  if (t.boardStatus === 'review') return 'REVIEWING';
  if (t.status === 'running' || t.status === 'executing') return 'EXECUTING';
  if (t.status === 'queued') return 'QUEUED';
  return 'SYNCING'; // pending 等
}

interface TaskRow {
  id: number;
  taskId: string;
  name: string;
  agentId: number | null;
  status: string;
  progress: number | null;
  createdAt?: string | Date | null;
  boardStatus?: string | null;
}

export default function ExecutionCore() {
  const sectionRef = useRef<HTMLElement>(null);
  const cardsRef = useRef<HTMLDivElement[]>([]);
  const triggersRef = useRef<ScrollTrigger[]>([]);

  const tasksQuery = trpc.taskboard.list.useQuery(undefined, { staleTime: 30000 });
  const agentsQuery = trpc.agent.list.useQuery(undefined, { staleTime: 30000 });

  const agentNameById = useMemo(() => {
    const map = new Map<number, string>();
    for (const a of agentsQuery.data ?? []) map.set(a.id, a.agentId || a.name);
    return map;
  }, [agentsQuery.data]);

  // 最近 5 条活跃任务，按创建时间倒序
  const activeTasks = useMemo<TaskRow[]>(() => {
    const ts = (v: TaskRow['createdAt']) => (v ? new Date(v).getTime() || 0 : 0);
    return ((tasksQuery.data ?? []) as TaskRow[])
      .filter((t) => ACTIVE_STATUSES.has(t.status))
      .sort((a, b) => ts(b.createdAt) - ts(a.createdAt))
      .slice(0, 5);
  }, [tasksQuery.data]);

  const cardCount = activeTasks.length;

  useEffect(() => {
    if (cardCount === 0) return;
    const cards = cardsRef.current.slice(0, cardCount);
    const ctx = gsap.context(() => {
      cards.forEach((card) => {
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
  }, [cardCount]);

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
            <span className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>{cardCount} 个活跃任务</span>
          </div>
          {cardCount === 0 ? (
            <div className="py-8 text-center text-[11px] font-mono" style={{ color: 'var(--text-muted)' }}>
              暂无活跃任务
            </div>
          ) : (
            <div className="flex flex-col gap-3 max-w-2xl mx-auto">
              {activeTasks.map((t, i) => {
                const displayStatus = toDisplayStatus(t);
                const cfg = statusCfg[displayStatus] || statusCfg.QUEUED;
                const progress = t.progress ?? 0;
                const agent = (t.agentId != null && agentNameById.get(t.agentId)) || 'UNASSIGNED';
                return (
                  <div key={t.id} ref={(el) => { if (el) cardsRef.current[i] = el; }} className="w-full" style={{ transformOrigin: '0% 100%' }}>
                    <div className="task-inner p-4 rounded transition-all" style={{
                      background: i % 2 === 0
                        ? 'linear-gradient(135deg, rgba(194,58,48,0.04), rgba(0,0,0,0.2))'
                        : 'rgba(0,0,0,0.15)',
                      border: '1px solid var(--border-default)',
                    }}>
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1.5">
                            <span className="font-mono text-sm font-bold" style={{ color: 'var(--accent-gold)' }}>#{t.taskId}</span>
                            <span className="text-[10px] px-1.5 py-0.5 rounded font-mono" style={{ background: cfg.bg, color: cfg.color }}>{cfg.label}</span>
                          </div>
                          <h3 className="text-sm font-bold truncate" style={{ color: 'var(--text-primary)' }}>{t.name}</h3>
                          <span className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>{agent}</span>
                        </div>
                        <div className="flex-shrink-0 w-20">
                          <div className="progress-track">
                            <div className="progress-fill" style={{ width: `${progress}%` }} />
                          </div>
                          <div className="text-right text-[10px] font-mono mt-1" style={{ color: 'var(--text-muted)' }}>{progress}%</div>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
