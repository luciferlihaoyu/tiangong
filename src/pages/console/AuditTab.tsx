/**
 * Phase 1 Task 7: Audit log metadata query tab.
 *
 * Read-only metadata view. No mutation, no secret payload display.
 *
 * 附加：hash 链完整性校验入口（audit.verifyIntegrity，admin-only）。
 * audit_events 是 prev_hash → hash 的单链，一旦断链不可修复（任何 UPDATE/DELETE
 * 都会断），所以运维必须能在界面上自查，而不是等出事才想起来。
 */
import { useState } from "react";
import { AdminGate } from "@/components/AdminGate";
import { trpc } from "@/providers/trpc";
import { FileClock, ShieldCheck } from "lucide-react";
import type { AuditEvent } from "./types";
import { SectionLabel, EmptyState, Badge, Button } from "./ui";
import { formatDateTime, formatMetadata } from "./format";

const PAGE_SIZE = 50;

/** 断链明细最多列出这些条（全表可能断成百上千行，界面上只示范前几条） */
const MAX_BROKEN_SHOWN = 10;

export default function AuditTab({ workspaceId }: { readonly workspaceId: number | null }) {
  const [offset, setOffset] = useState(0);
  // 校验是重活（后端要走一遍全表重算 sha256），不能随 Tab 打开就自动跑，
  // 故用 enabled 模式按需触发：首次点击把开关打开，之后点击走 refetch 强制重算。
  const [verifyArmed, setVerifyArmed] = useState(false);

  const listQuery = trpc.audit.list.useQuery(
    { workspaceId: workspaceId ?? undefined, limit: PAGE_SIZE, offset },
    { enabled: workspaceId !== null, retry: 1, staleTime: 10_000 }
  );

  const integrityQuery = trpc.audit.verifyIntegrity.useQuery(undefined, {
    enabled: verifyArmed && workspaceId !== null,
    retry: 0,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  const rows: AuditEvent[] = listQuery.data ?? [];
  const hasMore = rows.length === PAGE_SIZE;

  const integrity = integrityQuery.data;
  const broken = integrity?.broken ?? [];

  const runVerify = () => {
    if (!verifyArmed) {
      setVerifyArmed(true); // 首次开启后由 enabled 触发请求
      return;
    }
    void integrityQuery.refetch();
  };

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
          {/* 后端 verifyIntegrity 是 adminQuery，非管理员点了只会拿到 403 红框；
              用 AdminGate 前置隐藏，避免把「没权限」伪装成「校验失败」。 */}
          <AdminGate>
            <Button
              onClick={runVerify}
              disabled={integrityQuery.isFetching}
              title="重算 audit_events 全表 hash 链并比对（需管理员权限，行数多时较慢）"
            >
              <span className="flex items-center gap-1.5">
                <ShieldCheck size={13} />
                {integrityQuery.isFetching ? "校验中..." : "校验完整性"}
              </span>
            </Button>
          </AdminGate>
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

      {/* 完整性校验结果：正常绿 / 断链红；断链意味着审计记录被改过或删过，不可修复 */}
      {verifyArmed && (
        <div className="mb-4">
          {integrityQuery.isFetching ? (
            <div
              className="text-xs font-mono px-3 py-2 rounded"
              style={{ border: "1px solid var(--border-default)", color: "var(--text-muted)" }}
            >
              校验中... 正在重算全表 hash 链
            </div>
          ) : integrityQuery.isError ? (
            <div
              className="text-xs font-mono px-3 py-2 rounded"
              style={{ border: "1px solid rgba(194,58,48,0.4)", background: "rgba(194,58,48,0.1)", color: "var(--accent-red)" }}
            >
              校验失败：{integrityQuery.error.message}
            </div>
          ) : integrity && broken.length === 0 ? (
            <div
              className="text-xs font-mono px-3 py-2 rounded"
              style={{ border: "1px solid rgba(76,175,125,0.4)", background: "rgba(76,175,125,0.1)", color: "var(--success)" }}
            >
              hash 链完整 · 已校验 {integrity.verified}/{integrity.total} 行
              {integrity.chainStartId !== null ? ` · 链起点 #${integrity.chainStartId}` : " · 尚无已上链行"}
              {integrity.legacyRows > 0 ? ` · ${integrity.legacyRows} 行为上链前遗留（hash 为空，不在链内）` : ""}
            </div>
          ) : integrity ? (
            <div
              className="text-xs font-mono px-3 py-2 rounded"
              style={{ border: "1px solid rgba(194,58,48,0.4)", background: "rgba(194,58,48,0.1)", color: "var(--accent-red)" }}
            >
              <div className="mb-1">
                hash 链已断：{broken.length} 行 hash 与重算值不一致（共 {integrity.total} 行已上链、{integrity.verified} 行通过）
                ，审计记录被改过或删过，无法修复。
              </div>
              <div className="space-y-0.5" style={{ color: "var(--text-secondary)" }}>
                {broken.slice(0, MAX_BROKEN_SHOWN).map((b) => (
                  <div key={b.id} className="truncate">
                    #{b.id} 期望 {b.expected.slice(0, 16)}… 实际 {b.actual.slice(0, 16)}…
                  </div>
                ))}
                {broken.length > MAX_BROKEN_SHOWN && (
                  <div>（其余 {broken.length - MAX_BROKEN_SHOWN} 行略）</div>
                )}
              </div>
            </div>
          ) : null}
        </div>
      )}

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
