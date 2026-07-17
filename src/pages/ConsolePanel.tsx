/**
 * Phase 1 Task 7: Metadata console shell.
 *
 * Protected /console route. Tabbed admin interface for Phase 1 metadata:
 * workspaces, projects, memberships, secrets, connectors, artifacts, audit logs.
 */
import { useState, useEffect } from "react";
import { trpc } from "@/providers/trpc";
import {
  Layers,
  FolderKanban,
  Users,
  Lock,
  Plug,
  Package,
  FileClock,
} from "lucide-react";
import type { Workspace } from "./console/types";
import { assertNever } from "./console/format";
import { SelectField } from "./console/ui";
import WorkspaceTab from "./console/WorkspaceTab";
import ProjectTab from "./console/ProjectTab";
import MembershipTab from "./console/MembershipTab";
import SecretTab from "./console/SecretTab";
import ConnectorTab from "./console/ConnectorTab";
import ArtifactTab from "./console/ArtifactTab";
import AuditTab from "./console/AuditTab";

const TABS = [
  { key: "workspaces", label: "工作区", sub: "WORKSPACES", icon: Layers },
  { key: "projects", label: "项目", sub: "PROJECTS", icon: FolderKanban },
  { key: "memberships", label: "成员", sub: "MEMBERSHIPS", icon: Users },
  { key: "secrets", label: "密钥库", sub: "SECRET VAULT", icon: Lock },
  { key: "connectors", label: "连接器", sub: "CONNECTORS", icon: Plug },
  { key: "artifacts", label: "工件", sub: "ARTIFACTS", icon: Package },
  { key: "audit", label: "审计", sub: "AUDIT LOGS", icon: FileClock },
] as const;

type TabKey = (typeof TABS)[number]["key"];

function WorkspaceSelector({
  value,
  onChange,
}: {
  readonly value: number | null;
  readonly onChange: (id: number | null) => void;
}) {
  const listQuery = trpc.workspace.list.useQuery(undefined, { retry: 1, staleTime: 10_000 });
  const workspaces: Workspace[] = listQuery.data ?? [];
  const options = [
    { value: "", label: "选择工作区" },
    ...workspaces.map((w) => ({ value: String(w.id), label: `${w.name} (#${w.id})` })),
  ];

  return (
    <SelectField
      label="当前工作区"
      value={value === null ? "" : String(value)}
      onChange={(v) => onChange(v ? Number(v) : null)}
      options={options}
    />
  );
}

export default function ConsolePanel() {
  const [activeTab, setActiveTab] = useState<TabKey>("workspaces");
  const [workspaceId, setWorkspaceId] = useState<number | null>(null);
  const listQuery = trpc.workspace.list.useQuery(undefined, { retry: 1, staleTime: 10_000 });

  useEffect(() => {
    if (workspaceId !== null) return;
    const workspaces = listQuery.data ?? [];
    if (workspaces.length > 0) {
      setWorkspaceId(workspaces[0].id);
    }
  }, [listQuery.data, workspaceId]);

  const renderTab = () => {
    switch (activeTab) {
      case "workspaces":
        return <WorkspaceTab />;
      case "projects":
        return <ProjectTab workspaceId={workspaceId} />;
      case "memberships":
        return <MembershipTab workspaceId={workspaceId} />;
      case "secrets":
        return <SecretTab workspaceId={workspaceId} />;
      case "connectors":
        return <ConnectorTab workspaceId={workspaceId} />;
      case "artifacts":
        return <ArtifactTab workspaceId={workspaceId} />;
      case "audit":
        return <AuditTab workspaceId={workspaceId} />;
      default:
        return assertNever(activeTab);
    }
  };

  return (
    <div className="min-h-screen" style={{ background: "var(--bg-primary)" }}>
      <div className="max-w-7xl mx-auto px-4 sm:px-6 pt-24 pb-16">
        {/* Header */}
        <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4 mb-6">
          <div>
            <h1 className="text-2xl font-black tracking-wider" style={{ color: "var(--text-primary)" }}>
              控制台
            </h1>
            <p className="text-[10px] font-mono mt-1" style={{ color: "var(--text-muted)" }}>
              METADATA CONSOLE · 工作区 · 项目 · 密钥 · 连接器 · 工件 · 审计
            </p>
          </div>
          <div className="w-full sm:w-64">
            <WorkspaceSelector value={workspaceId} onChange={setWorkspaceId} />
          </div>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-1 mb-4 overflow-x-auto custom-scrollbar">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            const active = activeTab === tab.key;
            return (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded font-mono whitespace-nowrap transition-colors"
                style={{
                  background: active ? "rgba(180,200,255,0.06)" : "transparent",
                  color: active ? "var(--text-primary)" : "var(--text-muted)",
                  border: active ? "1px solid var(--border-hover)" : "1px solid transparent",
                }}
              >
                <Icon size={12} />
                <span>{tab.label}</span>
                <span className="text-[9px] opacity-60">{tab.sub}</span>
              </button>
            );
          })}
        </div>

        {/* Tab content */}
        {renderTab()}
      </div>
    </div>
  );
}
