/**
 * Phase 1 Task 7: Workspace metadata CRUD tab.
 */
import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { Plus, Edit3, Trash2, Layers } from "lucide-react";
import type { Workspace } from "./types";
import { Modal, TextField, Button, SectionLabel, EmptyState, InlineButton } from "./ui";
import { formatDateTime } from "./format";

type WorkspaceForm = {
  name: string;
  slug: string;
  description: string;
};

const emptyForm: WorkspaceForm = { name: "", slug: "", description: "" };

export default function WorkspaceTab() {
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<Workspace | null>(null);
  const [form, setForm] = useState<WorkspaceForm>(emptyForm);

  const listQuery = trpc.workspace.list.useQuery(undefined, { retry: 1, staleTime: 10_000 });
  const utils = trpc.useUtils();

  const createMutation = trpc.workspace.create.useMutation({
    onSuccess: () => {
      utils.workspace.list.invalidate();
      closeModal();
    },
  });

  const updateMutation = trpc.workspace.update.useMutation({
    onSuccess: () => {
      utils.workspace.list.invalidate();
      closeModal();
    },
  });

  const deleteMutation = trpc.workspace.delete.useMutation({
    onSuccess: () => utils.workspace.list.invalidate(),
  });

  const rows: Workspace[] = listQuery.data ?? [];

  const openCreate = () => {
    setEditing(null);
    setForm(emptyForm);
    setShowModal(true);
  };

  const openEdit = (row: Workspace) => {
    setEditing(row);
    setForm({ name: row.name, slug: row.slug, description: row.description ?? "" });
    setShowModal(true);
  };

  const closeModal = () => {
    setShowModal(false);
    setEditing(null);
    setForm(emptyForm);
  };

  const handleSave = () => {
    if (!form.name.trim() || !form.slug.trim()) return;
    const payload = { name: form.name.trim(), slug: form.slug.trim(), description: form.description.trim() || undefined };
    if (editing) {
      updateMutation.mutate({ workspaceId: editing.id, ...payload });
    } else {
      createMutation.mutate(payload);
    }
  };

  const handleDelete = (row: Workspace) => {
    if (!confirm(`确认删除工作区 "${row.name}"? 关联项目、密钥、连接器、工件将被级联删除。`)) return;
    deleteMutation.mutate({ workspaceId: row.id });
  };

  return (
    <div className="glass-panel p-4 sci-border">
      <div className="flex items-center justify-between mb-4">
        <SectionLabel>工作区 · WORKSPACES</SectionLabel>
        <Button variant="primary" onClick={openCreate}>
          <span className="flex items-center gap-1.5">
            <Plus size={12} /> 新建工作区
          </span>
        </Button>
      </div>

      {listQuery.isLoading ? (
        <div className="text-xs p-4" style={{ color: "var(--text-muted)" }}>加载中...</div>
      ) : rows.length === 0 ? (
        <EmptyState title="暂无工作区" desc="点击「新建工作区」创建" icon={<Layers size={32} />} />
      ) : (
        <div className="overflow-x-auto custom-scrollbar">
          <table className="w-full text-xs font-mono">
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border-default)" }}>
                {["ID", "名称", "Slug", "描述", "所有者", "创建时间", "操作"].map((h) => (
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
                  <td className="py-2 px-3 truncate max-w-48" style={{ color: "var(--text-muted)" }}>{row.description ?? "-"}</td>
                  <td className="py-2 px-3" style={{ color: "var(--text-muted)" }}>#{row.ownerId}</td>
                  <td className="py-2 px-3" style={{ color: "var(--text-muted)" }}>{formatDateTime(row.createdAt)}</td>
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
          title={editing ? "编辑工作区" : "新建工作区"}
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
            <TextField label="名称 *" value={form.name} onChange={(v) => setForm({ ...form, name: v })} placeholder="如 prod" />
            <TextField label="Slug *" value={form.slug} onChange={(v) => setForm({ ...form, slug: v })} placeholder="如 prod-env" disabled={!!editing} />
            <TextField label="描述" value={form.description} onChange={(v) => setForm({ ...form, description: v })} placeholder="可选" />
          </div>
        </Modal>
      )}
    </div>
  );
}
