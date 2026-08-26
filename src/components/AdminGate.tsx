/**
 * AdminGate — 管理员角色门控
 *
 * 背景：guard / github / pricing / tianshu / alist / taskboard / mcp 路由中的
 * 管理操作在后端均为 adminQuery（普通登录用户调用返回 403），但前端入口此前
 * 对所有用户可见，点击即报错。本组件基于 useAuth().isAdmin 在渲染层拦截。
 *
 * 用法一（默认，推荐）：非管理员直接不渲染子节点
 *   <AdminGate>
 *     <button onClick={...}>管理操作</button>
 *   </AdminGate>
 *
 * 用法二：非管理员显示置灰提示徽标
 *   <AdminGate fallback={<AdminOnlyBadge />}>
 *     <button onClick={...}>管理操作</button>
 *   </AdminGate>
 *
 * 说明：
 * - admin 用户行为完全不变；
 * - 鉴权状态解析期间（auth.me 加载中 / 未登录）isAdmin 为 false，同样隐藏，
 *   避免普通用户先看到按钮、请求失败后才消失的闪烁。
 */
import type { ReactNode } from "react";
import { useAuth } from "@/hooks/useAuth";

/**
 * 当前登录用户是否为管理员。
 * 未登录或鉴权未就绪时返回 false。
 */
export function useAdminGate(): boolean {
  const { isAdmin } = useAuth();
  return isAdmin;
}

interface AdminGateProps {
  children: ReactNode;
  /** 非管理员时渲染的替代内容；缺省渲染 null（完全隐藏） */
  fallback?: ReactNode;
}

export function AdminGate({ children, fallback = null }: AdminGateProps) {
  const isAdmin = useAdminGate();
  return <>{isAdmin ? children : fallback}</>;
}

interface AdminOnlyBadgeProps {
  /** 提示文案，默认「需要管理员权限」 */
  label?: string;
}

/** 可选的 fallback 徽标：置灰 + 提示，配合 <AdminGate fallback={...}> 使用 */
export function AdminOnlyBadge({ label = "需要管理员权限" }: AdminOnlyBadgeProps) {
  return (
    <span
      className="inline-flex items-center gap-1 text-[10px] px-2 py-1 rounded font-mono opacity-60 cursor-not-allowed"
      style={{ color: "var(--text-muted)", border: "1px dashed var(--border-default)" }}
      title="此操作仅限管理员使用"
    >
      🔒 {label}
    </span>
  );
}
