import { createTRPCReact } from "@trpc/react-query";
import { httpLink } from "@trpc/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AppRouter } from "../../api/router";
import type { ReactNode } from "react";

export const trpc = createTRPCReact<AppRouter>();

// P0-2 查询风暴治理（碧霄 2026-02）：
// 此前零配置 = staleTime 0 + 窗口聚焦全量 refetch，任何组件挂载/切窗都会重拉整页查询。
// 全局改为 30s 内视为新鲜、聚焦不自动重拉；需要高鲜度的查询各自显式声明：
//   - office 位置 refetchInterval 5s、notifications 30s 轮询等不受 staleTime 影响，行为不变
//   - WS 事件驱动的 invalidateQueries 也不受 staleTime 限制，仍即时刷新
//   - retry 收敛到 1（原默认 3，后端故障时避免请求放大）
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

const trpcClient = trpc.createClient({
  links: [
    httpLink({
      url: "/api/trpc",
      headers() {
        const token = localStorage.getItem("tiangong_token");
        return token ? { Authorization: `Bearer ${token}` } : {};
      },
      fetch(input, init) {
        return globalThis.fetch(input, {
          ...(init ?? {}),
          credentials: "include",
        });
      },
    }),
  ],
});

export function TRPCProvider({ children }: { children: ReactNode }) {
  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    </trpc.Provider>
  );
}
