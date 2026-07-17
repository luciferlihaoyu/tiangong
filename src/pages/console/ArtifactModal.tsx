/**
 * Phase 1 Task 7: Artifact create/edit modal.
 */
import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { ARTIFACT_TYPES, ARTIFACT_STATUSES, STORAGE_BACKREF_TYPES, type Artifact, type ArtifactType, type ArtifactStatus, type StorageBackrefType } from "./types";
import { Modal, TextField, SelectField, Button } from "./ui";
import { parseLiteral } from "./format";

type ArtifactForm = {
  name: string;
  slug: string;
  artifactType: ArtifactType;
  status: ArtifactStatus;
  mimeType: string;
  sizeBytes: string;
  checksumSha256: string;
  storageBackrefType: StorageBackrefType;
  storageBackrefId: string;
};

const emptyForm: ArtifactForm = {
  name: "", slug: "", artifactType: "file", status: "draft", mimeType: "", sizeBytes: "",
  checksumSha256: "", storageBackrefType: "inline", storageBackrefId: "",
};

const typeOptions = ARTIFACT_TYPES.map((t) => ({ value: t, label: t }));
const statusOptions = ARTIFACT_STATUSES.map((s) => ({ value: s, label: s }));
const backrefOptions = STORAGE_BACKREF_TYPES.map((t) => ({ value: t, label: t }));

function parseOptionalNumber(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.floor(n);
}

type ArtifactModalProps = {
  readonly workspaceId: number;
  readonly projectId: number | null;
  readonly editing: Artifact | null;
  readonly onClose: () => void;
};

export default function ArtifactModal({ workspaceId, projectId, editing, onClose }: ArtifactModalProps) {
  const [form, setForm] = useState<ArtifactForm>(() =>
    editing
      ? {
          name: editing.name,
          slug: editing.slug,
          artifactType: editing.artifactType,
          status: editing.status,
          mimeType: editing.mimeType ?? "",
          sizeBytes: editing.sizeBytes !== null ? String(editing.sizeBytes) : "",
          checksumSha256: editing.checksumSha256 ?? "",
          storageBackrefType: editing.storageBackrefType ?? "inline",
          storageBackrefId: editing.storageBackrefId ?? "",
        }
      : emptyForm
  );

  const utils = trpc.useUtils();

  const createMutation = trpc.artifact.create.useMutation({
    onSuccess: () => {
      utils.artifact.list.invalidate({ workspaceId, projectId: projectId ?? undefined });
      onClose();
    },
  });

  const updateMutation = trpc.artifact.update.useMutation({
    onSuccess: () => {
      utils.artifact.list.invalidate({ workspaceId, projectId: projectId ?? undefined });
      onClose();
    },
  });

  const buildPayload = () => ({
    name: form.name.trim(),
    slug: form.slug.trim(),
    artifactType: form.artifactType,
    status: form.status,
    mimeType: form.mimeType.trim() || undefined,
    sizeBytes: parseOptionalNumber(form.sizeBytes),
    checksumSha256: form.checksumSha256.trim() || undefined,
    storageBackrefType: form.storageBackrefType,
    storageBackrefId: form.storageBackrefId.trim() || undefined,
  });

  const handleSave = () => {
    if (!form.name.trim() || !form.slug.trim()) return;
    const payload = buildPayload();
    if (editing) {
      updateMutation.mutate({ artifactId: editing.id, ...payload });
    } else {
      createMutation.mutate({ workspaceId, projectId: projectId ?? undefined, ...payload });
    }
  };

  return (
    <Modal
      title={editing ? "编辑工件" : "新建工件"}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={handleSave} disabled={!form.name.trim() || !form.slug.trim() || createMutation.isPending || updateMutation.isPending}>
            {createMutation.isPending || updateMutation.isPending ? "保存中..." : "保存"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <TextField label="名称 *" value={form.name} onChange={(v) => setForm({ ...form, name: v })} placeholder="如 report-2026" />
        <TextField label="Slug *" value={form.slug} onChange={(v) => setForm({ ...form, slug: v })} placeholder="如 report-2026" disabled={!!editing} />
        <SelectField label="类型" value={form.artifactType} onChange={(v) => setForm({ ...form, artifactType: parseLiteral(v, ARTIFACT_TYPES) })} options={typeOptions} />
        <SelectField label="状态" value={form.status} onChange={(v) => setForm({ ...form, status: parseLiteral(v, ARTIFACT_STATUSES) })} options={statusOptions} />
        <TextField label="MIME Type" value={form.mimeType} onChange={(v) => setForm({ ...form, mimeType: v })} placeholder="如 application/json" />
        <TextField label="大小 (bytes)" value={form.sizeBytes} onChange={(v) => setForm({ ...form, sizeBytes: v })} type="number" placeholder="可选" />
        <TextField label="SHA-256" value={form.checksumSha256} onChange={(v) => setForm({ ...form, checksumSha256: v })} placeholder="64 位十六进制，可选" />
        <SelectField label="存储引用类型" value={form.storageBackrefType} onChange={(v) => setForm({ ...form, storageBackrefType: parseLiteral(v, STORAGE_BACKREF_TYPES) })} options={backrefOptions} />
        <TextField label="存储引用 ID" value={form.storageBackrefId} onChange={(v) => setForm({ ...form, storageBackrefId: v })} placeholder="可选 opaque id" />
      </div>
    </Modal>
  );
}
