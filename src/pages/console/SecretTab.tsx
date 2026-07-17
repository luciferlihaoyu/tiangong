/**
 * Phase 1 Task 7: Secret Vault metadata CRUD tab.
 *
 * Metadata only: no encrypted payloads, internal envelope fields, or value retrieval.
 */
import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { Plus, Edit3, Trash2, Lock } from "lucide-react";
import type { Project, SecretRef } from "./types";
import { Modal, TextField, SelectField, Button, SectionLabel, EmptyState, InlineButton } from "./ui";
import { formatDateTime } from "./format";

type SecretForm = {
  name: string;
  description: string;
  plaintext: string;
};

const emptyForm: SecretForm = { name: "", description: "", plaintext: "" };

export default function SecretTab({ workspaceId }: { readonly workspaceId: number | null }) {
  const [projectId, setProjectId] = useState<number | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<SecretRef | null>(null);
  const [form, setForm] = useState<SecretForm>(emptyForm);

  const projectList = trpc.workspace.projectList.useQuery(
    { workspaceId: workspaceId ?? 0 },
    { enabled: workspaceId !== null, retry: 1, staleTime: 10_000 }
  );

  const listQuery = trpc.secretVault.list.useQuery(
    { workspaceId: workspaceId ?? 0, projectId: projectId ?? 0 },
    { enabled: workspaceId !== null && projectId !== null, retry: 1, staleTime: 10_000 }
  );

  const utils = trpc.useUtils();

  const createMutation = trpc.secretVault.create.useMutation({
    onSuccess: () => {
      if (workspaceId !== null && projectId !== null) utils.secretVault.list.invalidate({ workspaceId, projectId });
      closeModal();
    },
  });

  const updateMutation = trpc.secretVault.update.useMutation({
    onSuccess: () => {
      if (workspaceId !== null && projectId !== null) utils.secretVault.list.invalidate({ workspaceId, projectId });
      closeModal();
    },
  });

  const deleteMutation = trpc.secretVault.delete.useMutation({
    onSuccess: () => {
      if (workspaceId !== null && projectId !== null) utils.secretVault.list.invalidate({ workspaceId, projectId });
    },
  });

  const projects: Project[] = projectList.data ?? [];
  const rows: SecretRef[] = listQuery.data ?? [];

  const projectOptions = [
    { value: "", label: "选择项目" },
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

  const openEdit = (row: SecretRef) => {
    setEditing(row);
    setForm({ name: row.name, description: row.description ?? "", plaintext: "" });
    setShowModal(true);
  };

  const handleSave = () => {
    if (!form.name.trim() || workspaceId === null || projectId === null) return;
    const basePayload = {
      name: form.name.trim(),
      description: form.description.trim() || undefined,
    };
    if (editing) {
      const plaintext = form.plaintext.trim() || undefined;
      updateMutation.mutate({ itemId: editing.id, ...basePayload, plaintext });
    } else {
      if (!form.plaintext.trim()) return;
      createMutation.mutate({ workspaceId, projectId, ...basePayload, plaintext: form.plaintext.trim() });
    }
  };

  const handleDelete = (row: SecretRef) => {
    if (!confirm(`确认删除密钥 "${row.name}"?`)) return;
    deleteMutation.mutate({ itemId: row.id });
  };

  if (workspaceId === null) {
    return (
      <div className="glass-panel p-4 sci-border">
        <SectionLabel>密钥库 · SECRET VAULT</SectionLabel>
        <div className="text-xs py-4" style={{ color: "var(--text-muted)" }}>请先选择一个工作区</div>
      </div>
    );
  }

  return (
    <div className="glass-panel p-4 sci-border">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
        <SectionLabel>密钥库 · SECRET VAULT</SectionLabel>
        <div className="flex items-center gap-2">
          <SelectField
            label="项目"
            value={projectId === null ? "" : String(projectId)}
            onChange={(v) => setProjectId(v ? Number(v) : null)}
            options={projectOptions}
          />
          <Button variant="primary" onClick={openCreate} disabled={projectId === null}>
            <span className="flex items-center gap-1.5">
              <Plus size={12} /> 新建密钥
            </span>
          </Button>
        </div>
      </div>

      {listQuery.isLoading ? (
        <div className="text-xs p-4" style={{ color: "var(--text-muted)" }}>加载中...</div>
      ) : projectId === null ? (
        <div className="text-xs py-4" style={{ color: "var(--text-muted)" }}>请选择一个项目</div>
      ) : rows.length === 0 ? (
        <EmptyState title="暂无密钥" desc="点击「新建密钥」创建" icon={<Lock size={32} />} />
      ) : (
        <div className="overflow-x-auto custom-scrollbar">
          <table className="w-full text-xs font-mono">
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border-default)" }}>
                {["ID", "名称", "描述", "创建时间", "操作"].map((h) => (
                  <th key={h} className="text-left py-2 px-3" style={{ color: "var(--text-muted)", fontWeight: 400 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="hover:bg-[rgba(180,200,255,0.02)]" style={{ borderBottom: "1px solid rgba(255,255,255,0.03)" }}>
                  <td className="py-2 px-3" style={{ color: "var(--text-muted)" }}>#{row.id}</td>
                  <td className="py-2 px-3 truncate max-w-40" style={{ color: "var(--text-primary)" }}>{row.name}</td>
                  <td className="py-2 px-3 truncate max-w-48" style={{ color: "var(--text-muted)" }}>{row.description ?? "-"}</td>
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
          title={editing ? "编辑密钥" : "新建密钥"}
          onClose={closeModal}
          footer={
            <>
              <Button variant="secondary" onClick={closeModal}>取消</Button>
              <Button
                variant="primary"
                onClick={handleSave}
                disabled={!form.name.trim() || (!editing && !form.plaintext.trim()) || createMutation.isPending || updateMutation.isPending}
              >
                {createMutation.isPending || updateMutation.isPending ? "保存中..." : "保存"}
              </Button>
            </>
          }
        >
          <div className="space-y-3">
            <TextField label="名称 *" value={form.name} onChange={(v) => setForm({ ...form, name: v })} placeholder="如 api-key" disabled={!!editing} />
            <TextField label="描述" value={form.description} onChange={(v) => setForm({ ...form, description: v })} placeholder="可选" />
            <TextField
              label={editing ? "新值（留空则只更新描述）" : "明文值 *"}
              value={form.plaintext}
              onChange={(v) => setForm({ ...form, plaintext: v })}
              type="password"
              placeholder={editing ? "输入新值以重新加密" : "输入密钥值"}
            />
          </div>
        </Modal>
      )}
    </div>
  );
}
