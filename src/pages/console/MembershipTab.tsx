/**
 * Phase 1 Task 7: Membership metadata CRUD tab.
 */
import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { Plus, Trash2, Users } from "lucide-react";
import { MEMBERSHIP_ROLES, type Membership, type MembershipRole } from "./types";
import { Modal, TextField, SelectField, Button, SectionLabel, EmptyState, InlineButton } from "./ui";
import { formatDateTime, parseMembershipRole } from "./format";

type MembershipForm = {
  userId: string;
  role: MembershipRole;
};

const emptyForm: MembershipForm = { userId: "", role: "member" };

const roleOptions = MEMBERSHIP_ROLES.map((r) => ({ value: r, label: r }));

export default function MembershipTab({ workspaceId }: { readonly workspaceId: number | null }) {
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState<MembershipForm>(emptyForm);

  const listQuery = trpc.workspace.membershipList.useQuery(
    { workspaceId: workspaceId ?? 0 },
    { enabled: workspaceId !== null, retry: 1, staleTime: 10_000 }
  );
  const utils = trpc.useUtils();

  const addMutation = trpc.workspace.membershipAdd.useMutation({
    onSuccess: () => {
      if (workspaceId !== null) utils.workspace.membershipList.invalidate({ workspaceId });
      closeModal();
    },
  });

  const updateRoleMutation = trpc.workspace.membershipUpdateRole.useMutation({
    onSuccess: () => {
      if (workspaceId !== null) utils.workspace.membershipList.invalidate({ workspaceId });
    },
  });

  const removeMutation = trpc.workspace.membershipRemove.useMutation({
    onSuccess: () => {
      if (workspaceId !== null) utils.workspace.membershipList.invalidate({ workspaceId });
    },
  });

  const rows: Membership[] = listQuery.data ?? [];

  const closeModal = () => {
    setShowModal(false);
    setForm(emptyForm);
  };

  const handleAdd = () => {
    if (!form.userId.trim() || workspaceId === null) return;
    addMutation.mutate({ workspaceId, userId: Number(form.userId), role: form.role });
  };

  const handleRoleChange = (row: Membership, role: MembershipRole) => {
    if (workspaceId === null) return;
    updateRoleMutation.mutate({ workspaceId, userId: row.userId, role });
  };

  const handleRemove = (row: Membership) => {
    if (!confirm(`确认移除成员 "${row.name ?? row.username ?? row.userId}"?`)) return;
    if (workspaceId === null) return;
    removeMutation.mutate({ workspaceId, userId: row.userId });
  };

  if (workspaceId === null) {
    return (
      <div className="glass-panel p-4 sci-border">
        <SectionLabel>成员 · MEMBERSHIPS</SectionLabel>
        <div className="text-xs py-4" style={{ color: "var(--text-muted)" }}>请先选择一个工作区</div>
      </div>
    );
  }

  return (
    <div className="glass-panel p-4 sci-border">
      <div className="flex items-center justify-between mb-4">
        <SectionLabel>成员 · MEMBERSHIPS</SectionLabel>
        <Button variant="primary" onClick={() => setShowModal(true)}>
          <span className="flex items-center gap-1.5">
            <Plus size={12} /> 添加成员
          </span>
        </Button>
      </div>

      {listQuery.isLoading ? (
        <div className="text-xs p-4" style={{ color: "var(--text-muted)" }}>加载中...</div>
      ) : rows.length === 0 ? (
        <EmptyState title="暂无成员" desc="点击「添加成员」邀请用户" icon={<Users size={32} />} />
      ) : (
        <div className="overflow-x-auto custom-scrollbar">
          <table className="w-full text-xs font-mono">
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border-default)" }}>
                {["ID", "用户", "角色", "加入时间", "操作"].map((h) => (
                  <th key={h} className="text-left py-2 px-3" style={{ color: "var(--text-muted)", fontWeight: 400 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="hover:bg-[rgba(180,200,255,0.02)]" style={{ borderBottom: "1px solid rgba(255,255,255,0.03)" }}>
                  <td className="py-2 px-3" style={{ color: "var(--text-muted)" }}>#{row.id}</td>
                  <td className="py-2 px-3" style={{ color: "var(--text-primary)" }}>
                    {row.name ?? row.username ?? `User#${row.userId}`}
                    <span className="ml-2 text-[10px]" style={{ color: "var(--text-muted)" }}>#{row.userId}</span>
                  </td>
                  <td className="py-2 px-3">
                    <select
                      value={row.role}
                      onChange={(e) => handleRoleChange(row, parseMembershipRole(e.target.value))}
                      className="px-2 py-1 rounded text-[10px] font-mono outline-none"
                      style={{ background: "rgba(0,0,0,0.2)", border: "1px solid var(--border-default)", color: "var(--text-primary)" }}
                    >
                      {MEMBERSHIP_ROLES.map((r) => (
                        <option key={r} value={r}>{r}</option>
                      ))}
                    </select>
                  </td>
                  <td className="py-2 px-3" style={{ color: "var(--text-muted)" }}>{formatDateTime(row.createdAt)}</td>
                  <td className="py-2 px-3">
                    <InlineButton onClick={() => handleRemove(row)} icon={<Trash2 size={12} />} title="移除" danger />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showModal && (
        <Modal
          title="添加成员"
          onClose={closeModal}
          footer={
            <>
              <Button variant="secondary" onClick={closeModal}>取消</Button>
              <Button variant="primary" onClick={handleAdd} disabled={!form.userId.trim() || addMutation.isPending}>
                {addMutation.isPending ? "添加中..." : "添加"}
              </Button>
            </>
          }
        >
          <div className="space-y-3">
            <TextField label="用户 ID *" value={form.userId} onChange={(v) => setForm({ ...form, userId: v })} type="number" placeholder="如 42" />
            <SelectField
              label="角色"
              value={form.role}
              onChange={(v) => setForm({ ...form, role: parseMembershipRole(v) })}
              options={roleOptions}
            />
          </div>
        </Modal>
      )}
    </div>
  );
}
