import { useCallback } from "react";
import { trpc } from "@/providers/trpc";

export interface AuthUser {
  id: number;
  username?: string;
  name: string;
  role: string;
}

const TOKEN_KEY = "tiangong_token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function removeToken() {
  localStorage.removeItem(TOKEN_KEY);
}

export function useAuth() {
  const { data: user, isLoading } = trpc.auth.me.useQuery(undefined, {
    retry: false,
    refetchOnWindowFocus: false,
  });

  const logout = useCallback(() => {
    removeToken();
    window.location.reload();
  }, []);

  return {
    user: user as AuthUser | null,
    isLoading,
    isAuthenticated: !!user,
    isAdmin: user?.role === "admin",
    logout,
  };
}
