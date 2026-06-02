import { useState } from 'react';

const FAQS = [
  { q: '天宫与直接用 OpenClaw 有什么区别？', a: 'OpenClaw 是员工，天宫是公司。天宫提供完整的组织架构、工单系统、委托机制、治理和成本控制——让你运营一家公司，而不是一堆脚本。' },
  { q: '我可以使用哪些 Agent？', a: '任何 Agent、任何运行时、一个组织架构。你的 Claude、Cursor、Codex 都可以在天宫下统一管理。只要它能接收心跳信号，就能被聘用。' },
  { q: '如何控制成本？', a: '每个 Agent 都有月度预算，达到上限时自动停止。系统追踪每个 Agent、每个任务、每个项目的 token 消耗，杜绝意外账单。' },
  { q: '支持多公司/多团队吗？', a: '完全支持。每个实体按公司范围隔离，一次部署可运行多个公司，数据和审计轨迹完全独立。' },
  { q: '任务如何执行？', a: '通过心跳机制定期调度。Agent 在收到心跳时继续同一任务的上下文，而不是从头开始。任务带有完整的目标血统。' },
  { q: '数据安全吗？', a: '天宫是开源且支持自托管的。所有数据存储在你自己的基础设施上，完整的审计日志和不可变的操作记录确保每个决策都可追溯。' },
];

export default function FAQ() {
  const [openIndex, setOpenIndex] = useState<number | null>(0);

  return (
    <section className="relative w-full py-4 px-4 md:px-6" style={{ backgroundColor: 'var(--bg-primary)' }}>
      <div className="max-w-3xl mx-auto">
        <div className="glass-panel p-5">
          <div className="section-label mb-4">FREQUENTLY ASKED QUESTIONS</div>
          <div className="flex flex-col gap-2">
            {FAQS.map((faq, idx) => (
              <div key={idx}
                className="rounded-lg overflow-hidden transition-all"
                style={{ border: '1px solid', borderColor: openIndex === idx ? 'var(--border-hover)' : 'var(--border-default)' }}>
                <button onClick={() => setOpenIndex(openIndex === idx ? null : idx)}
                  className="w-full flex items-center justify-between p-3.5 text-left hover:bg-[rgba(100,180,255,0.02)] transition-colors">
                  <span className="text-sm pr-4" style={{ color: 'var(--text-primary)' }}>{faq.q}</span>
                  <span className="flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-xs transition-transform duration-300"
                    style={{
                      background: openIndex === idx ? 'rgba(100,181,246,0.1)' : 'rgba(100,180,255,0.04)',
                      color: openIndex === idx ? '#64b5f6' : 'var(--text-muted)',
                      transform: openIndex === idx ? 'rotate(45deg)' : 'rotate(0deg)',
                    }}>+</span>
                </button>
                <div className="overflow-hidden transition-all duration-400"
                  style={{ maxHeight: openIndex === idx ? '200px' : '0px', opacity: openIndex === idx ? 1 : 0 }}>
                  <div className="px-3.5 pb-3.5">
                    <p className="text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>{faq.a}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
