/**
 * Phase 1 Task 7: Artifact metadata CRUD tab.
 *
 * Metadata only: no object transfer, preview, or external storage actions.
 */
import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { Plus, Edit3, Trash2, Package } from "lucide-react";
import type { Artifact, Project } from "./types";
import { SelectField, Button, SectionLabel, EmptyState, InlineButton, Badge } from "./ui";
import { formatDateTime, formatBytes } from "./format";
import ArtifactModal from "./ArtifactModal";

export default function ArtifactTab({ workspaceId }: { readonly workspaceId: number | null }) {
  const [projectId, setProjectId] = useState<number | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<Artifact | null>(null);

  const projectList = trpc.workspace.projectList.useQuery(
    { workspaceId: workspaceId ?? 0 },
    { enabled: workspaceId !== null, retry: 1, staleTime: 10_000 }
  );

  const listQuery = trpc.artifact.list.useQuery(
    { workspaceId: workspaceId ?? 0, projectId: projectId ?? undefined },
    { enabled: workspaceId !== null, retry: 1, staleTime: 10_000 }
  );

  const utils = trpc.useUtils();

  const deleteMutation = trpc.artifact.delete.useMutation({
    onSuccess: () => {
      if (workspaceId !== null) utils.artifact.list.invalidate({ workspaceId, projectId: projectId ?? undefined });
    },
  });

  const projects: Project[] = projectList.data ?? [];
  const rows: Artifact[] = listQuery.data ?? [];

  const projectOptions = [
    { value: "", label: "全部项目" },
    ...projects.map((p) => ({ value: String(p.id), label: `${p.name} (#${p.id})` })),
  ];

  const closeModal = () => {
    setShowModal(false);
    setEditing(null);
  };

  const handleDelete = (row: Artifact) => {
    if (!confirm(`确认删除工件 "${row.name}"?`)) return;
    deleteMutation.mutate({ artifactId: row.id });
  };

  if (workspaceId === null) {
    return (
      <div className="glass-panel p-4 sci-border">
        <SectionLabel>工件 · ARTIFACTS</SectionLabel>
        <div className="text-xs py-4" style={{ color: "var(--text-muted)" }}>请先选择一个工作区</div>
      </div>
    );
  }

  return (
    <div className="glass-panel p-4 sci-border">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
        <SectionLabel>工件 · ARTIFACTS</SectionLabel>
        <div className="flex items-center gap-2">
          <SelectField
            label="项目筛选"
            value={projectId === null ? "" : String(projectId)}
            onChange={(v) => setProjectId(v ? Number(v) : null)}
            options={projectOptions}
          />
          <Button variant="primary" onClick={() => { setEditing(null); setShowModal(true); }}>
            <span className="flex items-center gap-1.5">
              <Plus size={12} /> 新建工件
            </span>
          </Button>
        </div>
      </div>

      {listQuery.isLoading ? (
        <div className="text-xs p-4" style={{ color: "var(--text-muted)" }}>加载中...</div>
      ) : rows.length === 0 ? (
        <EmptyState title="暂无工件" desc="点击「新建工件」创建" icon={<Package size={32} />} />
      ) : (
        <div className="overflow-x-auto custom-scrollbar">
          <table className="w-full text-xs font-mono">
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border-default)" }}>
                {["ID", "名称", "Slug", "类型", "状态", "大小", "更新时间", "操作"].map((h) => (
                  <th key={h} className="text-left py-2 px-3" style={{ color: "var(--text-muted)", fontWeight: 400 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="hover:bg-[rgba(180,200,255,0.02)]" style={{ borderBottom: "1px solid rgba(255,255,255,0.03)" }}>
                  <td className="py-2 px-3" style={{ color: "var(--text-muted)" }}>#{row.id}</td>
                  <td className="py-2 px-3 truncate max-w-40" style={{ color: "var(--text-primary)" }}>{row.name}</td>
                  <td className="py-2 px-3" style={{ color: "var(--text-secondary)" }}>{row.slug}</td>
                  <td className="py-2 px-3">
                    <Badge color="cyan">{row.artifactType}</Badge>
                  </td>
                  <td className="py-2 px-3">
                    <Badge color={row.status === "active" ? "green" : row.status === "deleted" ? "red" : "muted"}>{row.status}</Badge>
                  </td>
                  <td className="py-2 px-3" style={{ color: "var(--text-muted)" }}>{formatBytes(row.sizeBytes)}</td>
                  <td className="py-2 px-3" style={{ color: "var(--text-muted)" }}>{formatDateTime(row.updatedAt)}</td>
                  <td className="py-2 px-3">
                    <div className="flex items-center gap-2">
                      <InlineButton onClick={() => { setEditing(row); setShowModal(true); }} icon={<Edit3 size={12} />} title="编辑" />
                      <InlineButton onClick={() => handleDelete(row)} icon={<Trash2 size={12} />} title="删除" danger />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showModal && workspaceId !== null && (
        <ArtifactModal workspaceId={workspaceId} projectId={projectId} editing={editing} onClose={closeModal} />
      )}
    </div>
  );
}
