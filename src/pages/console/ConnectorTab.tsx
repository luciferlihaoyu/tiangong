/**
 * Phase 1 Task 7: Connector metadata CRUD tab.
 *
 * Metadata only: config is non-secret safe config, credentials referenced by
 * secretRefId (displayed as opaque metadata). No runtime connector operations.
 */
import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { Plus, Edit3, Trash2, Plug } from "lucide-react";
import {
  CONNECTOR_TYPES,
  CONNECTOR_STATUSES,
  type Connector,
  type ConnectorType,
  type ConnectorStatus,
  type Project,
} from "./types";
import { Modal, TextField, SelectField, Button, SectionLabel, EmptyState, InlineButton, Badge } from "./ui";
import { formatDateTime, parseLiteral } from "./format";

type ConnectorForm = {
  name: string;
  slug: string;
  connectorType: ConnectorType;
  status: ConnectorStatus;
  endpoint: string;
  secretRefId: string;
};

const emptyForm: ConnectorForm = {
  name: "",
  slug: "",
  connectorType: "opencode",
  status: "draft",
  endpoint: "",
  secretRefId: "",
};

const typeOptions = CONNECTOR_TYPES.map((t) => ({ value: t, label: t }));
const statusOptions = CONNECTOR_STATUSES.map((s) => ({ value: s, label: s }));

