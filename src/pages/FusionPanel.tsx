/**
 * P10.1: Fusion 审查面板
 *
 * 功能：
 * - 提交审查请求
 * - 查看审查状态
 * - 查看审查结果 + Judge 裁决
 */
import { useState } from "react";
import { trpc } from "@/providers/trpc";
import {
  Scale,
  CheckCircle2,
  XCircle,
  Clock,
  AlertTriangle,
  Lightbulb,
  Eye,
  EyeOff,
  RefreshCw,
  Send,
  Users,
  FileText,
} from "lucide-react";

/* ═══════════════════════════════════════════
   类型定义
   ═══════════════════════════════════════════ */

interface ReviewResult {
  reviewerId: number;
  reviewerName: string;
  reviewerModel: string;
  consensus: string[];
  conflicts: string[];
  risks: string[];
  suggestions: string[];
  confidence: number;
  rawOutput: string;
  completedAt: string;
}

interface JudgeResult {
  consensus: string[];
  conflicts: string[];
  coverageGaps: string[];
  uniqueInsights: string[];
  blindSpots: string[];
  riskAssessment: string;
  recommendedActions: string[];
  finalVerdict: string;
  confidence: number;
  generatedAt: string;
}

interface FusionStatus {
  traceId: string;
  status: string;
  reviewerCount: number;
  reviewCompleted: number;
  judgeCompleted: boolean;
  reviews: ReviewResult[];
  judge: JudgeResult | null;
}

interface FusionListItem {
  traceId: string;
  subject: string;
  status: string;
  createdAt: string;
}

/* ═══════════════════════════════════════════
   辅助函数
   ═══════════════════════════════════════════ */

