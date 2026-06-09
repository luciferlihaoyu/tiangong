/**
 * 天宫 账户设置页面
 * 修改密码、查看登录信息
 */

import { useState } from "react";
import { useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

async function trpcCall(path: string, input?: any): Promise<any> {
  const token = localStorage.getItem("tiangong_token");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const url = `/api/trpc/${path}`;
  const res = await fetch(url, {
    method: input !== undefined ? "POST" : "GET",
    headers,
    body: input !== undefined ? JSON.stringify(input) : undefined,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: `HTTP ${res.status}` }));
    throw new Error(err?.message || err?.[0]?.message || `HTTP ${res.status}`);
  }

  return res.json();
}

export default function AccountSettings() {
  const navigate = useNavigate();
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [loading, setLoading] = useState(false);

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage(null);

    if (newPassword.length < 4) {
      setMessage({ type: "error", text: "新密码至少 4 位" });
      return;
    }
    if (newPassword !== confirmPassword) {
      setMessage({ type: "error", text: "两次输入的新密码不一致" });
      return;
    }

    setLoading(true);
    try {
      const res = await trpcCall("auth.changePassword", { oldPassword, newPassword });
      const data = res?.result?.data?.json || res?.result?.data || res;
      if (data?.success) {
        setMessage({ type: "success", text: "密码修改成功" });
        setOldPassword("");
        setNewPassword("");
        setConfirmPassword("");
      } else {
        setMessage({ type: "error", text: data?.error || "修改失败" });
      }
    } catch (e: any) {
      setMessage({ type: "error", text: e.message });
    } finally {
      setLoading(false);
    }
  };

  const username = localStorage.getItem("tiangong_user") || "管理员";

  return (
    <div className="max-w-md mx-auto mt-8">
      <div className="glass-panel p-6 sci-border">
        <div className="flex items-center justify-between mb-4">
          <div className="section-label">账户设置 · ACCOUNT</div>
          <button
            onClick={() => navigate('/')}
            className="text-xs font-mono px-2 py-1 rounded hover:bg-[rgba(180,200,255,0.04)] transition-colors"
            style={{ color: 'var(--text-muted)', border: '1px solid var(--border-default)' }}
          >
            ← 返回首页
          </button>
        </div>

        {/* 用户信息 */}
        <div className="mb-6 p-3 rounded" style={{ background: "rgba(255,255,255,0.03)", border: "1px solid var(--border-default)" }}>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold"
              style={{ background: "var(--accent-glow-red)", color: "var(--accent-red-bright)" }}>
              {username[0]}
            </div>
            <div>
              <div className="text-sm font-bold" style={{ color: "var(--text-primary)" }}>{username}</div>
              <div className="text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>管理员</div>
            </div>
          </div>
        </div>

        {/* 修改密码 */}
        <form onSubmit={handleChangePassword} className="flex flex-col gap-4">
          <div className="text-xs font-mono font-bold mb-1" style={{ color: "var(--accent-gold)" }}>
            修改密码 · CHANGE PASSWORD
          </div>

          <div>
            <Label className="text-[10px] font-mono mb-1 block" style={{ color: "var(--text-muted)" }}>
              原密码
            </Label>
            <Input
              type="password"
              value={oldPassword}
              onChange={e => setOldPassword(e.target.value)}
              required
              style={{
                background: "rgba(0,0,0,0.2)",
                border: "1px solid var(--border-default)",
                color: "var(--text-primary)",
              }}
            />
          </div>

          <div>
            <Label className="text-[10px] font-mono mb-1 block" style={{ color: "var(--text-muted)" }}>
              新密码
            </Label>
            <Input
              type="password"
              value={newPassword}
              onChange={e => setNewPassword(e.target.value)}
              required
              minLength={4}
              style={{
                background: "rgba(0,0,0,0.2)",
                border: "1px solid var(--border-default)",
                color: "var(--text-primary)",
              }}
            />
          </div>

          <div>
            <Label className="text-[10px] font-mono mb-1 block" style={{ color: "var(--text-muted)" }}>
              确认新密码
            </Label>
            <Input
              type="password"
              value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)}
              required
              style={{
                background: "rgba(0,0,0,0.2)",
                border: "1px solid var(--border-default)",
                color: "var(--text-primary)",
              }}
            />
          </div>

          {message && (
            <div
              className="text-xs p-2 rounded"
              style={{
                background: message.type === "success" ? "rgba(0,200,100,0.1)" : "rgba(194,58,48,0.1)",
                color: message.type === "success" ? "var(--success)" : "var(--accent-red)",
                border: `1px solid ${message.type === "success" ? "rgba(0,200,100,0.2)" : "rgba(194,58,48,0.2)"}`,
              }}
            >
              {message.text}
            </div>
          )}

          <Button
            type="submit"
            disabled={loading}
            className="text-xs font-bold"
            style={{
              background: "var(--accent-red)",
              color: "#fff",
              boxShadow: "0 0 12px rgba(194,58,48,0.2)",
            }}
          >
            {loading ? "保存中..." : "修改密码"}
          </Button>
        </form>
      </div>
    </div>
  );
}