export default function ConnectorTab({ workspaceId }: { readonly workspaceId: number | null }) {
  const [projectId, setProjectId] = useState<number | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<Connector | null>(null);
  const [form, setForm] = useState<ConnectorForm>(emptyForm);

  const projectList = trpc.workspace.projectList.useQuery(
    { workspaceId: workspaceId ?? 0 },
    { enabled: workspaceId !== null, retry: 1, staleTime: 10_000 }
  );

  const listQuery = trpc.connector.list.useQuery(
    { workspaceId: workspaceId ?? 0, projectId: projectId ?? undefined },
    { enabled: workspaceId !== null, retry: 1, staleTime: 10_000 }
  );

  const utils = trpc.useUtils();

  const createMutation = trpc.connector.create.useMutation({
    onSuccess: () => {
      if (workspaceId !== null) utils.connector.list.invalidate({ workspaceId, projectId: projectId ?? undefined });
      closeModal();
    },
  });

  const updateMutation = trpc.connector.update.useMutation({
    onSuccess: () => {
      if (workspaceId !== null) utils.connector.list.invalidate({ workspaceId, projectId: projectId ?? undefined });
      closeModal();
    },
  });

  const deleteMutation = trpc.connector.delete.useMutation({
    onSuccess: () => {
      if (workspaceId !== null) utils.connector.list.invalidate({ workspaceId, projectId: projectId ?? undefined });
    },
  });

  const projects: Project[] = projectList.data ?? [];
  const rows: Connector[] = listQuery.data ?? [];

  const projectOptions = [
    { value: "", label: "全部项目" },
    ...projects.map((p) => ({ value: String(p.id), label: `${p.name} (#${p.id})` })),
  ];

  const closeModal = () => {
    setShowModal(false);
    setEditing(null);
    setForm(emptyForm);
  };

  const openCreate = () => {
    setEditing(null);
    setForm(emptyForm);
    setShowModal(true);
  };

  const openEdit = (row: Connector) => {
    setEditing(row);
    setForm({
      name: row.name,
      slug: row.slug,
      connectorType: row.connectorType,
      status: row.status,
      endpoint: "",
      secretRefId: "",
    });
    setShowModal(true);
  };

  const handleSave = () => {
    if (!form.name.trim() || !form.slug.trim() || workspaceId === null) return;
    const payload = {
      name: form.name.trim(),
      slug: form.slug.trim(),
      connectorType: form.connectorType,
      status: form.status,
      endpoint: form.endpoint.trim() || undefined,
      secretRefId: form.secretRefId.trim() ? Number(form.secretRefId) : undefined,
    };
    if (editing) {
      updateMutation.mutate({ connectorId: editing.id, ...payload });
    } else {
      createMutation.mutate({ workspaceId, projectId: projectId ?? undefined, ...payload });
    }
  };

  const handleDelete = (row: Connector) => {
    if (!confirm(`确认删除连接器 "${row.name}"?`)) return;
    deleteMutation.mutate({ connectorId: row.id });
  };

  if (workspaceId === null) {
    return (
      <div className="glass-panel p-4 sci-border">
        <SectionLabel>连接器 · CONNECTORS</SectionLabel>
        <div className="text-xs py-4" style={{ color: "var(--text-muted)" }}>请先选择一个工作区</div>
      </div>
    );
  }

  return (
    <div className="glass-panel p-4 sci-border">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
        <SectionLabel>连接器 · CONNECTORS</SectionLabel>
        <div className="flex items-center gap-2">
          <SelectField
            label="项目筛选"
            value={projectId === null ? "" : String(projectId)}
            onChange={(v) => setProjectId(v ? Number(v) : null)}
            options={projectOptions}
          />
          <Button variant="primary" onClick={openCreate}>
            <span className="flex items-center gap-1.5">
              <Plus size={12} /> 新建连接器
            </span>
          </Button>
        </div>
      </div>

      {listQuery.isLoading ? (
        <div className="text-xs p-4" style={{ color: "var(--text-muted)" }}>加载中...</div>
      ) : rows.length === 0 ? (
        <EmptyState title="暂无连接器" desc="点击「新建连接器」创建" icon={<Plug size={32} />} />
      ) : (
        <div className="overflow-x-auto custom-scrollbar">
          <table className="w-full text-xs font-mono">
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border-default)" }}>
                {["ID", "名称", "Slug", "类型", "状态", "更新时间", "操作"].map((h) => (
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
                    <Badge color="cyan">{row.connectorType}</Badge>
                  </td>
                  <td className="py-2 px-3">
                    <Badge color={row.status === "active" ? "green" : row.status === "disabled" ? "red" : "muted"}>{row.status}</Badge>
                  </td>
                  <td className="py-2 px-3" style={{ color: "var(--text-muted)" }}>{formatDateTime(row.updatedAt)}</td>
                  <td className="py-2 px-3">
                    <div className="flex items-center gap-2">
                      <InlineButton onClick={() => openEdit(row)} icon={<Edit3 size={12} />} title="编辑" />
                      <InlineButton onClick={() => handleDelete(row)} icon={<Trash2 size={12} />} title="删除" danger />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showModal && (
        <Modal
          title={editing ? "编辑连接器" : "新建连接器"}
          onClose={closeModal}
          footer={
            <>
              <Button variant="secondary" onClick={closeModal}>取消</Button>
              <Button variant="primary" onClick={handleSave} disabled={!form.name.trim() || !form.slug.trim() || createMutation.isPending || updateMutation.isPending}>
                {createMutation.isPending || updateMutation.isPending ? "保存中..." : "保存"}
              </Button>
            </>
          }
        >
          <div className="space-y-3">
            <TextField label="名称 *" value={form.name} onChange={(v) => setForm({ ...form, name: v })} placeholder="如 opencode-main" />
            <TextField label="Slug *" value={form.slug} onChange={(v) => setForm({ ...form, slug: v })} placeholder="如 opencode-main" disabled={!!editing} />
            <SelectField
              label="类型"
              value={form.connectorType}
              onChange={(v) => setForm({ ...form, connectorType: parseLiteral(v, CONNECTOR_TYPES) })}
              options={typeOptions}
            />
            <SelectField
              label="状态"
              value={form.status}
              onChange={(v) => setForm({ ...form, status: parseLiteral(v, CONNECTOR_STATUSES) })}
              options={statusOptions}
            />
            <TextField label="Endpoint" value={form.endpoint} onChange={(v) => setForm({ ...form, endpoint: v })} placeholder="https://..." />
            <TextField label="Secret Ref ID" value={form.secretRefId} onChange={(v) => setForm({ ...form, secretRefId: v })} type="number" placeholder="可选：关联密钥 ID" />
          </div>
        </Modal>
      )}
    </div>
  );
}
