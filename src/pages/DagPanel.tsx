/**
 * 任务 DAG 可视化 + 组织架构 + 任务计划生成器
 */
import { useState, useMemo } from "react";
import { trpc } from "@/providers/trpc";
import {
  GitBranch,
  CheckCircle2,
  XCircle,
  Clock,
  Play,
  AlertTriangle,
  RefreshCw,
  Search,
  Users,
  Building2,
  Lightbulb,
  Send,
} from "lucide-react";

/* ═══════════════════════════════════════════
   类型定义
   ═══════════════════════════════════════════ */

interface DagNode {
  id: number;
  taskId: string;
  name: string;
  status: string;
  progress: number;
  priority: number;
  agentId: number | null;
  agentName: string | null;
  parentTaskId: number | null;
  output: string | null;
  error: string | null;
  outputValid: string | null;
  createdAt: string;
  updatedAt?: string;
}

interface DagEdge {
  from: number;
  to: number;
}

interface DagData {
  nodes: DagNode[];
  edges: DagEdge[];
}

interface OrgAgent {
  id: number;
  agentId: string;
  name: string;
  role: string | null;
  status: string;
  reportsTo: number | null;
  model: string | null;
}

interface OrgDepartment {
  id: number;
  name: string;
  description: string | null;
  leadAgentId: number | null;
  agents: OrgAgent[];
}

interface OrgOrganization {
  id: number;
  name: string;
  description: string | null;
  departments: OrgDepartment[];
}

interface OrgTree {
  organizations: OrgOrganization[];
  hierarchy: any[];
}

interface PlanAgent {
  id: number;
  name: string;
  role: string | null;
  capabilities: string | null;
  model: string | null;
}

interface SubtaskEstimate {
  name: string;
  description: string;
  estimatedEffort: string;
  suggestedRole: string;
}

interface TaskPlan {
  title: string;
  description: string;
  estimatedSubtasks: SubtaskEstimate[];
  availableAgents: PlanAgent[];
}

/* ═══════════════════════════════════════════
   辅助函数
   ═══════════════════════════════════════════ */

const STATUS_COLORS: Record<string, string> = {
  done: "var(--success)",
  failed: "var(--danger)",
  running: "var(--accent-cyan)",
  queued: "var(--accent-gold)",
  pending: "var(--text-muted)",
};

const STATUS_ICONS: Record<string, React.ReactNode> = {
  done: <CheckCircle2 size={14} />,
  failed: <XCircle size={14} />,
  running: <Play size={14} />,
  queued: <Clock size={14} />,
  pending: <Clock size={14} />,
};

