/**
 * Phase 1 Task 7: Audit log metadata query tab.
 *
 * Read-only metadata view. No mutation, no secret payload display.
 */
import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { FileClock } from "lucide-react";
import type { AuditEvent } from "./types";
import { SectionLabel, EmptyState, Badge } from "./ui";
import { formatDateTime, formatMetadata } from "./format";

const PAGE_SIZE = 50;

export default function AuditTab({ workspaceId }: { readonly workspaceId: number | null }) {
  const [offset, setOffset] = useState(0);

  const listQuery = trpc.audit.list.useQuery(
    { workspaceId: workspaceId ?? undefined, limit: PAGE_SIZE, offset },
    { enabled: workspaceId !== null, retry: 1, staleTime: 10_000 }
  );

  const rows: AuditEvent[] = listQuery.data ?? [];
  const hasMore = rows.length === PAGE_SIZE;

  if (workspaceId === null) {
    return (
      <div className="glass-panel p-4 sci-border">
        <SectionLabel>审计日志 · AUDIT LOGS</SectionLabel>
        <div className="text-xs py-4" style={{ color: "var(--text-muted)" }}>请先选择一个工作区</div>
      </div>
    );
  }

  return (
    <div className="glass-panel p-4 sci-border">
      <div className="flex items-center justify-between mb-4">
        <SectionLabel>审计日志 · AUDIT LOGS</SectionLabel>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setOffset((v) => Math.max(0, v - PAGE_SIZE))}
            disabled={offset === 0 || listQuery.isLoading}
            className="text-xs px-3 py-1.5 rounded font-mono disabled:opacity-50 transition-colors"
            style={{ border: "1px solid var(--border-default)", color: "var(--text-muted)" }}
          >
            上一页
          </button>
          <button
            onClick={() => setOffset((v) => v + PAGE_SIZE)}
            disabled={!hasMore || listQuery.isLoading}
            className="text-xs px-3 py-1.5 rounded font-mono disabled:opacity-50 transition-colors"
            style={{ border: "1px solid var(--border-default)", color: "var(--text-muted)" }}
          >
            下一页
          </button>
        </div>
      </div>

      {listQuery.isLoading ? (
        <div className="text-xs p-4" style={{ color: "var(--text-muted)" }}>加载中...</div>
      ) : rows.length === 0 ? (
        <EmptyState title="暂无审计日志" desc="当前工作区无事件记录" icon={<FileClock size={32} />} />
      ) : (
        <div className="overflow-x-auto custom-scrollbar">
          <table className="w-full text-xs font-mono">
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border-default)" }}>
                {["ID", "事件", "操作者", "实体", "时间", "元数据"].map((h) => (
                  <th key={h} className="text-left py-2 px-3" style={{ color: "var(--text-muted)", fontWeight: 400 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="hover:bg-[rgba(180,200,255,0.02)]" style={{ borderBottom: "1px solid rgba(255,255,255,0.03)" }}>
                  <td className="py-2 px-3" style={{ color: "var(--text-muted)" }}>#{row.id}</td>
                  <td className="py-2 px-3">
                    <Badge color={row.event.includes(":deleted") ? "red" : row.event.includes(":created") ? "green" : "cyan"}>{row.event}</Badge>
                  </td>
                  <td className="py-2 px-3" style={{ color: "var(--text-muted)" }}>#{row.actorUserId ?? "-"}</td>
                  <td className="py-2 px-3" style={{ color: "var(--text-muted)" }}>
                    {row.entityType ?? "-"} #{row.entityId ?? "-"}
                  </td>
                  <td className="py-2 px-3" style={{ color: "var(--text-muted)" }}>{formatDateTime(row.createdAt)}</td>
                  <td className="py-2 px-3 truncate max-w-64" style={{ color: "var(--text-secondary)" }}>
                    {formatMetadata(row.metadata)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