function fmtDateTime(iso: string) {
  const d = new Date(iso);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function StatusBadge({ status }: { status: string }) {
  const config: Record<string, { color: string; icon: React.ReactNode; label: string }> = {
    pending: { color: "var(--text-muted)", icon: <Clock size={12} />, label: "待审查" },
    reviewing: { color: "var(--accent-gold)", icon: <Eye size={12} />, label: "审查中" },
    completed: { color: "var(--success)", icon: <CheckCircle2 size={12} />, label: "已完成" },
  };
  const c = config[status] || config.pending;
  return (
    <span
      className="inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded"
      style={{ background: `${c.color}15`, color: c.color, border: `1px solid ${c.color}30` }}
    >
      {c.icon} {c.label}
    </span>
  );
}

/* ═══════════════════════════════════════════
   子组件
   ═══════════════════════════════════════════ */

function ReviewCard({ review, index }: { review: ReviewResult; index: number }) {
  const [expanded, setExpanded] = useState(false);

  const sections = [
    { label: "共识点", items: review.consensus, color: "var(--success)", icon: <CheckCircle2 size={12} /> },
    { label: "分歧点", items: review.conflicts, color: "var(--danger)", icon: <XCircle size={12} /> },
    { label: "风险点", items: review.risks, color: "var(--danger)", icon: <AlertTriangle size={12} /> },
    { label: "改进建议", items: review.suggestions, color: "var(--accent-cyan)", icon: <Lightbulb size={12} /> },
  ];

  return (
    <div
      className="p-3 rounded text-xs"
      style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)" }}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <Users size={14} style={{ color: "var(--accent-cyan)" }} />
          <span className="font-bold font-mono" style={{ color: "var(--text-primary)" }}>
            {review.reviewerName}
          </span>
          <span className="text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>
            {review.reviewerModel}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono" style={{ color: "var(--accent-gold)" }}>
            置信度: {(review.confidence * 100).toFixed(0)}%
          </span>
          <button
            onClick={() => setExpanded(!expanded)}
            className="p-1 rounded hover:bg-[rgba(255,255,255,0.05)]"
            style={{ color: "var(--text-muted)" }}
          >
            {expanded ? <EyeOff size={12} /> : <Eye size={12} />}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="space-y-2">
          {sections.map((s) =>
            s.items.length > 0 ? (
              <div key={s.label}>
                <div className="flex items-center gap-1 mb-1 text-[10px] font-mono" style={{ color: s.color }}>
                  {s.icon} {s.label}
                </div>
                <ul className="space-y-0.5 ml-4">
                  {s.items.map((item, i) => (
                    <li key={i} className="text-[10px]" style={{ color: "var(--text-secondary)" }}>
                      • {item}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null
          )}
          <div className="text-[9px] font-mono" style={{ color: "var(--text-muted)" }}>
            完成于 {fmtDateTime(review.completedAt)}
          </div>
        </div>
      )}
    </div>
  );
}

function JudgeCard({ judge }: { judge: JudgeResult }) {
  const [expanded, setExpanded] = useState(true);

  const sections = [
    { label: "最终共识", items: judge.consensus, color: "var(--success)", icon: <CheckCircle2 size={12} /> },
    { label: "主要分歧", items: judge.conflicts, color: "var(--danger)", icon: <XCircle size={12} /> },
    { label: "覆盖盲区", items: judge.coverageGaps, color: "var(--accent-gold)", icon: <EyeOff size={12} /> },
    { label: "独特洞见", items: judge.uniqueInsights, color: "var(--accent-cyan)", icon: <Lightbulb size={12} /> },
    { label: "盲点", items: judge.blindSpots, color: "var(--danger)", icon: <AlertTriangle size={12} /> },
  ];

  return (
    <div
      className="p-4 rounded"
      style={{
        background: "linear-gradient(135deg, rgba(255,200,50,0.05), rgba(255,200,50,0.01))",
        border: "1px solid rgba(255,200,50,0.2)",
      }}
    >
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Scale size={16} style={{ color: "var(--accent-gold)" }} />
          <span className="font-bold font-mono" style={{ color: "var(--accent-gold)" }}>
            Judge 裁决
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono" style={{ color: "var(--accent-gold)" }}>
            置信度: {(judge.confidence * 100).toFixed(0)}%
          </span>
          <button
            onClick={() => setExpanded(!expanded)}
            className="p-1 rounded hover:bg-[rgba(255,255,255,0.05)]"
            style={{ color: "var(--text-muted)" }}
          >
            {expanded ? <EyeOff size={12} /> : <Eye size={12} />}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="space-y-3">
          {/* 最终裁决 */}
          <div
            className="p-3 rounded text-xs font-mono"
            style={{ background: "rgba(255,200,50,0.08)", border: "1px solid rgba(255,200,50,0.15)" }}
          >
            <div className="text-[10px] font-bold mb-1" style={{ color: "var(--accent-gold)" }}>
              最终裁决 · FINAL VERDICT
            </div>
            <div style={{ color: "var(--text-primary)" }}>{judge.finalVerdict}</div>
          </div>

          {/* 风险评估 */}
          {judge.riskAssessment && (
            <div
              className="p-3 rounded text-xs font-mono"
              style={{ background: "rgba(255,80,80,0.05)", border: "1px solid rgba(255,80,80,0.1)" }}
            >
              <div className="text-[10px] font-bold mb-1" style={{ color: "var(--danger)" }}>
                风险评估 · RISK ASSESSMENT
              </div>
              <div style={{ color: "var(--text-primary)" }}>{judge.riskAssessment}</div>
            </div>
          )}

          {/* 建议行动 */}
          {judge.recommendedActions.length > 0 && (
            <div>
              <div className="text-[10px] font-mono mb-1" style={{ color: "var(--accent-cyan)" }}>
                建议行动 · RECOMMENDED ACTIONS
              </div>
              <ul className="space-y-0.5 ml-4">
                {judge.recommendedActions.map((action, i) => (
                  <li key={i} className="text-[10px]" style={{ color: "var(--text-secondary)" }}>
                    • {action}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* 其他维度 */}
          {sections.map(
            (s) =>
              s.items.length > 0 && (
                <div key={s.label}>
                  <div className="flex items-center gap-1 mb-1 text-[10px] font-mono" style={{ color: s.color }}>
                    {s.icon} {s.label}
                  </div>
                  <ul className="space-y-0.5 ml-4">
                    {s.items.map((item, i) => (
                      <li key={i} className="text-[10px]" style={{ color: "var(--text-secondary)" }}>
                        • {item}
                      </li>
                    ))}
                  </ul>
                </div>
              )
          )}

          <div className="text-[9px] font-mono" style={{ color: "var(--text-muted)" }}>
            生成于 {fmtDateTime(judge.generatedAt)}
          </div>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════
   主页面
   ═══════════════════════════════════════════ */

export default function FusionPanel() {
  const [subject, setSubject] = useState("");
  const [content, setContent] = useState("");
  const [reviewerCount, setReviewerCount] = useState(3);
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);
  const [showSubmit, setShowSubmit] = useState(false);

  const listQuery = trpc.fusion.list.useQuery(undefined, {
    retry: 1,
    staleTime: 10_000,
  });
  const statusQuery = trpc.fusion.status.useQuery(
    { traceId: selectedTraceId || "" },
    { retry: 1, staleTime: 5_000, enabled: !!selectedTraceId }
  );
  const submitMutation = trpc.fusion.submit.useMutation({
    onSuccess: (data) => {
      if (data.success) {
        setSelectedTraceId(data.traceId);
        setShowSubmit(false);
        setSubject("");
        setContent("");
        listQuery.refetch();
      }
    },
  });

  const list = (listQuery.data as FusionListItem[]) || [];
  const status = statusQuery.data as FusionStatus | null;

  return (
    <div className="min-h-screen" style={{ background: "var(--bg-primary)" }}>
      <div className="max-w-6xl mx-auto px-4 sm:px-6 pt-24 pb-16">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-black tracking-wider" style={{ color: "var(--text-primary)" }}>
              Fusion 审查
            </h1>
            <p className="text-[10px] font-mono mt-1" style={{ color: "var(--text-muted)" }}>
              多模型并行审查 · Judge 裁决 · 共识/分歧/风险分析
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => listQuery.refetch()}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded font-mono hover:bg-[rgba(180,200,255,0.05)] transition-colors"
              style={{ color: "var(--text-muted)", border: "1px solid var(--border-default)" }}
            >
              <RefreshCw size={14} /> 刷新
            </button>
            <button
              onClick={() => setShowSubmit(true)}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded font-mono"
              style={{ background: "var(--accent-cyan)", color: "#000" }}
            >
              <Send size={14} /> 提交审查
            </button>
          </div>
        </div>

        {/* 提交表单 */}
        {showSubmit && (
          <div className="glass-panel p-4 sci-border mb-6">
            <div className="text-[10px] font-mono mb-3 uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
              提交审查请求
            </div>
            <div className="space-y-3">
              <div>
                <label className="text-[10px] font-mono mb-1 block" style={{ color: "var(--text-muted)" }}>
                  审查主题
                </label>
                <input
                  type="text"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder="例: 代码审查 - 用户认证模块重构"
                  className="w-full px-3 py-2 rounded text-xs outline-none font-mono"
                  style={{ background: "rgba(0,0,0,0.2)", border: "1px solid var(--border-default)", color: "var(--text-primary)" }}
                />
              </div>
              <div>
                <label className="text-[10px] font-mono mb-1 block" style={{ color: "var(--text-muted)" }}>
                  待审查内容
                </label>
                <textarea
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  placeholder="粘贴需要审查的代码、设计文档、架构方案..."
                  rows={8}
                  className="w-full px-3 py-2 rounded text-xs outline-none font-mono resize-y"
                  style={{ background: "rgba(0,0,0,0.2)", border: "1px solid var(--border-default)", color: "var(--text-primary)" }}
                />
              </div>
              <div className="flex items-center gap-4">
                <div>
                  <label className="text-[10px] font-mono mb-1 block" style={{ color: "var(--text-muted)" }}>
                    审查者数量
                  </label>
                  <select
                    value={reviewerCount}
                    onChange={(e) => setReviewerCount(Number(e.target.value))}
                    className="px-3 py-2 rounded text-xs outline-none"
                    style={{ background: "rgba(0,0,0,0.2)", border: "1px solid var(--border-default)", color: "var(--text-primary)" }}
                  >
                    <option value={2}>2 个审查者</option>
                    <option value={3}>3 个审查者</option>
                    <option value={4}>4 个审查者</option>
                    <option value={5}>5 个审查者</option>
                  </select>
                </div>
                <div className="flex items-center gap-2 self-end">
                  <button
                    onClick={() => {
                      if (subject && content) {
                        submitMutation.mutate({ subject, content, reviewerCount });
                      }
                    }}
                    disabled={!subject || !content || submitMutation.isLoading}
                    className="px-4 py-2 rounded text-xs font-mono disabled:opacity-40"
                    style={{ background: "var(--accent-cyan)", color: "#000" }}
                  >
                    {submitMutation.isLoading ? "提交中..." : "提交审查"}
                  </button>
                  <button
                    onClick={() => setShowSubmit(false)}
                    className="px-4 py-2 rounded text-xs font-mono"
                    style={{ border: "1px solid var(--border-default)", color: "var(--text-muted)" }}
                  >
                    取消
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* 审查历史 + 详情 */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* 历史列表 */}
          <div className="lg:col-span-1">
            <div className="glass-panel p-4 sci-border">
              <div className="text-[10px] font-mono mb-3 uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
                审查历史
              </div>
              {list.length === 0 ? (
                <div className="text-xs py-4" style={{ color: "var(--text-muted)" }}>
                  暂无审查记录
                </div>
              ) : (
                <div className="space-y-1">
                  {list.map((item) => (
                    <button
                      key={item.traceId}
                      onClick={() => setSelectedTraceId(item.traceId)}
                      className="w-full text-left p-2 rounded text-[10px] font-mono hover:bg-[rgba(180,200,255,0.03)] transition-colors"
                      style={{
                        background:
                          selectedTraceId === item.traceId
                            ? "rgba(74,158,255,0.05)"
                            : "rgba(255,255,255,0.01)",
                        border:
                          selectedTraceId === item.traceId
                            ? "1px solid rgba(74,158,255,0.2)"
                            : "1px solid rgba(255,255,255,0.03)",
                      }}
                    >
                      <div className="flex items-center justify-between mb-1">
                        <span className="truncate max-w-28" style={{ color: "var(--text-primary)" }}>
                          {item.subject}
                        </span>
                        <StatusBadge status={item.status} />
                      </div>
                      <div style={{ color: "var(--text-muted)" }}>{fmtDateTime(item.createdAt)}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* 审查详情 */}
          <div className="lg:col-span-2">
            {!selectedTraceId ? (
              <div className="glass-panel p-8 sci-border flex flex-col items-center justify-center" style={{ minHeight: "300px" }}>
                <Scale size={40} style={{ color: "var(--text-muted)", opacity: 0.3 }} />
                <div className="text-sm font-mono mt-3" style={{ color: "var(--text-muted)" }}>
                  选择一个审查记录查看详情
                </div>
                <div className="text-[10px] font-mono mt-1" style={{ color: "var(--text-muted)" }}>
                  或提交新的审查请求
                </div>
              </div>
            ) : statusQuery.isLoading ? (
              <div className="glass-panel p-8 sci-border flex items-center justify-center" style={{ minHeight: "300px" }}>
                <div className="text-xs font-mono" style={{ color: "var(--text-muted)" }}>
                  加载中...
                </div>
              </div>
            ) : status ? (
              <div className="space-y-4">
                {/* 状态头部 */}
                <div className="glass-panel p-4 sci-border">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <FileText size={14} style={{ color: "var(--accent-cyan)" }} />
                      <span className="font-bold font-mono text-xs" style={{ color: "var(--text-primary)" }}>
                        {status.reviewerCount > 0
                          ? list.find((l) => l.traceId === selectedTraceId)?.subject || "(未知)"
                          : "(未知)"}
                      </span>
                    </div>
                    <StatusBadge status={status.status} />
                  </div>
                  <div className="flex items-center gap-4 text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>
                    <span>Trace: {status.traceId}</span>
                    <span>审查者: {status.reviewerCount}</span>
                    <span>已完成: {status.reviewCompleted}/{status.reviewerCount}</span>
                    <span>Judge: {status.judgeCompleted ? "✅" : "⏳"}</span>
                  </div>
                </div>

                {/* 审查结果 */}
                {status.reviews.length > 0 && (
                  <div className="glass-panel p-4 sci-border">
                    <div className="text-[10px] font-mono mb-3 uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
                      审查结果 · REVIEW RESULTS
                    </div>
                    <div className="space-y-2">
                      {status.reviews.map((review, i) => (
                        <ReviewCard key={i} review={review} index={i} />
                      ))}
                    </div>
                  </div>
                )}

                {/* Judge 裁决 */}
                {status.judge && (
                  <div className="glass-panel p-4 sci-border">
                    <JudgeCard judge={status.judge} />
                  </div>
                )}

                {/* 等待中 */}
                {status.status === "pending" && (
                  <div className="glass-panel p-8 sci-border flex flex-col items-center justify-center">
                    <Clock size={32} style={{ color: "var(--text-muted)", opacity: 0.3 }} />
                    <div className="text-xs font-mono mt-2" style={{ color: "var(--text-muted)" }}>
                      等待审查者响应...
                    </div>
                    <button
                      onClick={() => statusQuery.refetch()}
                      className="mt-3 text-[10px] font-mono px-3 py-1.5 rounded"
                      style={{ border: "1px solid var(--border-default)", color: "var(--text-muted)" }}
                    >
                      刷新状态
                    </button>
                  </div>
                )}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