function fmtDateTime(iso: string) {
  const d = new Date(iso);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* ═══════════════════════════════════════════
   子组件
   ═══════════════════════════════════════════ */

function DagView({ dag }: { dag: DagData }) {
  const [selectedNode, setSelectedNode] = useState<DagNode | null>(null);

  // 按层级排列节点
  const levels = useMemo(() => {
    const nodeMap = new Map(dag.nodes.map((n) => [n.id, n]));
    const inDegree = new Map<number, number>();
    const children = new Map<number, number[]>();

    for (const n of dag.nodes) {
      inDegree.set(n.id, 0);
      children.set(n.id, []);
    }

    for (const e of dag.edges) {
      inDegree.set(e.to, (inDegree.get(e.to) || 0) + 1);
      if (children.has(e.from)) {
        children.get(e.from)!.push(e.to);
      }
    }

    // 拓扑排序
    const levels: DagNode[][] = [];
    let queue = dag.nodes.filter((n) => (inDegree.get(n.id) || 0) === 0);

    while (queue.length > 0) {
      levels.push(queue);
      const next: DagNode[] = [];
      for (const n of queue) {
        for (const childId of children.get(n.id) || []) {
          const deg = (inDegree.get(childId) || 1) - 1;
          inDegree.set(childId, deg);
          if (deg === 0 && nodeMap.has(childId)) {
            next.push(nodeMap.get(childId)!);
          }
        }
      }
      queue = next;
    }

    return levels;
  }, [dag]);

  return (
    <div className="flex gap-4">
      {/* DAG 图 */}
      <div className="flex-1 overflow-x-auto custom-scrollbar">
        <div className="space-y-3 min-w-[400px]">
          {levels.map((level, li) => (
            <div key={li} className="flex gap-2 items-start">
              <div className="text-[9px] font-mono pt-1.5 w-6 flex-shrink-0" style={{ color: "var(--text-muted)" }}>
                L{li + 1}
              </div>
              <div className="flex gap-2 flex-wrap">
                {level.map((node) => {
                  const color = STATUS_COLORS[node.status] || "var(--text-muted)";
                  return (
                    <button
                      key={node.id}
                      onClick={() => setSelectedNode(node)}
                      className="p-2.5 rounded text-left transition-all"
                      style={{
                        background:
                          selectedNode?.id === node.id
                            ? `${color}15`
                            : "rgba(255,255,255,0.02)",
                        border:
                          selectedNode?.id === node.id
                            ? `1px solid ${color}40`
                            : `1px solid ${color}20`,
                        minWidth: "140px",
                      }}
                    >
                      <div className="flex items-center gap-1.5 mb-1">
                        <span style={{ color }}>{STATUS_ICONS[node.status]}</span>
                        <span className="text-[10px] font-bold font-mono truncate max-w-24" style={{ color: "var(--text-primary)" }}>
                          {node.name}
                        </span>
                      </div>
                      <div className="text-[9px] font-mono space-y-0.5" style={{ color: "var(--text-muted)" }}>
                        {node.agentName && <div>Agent: {node.agentName}</div>}
                        <div>#{node.taskId}</div>
                        {node.outputValid && node.outputValid !== "unknown" && (
                          <div style={{ color: node.outputValid === "true" ? "var(--success)" : "var(--danger)" }}>
                            输出: {node.outputValid === "true" ? "✅" : "❌"}
                          </div>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 选中节点详情 */}
      {selectedNode && (
        <div className="w-64 flex-shrink-0">
          <div className="glass-panel p-3 sci-border text-[10px] font-mono">
            <div className="text-[10px] font-bold mb-2" style={{ color: STATUS_COLORS[selectedNode.status] || "var(--text-muted)" }}>
              {STATUS_ICONS[selectedNode.status]} {selectedNode.name}
            </div>
            <div className="space-y-1">
              <div><span style={{ color: "var(--text-muted)" }}>ID: </span>{selectedNode.taskId}</div>
              <div><span style={{ color: "var(--text-muted)" }}>状态: </span>{selectedNode.status}</div>
              <div><span style={{ color: "var(--text-muted)" }}>进度: </span>{selectedNode.progress}%</div>
              {selectedNode.agentName && (
                <div><span style={{ color: "var(--text-muted)" }}>Agent: </span>{selectedNode.agentName}</div>
              )}
              {selectedNode.priority > 0 && (
                <div><span style={{ color: "var(--text-muted)" }}>优先级: </span>P{selectedNode.priority}</div>
              )}
              <div><span style={{ color: "var(--text-muted)" }}>创建: </span>{fmtDateTime(selectedNode.createdAt)}</div>
              {selectedNode.output && (
                <div>
                  <div style={{ color: "var(--text-muted)" }}>输出:</div>
                  <div className="p-1.5 rounded mt-0.5 text-[9px]" style={{ background: "rgba(0,0,0,0.2)", color: "var(--text-secondary)", maxHeight: "100px", overflow: "auto" }}>
                    {selectedNode.output}
                  </div>
                </div>
              )}
              {selectedNode.error && (
                <div>
                  <div style={{ color: "var(--danger)" }}>错误:</div>
                  <div className="p-1.5 rounded mt-0.5 text-[9px]" style={{ background: "rgba(255,80,80,0.05)", color: "var(--danger)" }}>
                    {selectedNode.error}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function OrgTreeView({ orgTree }: { orgTree: OrgTree }) {
  const [expandedOrgs, setExpandedOrgs] = useState<Set<number>>(new Set());
  const [expandedDepts, setExpandedDepts] = useState<Set<number>>(new Set());

  const toggleOrg = (id: number) => {
    setExpandedOrgs((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleDept = (id: number) => {
    setExpandedDepts((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="space-y-3">
      {orgTree.organizations.map((org) => (
        <div key={org.id}>
          <button
            onClick={() => toggleOrg(org.id)}
            className="flex items-center gap-2 w-full text-left p-2 rounded text-xs font-mono hover:bg-[rgba(255,255,255,0.02)]"
            style={{ border: "1px solid rgba(255,255,255,0.05)" }}
          >
            <Building2 size={14} style={{ color: "var(--accent-cyan)" }} />
            <span style={{ color: "var(--text-primary)", fontWeight: 600 }}>{org.name}</span>
            <span className="text-[9px]" style={{ color: "var(--text-muted)" }}>
              {org.departments.length} 部门
            </span>
          </button>

          {expandedOrgs.has(org.id) && (
            <div className="ml-4 mt-2 space-y-2">
              {org.departments.map((dept) => (
                <div key={dept.id}>
                  <button
                    onClick={() => toggleDept(dept.id)}
                    className="flex items-center gap-2 w-full text-left p-2 rounded text-[10px] font-mono hover:bg-[rgba(255,255,255,0.02)]"
                    style={{ border: "1px solid rgba(255,255,255,0.03)" }}
                  >
                    <Users size={12} style={{ color: "var(--accent-gold)" }} />
                    <span style={{ color: "var(--text-primary)" }}>{dept.name}</span>
                    <span className="text-[9px]" style={{ color: "var(--text-muted)" }}>
                      {dept.agents.length} Agent
                    </span>
                  </button>

                  {expandedDepts.has(dept.id) && (
                    <div className="ml-4 mt-1 space-y-1">
                      {dept.agents.map((agent) => (
                        <div
                          key={agent.id}
                          className="p-1.5 rounded text-[9px] font-mono"
                          style={{ background: "rgba(255,255,255,0.01)", border: "1px solid rgba(255,255,255,0.03)" }}
                        >
                          <div className="flex items-center gap-1.5">
                            <span
                              className="w-1.5 h-1.5 rounded-full"
                              style={{
                                background:
                                  agent.status === "online"
                                    ? "var(--success)"
                                    : agent.status === "busy"
                                      ? "var(--accent-gold)"
                                      : "var(--text-muted)",
                              }}
                            />
                            <span style={{ color: "var(--text-primary)" }}>{agent.name}</span>
                            <span style={{ color: "var(--text-muted)" }}>({agent.agentId})</span>
                          </div>
                          {agent.role && (
                            <div className="ml-3" style={{ color: "var(--text-secondary)" }}>
                              {agent.role}
                            </div>
                          )}
                          {agent.model && (
                            <div className="ml-3" style={{ color: "var(--text-muted)" }}>
                              模型: {agent.model}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}

              {/* 无部门的 Agent */}
              {org.departments.length === 0 && (
                <div className="text-[9px] font-mono p-2" style={{ color: "var(--text-muted)" }}>
                  暂无部门
                </div>
              )}
            </div>
          )}
        </div>
      ))}

      {orgTree.organizations.length === 0 && (
        <div className="text-xs py-4" style={{ color: "var(--text-muted)" }}>
          暂无组织架构数据
        </div>
      )}
    </div>
  );
}

function PlanGenerator() {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [plan, setPlan] = useState<TaskPlan | null>(null);
  const [loading, setLoading] = useState(false);

  const generatePlan = trpc.plan.generatePlan.useQuery(
    { title, description },
    { enabled: false, retry: 0 }
  );

  const handleGenerate = async () => {
    if (!title || !description) return;
    setLoading(true);
    try {
      const result = await generatePlan.refetch();
      if (result.data) {
        setPlan(result.data as TaskPlan);
      }
    } catch {}
    setLoading(false);
  };

  return (
    <div>
      <div className="space-y-3 mb-4">
        <div>
          <label className="text-[10px] font-mono mb-1 block" style={{ color: "var(--text-muted)" }}>
            任务标题
          </label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="例: 开发用户登录模块"
            className="w-full px-3 py-2 rounded text-xs outline-none font-mono"
            style={{ background: "rgba(0,0,0,0.2)", border: "1px solid var(--border-default)", color: "var(--text-primary)" }}
          />
        </div>
        <div>
          <label className="text-[10px] font-mono mb-1 block" style={{ color: "var(--text-muted)" }}>
            需求描述
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="描述需要完成的工作..."
            rows={4}
            className="w-full px-3 py-2 rounded text-xs outline-none font-mono resize-y"
            style={{ background: "rgba(0,0,0,0.2)", border: "1px solid var(--border-default)", color: "var(--text-primary)" }}
          />
        </div>
        <button
          onClick={handleGenerate}
          disabled={!title || !description || loading}
          className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded font-mono disabled:opacity-40"
          style={{ background: "var(--accent-cyan)", color: "#000" }}
        >
          <Lightbulb size={14} /> {loading ? "生成中..." : "生成计划"}
        </button>
      </div>

      {plan && (
        <div className="space-y-3">
          <div className="text-[10px] font-mono uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
            建议子任务
          </div>
          {plan.estimatedSubtasks.map((task, i) => (
            <div
              key={i}
              className="p-2.5 rounded text-[10px] font-mono"
              style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)" }}
            >
              <div className="flex items-center justify-between mb-1">
                <span style={{ color: "var(--text-primary)", fontWeight: 600 }}>{task.name}</span>
                <span className="text-[9px] px-1.5 py-0.5 rounded" style={{ background: "rgba(74,158,255,0.1)", color: "var(--accent-cyan)" }}>
                  {task.estimatedEffort}
                </span>
              </div>
              <div style={{ color: "var(--text-secondary)" }}>{task.description}</div>
              <div className="mt-1" style={{ color: "var(--text-muted)" }}>
                建议角色: {task.suggestedRole}
              </div>
            </div>
          ))}

          {plan.availableAgents.length > 0 && (
            <div>
              <div className="text-[10px] font-mono mt-4 mb-2 uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
                可用 Agent
              </div>
              <div className="flex flex-wrap gap-1.5">
                {plan.availableAgents.map((a) => (
                  <div
                    key={a.id}
                    className="text-[9px] px-2 py-1 rounded font-mono"
                    style={{ background: "rgba(74,158,255,0.05)", border: "1px solid rgba(74,158,255,0.15)", color: "var(--accent-cyan)" }}
                  >
                    {a.name}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════
   主页面
   ═══════════════════════════════════════════ */

export default function DagPanel() {
  const [tab, setTab] = useState<"dag" | "org" | "plan">("dag");
  const [searchTaskId, setSearchTaskId] = useState("");

  const dagQuery = trpc.plan.dag.useQuery(undefined, { retry: 1, staleTime: 10_000 });
  const orgQuery = trpc.plan.orgTree.useQuery(undefined, { retry: 1, staleTime: 30_000 });
  const taskDagQuery = trpc.plan.taskDag.useQuery(
    { taskId: searchTaskId ? Number(searchTaskId) : 0 },
    { retry: 1, staleTime: 10_000, enabled: !!searchTaskId && !isNaN(Number(searchTaskId)) }
  );

  const dag = dagQuery.data as DagData | undefined;
  const orgTree = orgQuery.data as OrgTree | undefined;
  const taskDag = taskDagQuery.data as DagData | null;

  return (
    <div className="min-h-screen" style={{ background: "var(--bg-primary)" }}>
      <div className="max-w-7xl mx-auto px-4 sm:px-6 pt-24 pb-16">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-black tracking-wider" style={{ color: "var(--text-primary)" }}>
              {tab === "dag" ? "任务 DAG" : tab === "org" ? "组织架构" : "任务计划"}
            </h1>
            <p className="text-[10px] font-mono mt-1" style={{ color: "var(--text-muted)" }}>
              {tab === "dag" ? "任务依赖关系 · 拓扑排序 · 状态总览" : tab === "org" ? "组织 · 部门 · Agent 层级" : "需求拆解 · 子任务分配"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => { dagQuery.refetch(); orgQuery.refetch(); }}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded font-mono"
              style={{ border: "1px solid var(--border-default)", color: "var(--text-muted)" }}
            >
              <RefreshCw size={14} /> 刷新
            </button>
          </div>
        </div>

        {/* Tab 切换 */}
        <div className="flex gap-1 mb-6">
          {[
            { key: "dag" as const, label: "任务 DAG", icon: <GitBranch size={14} /> },
            { key: "org" as const, label: "组织架构", icon: <Building2 size={14} /> },
            { key: "plan" as const, label: "任务计划", icon: <Lightbulb size={14} /> },
          ].map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded font-mono transition-colors"
              style={{
                background: tab === t.key ? "rgba(74,158,255,0.1)" : "rgba(255,255,255,0.02)",
                border: `1px solid ${tab === t.key ? "rgba(74,158,255,0.3)" : "var(--border-default)"}`,
                color: tab === t.key ? "var(--accent-cyan)" : "var(--text-muted)",
              }}
            >
              {t.icon} {t.label}
            </button>
          ))}
        </div>

        {/* 内容区 */}
        {tab === "dag" && (
          <div>
            {/* 搜索特定任务 */}
            <div className="mb-4">
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  value={searchTaskId}
                  onChange={(e) => setSearchTaskId(e.target.value)}
                  placeholder="输入任务 ID 查看 DAG..."
                  className="px-3 py-1.5 rounded text-xs outline-none font-mono"
                  style={{ background: "rgba(0,0,0,0.2)", border: "1px solid var(--border-default)", color: "var(--text-primary)", width: "200px" }}
                />
                <Search size={14} style={{ color: "var(--text-muted)" }} />
              </div>
            </div>

            <div className="glass-panel p-4 sci-border">
              {taskDag ? (
                <DagView dag={taskDag} />
              ) : dag ? (
                <DagView dag={dag} />
              ) : (
                <div className="text-xs py-8 text-center" style={{ color: "var(--text-muted)" }}>
                  加载中...
                </div>
              )}
            </div>
          </div>
        )}

        {tab === "org" && (
          <div className="glass-panel p-4 sci-border">
            {orgTree ? <OrgTreeView orgTree={orgTree} /> : (
              <div className="text-xs py-8 text-center" style={{ color: "var(--text-muted)" }}>
                加载中...
              </div>
            )}
          </div>
        )}

        {tab === "plan" && (
          <div className="glass-panel p-4 sci-border">
            <PlanGenerator />
          </div>
        )}
      </div>
    </div>
  );
}
