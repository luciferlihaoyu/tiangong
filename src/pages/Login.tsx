import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { setToken } from "@/hooks/useAuth";

/* 固定位置的星星，避免每次渲染闪烁跳动 */
const STARFIELD = [
  { top: "6%", left: "12%", size: 2, delay: "0s" },
  { top: "12%", left: "78%", size: 1.5, delay: "0.8s" },
  { top: "22%", left: "35%", size: 1, delay: "1.6s" },
  { top: "30%", left: "88%", size: 2, delay: "0.4s" },
  { top: "42%", left: "8%", size: 1.5, delay: "2.2s" },
  { top: "55%", left: "92%", size: 1, delay: "1.1s" },
  { top: "63%", left: "18%", size: 2, delay: "2.8s" },
  { top: "70%", left: "65%", size: 1.5, delay: "0.6s" },
  { top: "80%", left: "40%", size: 1, delay: "1.9s" },
  { top: "88%", left: "82%", size: 2, delay: "2.5s" },
  { top: "15%", left: "55%", size: 1, delay: "3.1s" },
  { top: "48%", left: "48%", size: 1, delay: "0.2s" },
  { top: "76%", left: "28%", size: 1.5, delay: "1.4s" },
  { top: "35%", left: "62%", size: 1, delay: "2.0s" },
];

export default function Login() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  const loginMutation = trpc.auth.login.useMutation({
    onSuccess: (data) => {
      if ("token" in data && data.token) {
        setToken(data.token);
        window.location.href = "/";
      } else if ("error" in data) {
        setError(data.error as string);
      } else {
        setError("登录失败");
      }
    },
    onError: (err) => setError(err.message),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!username.trim() || !password.trim()) {
      setError("请填写用户名和密码");
      return;
    }
    loginMutation.mutate({ username, password });
  };

  return (
    <div
      className="min-h-screen flex items-center justify-center px-4 bg-grid relative overflow-hidden"
      style={{ backgroundColor: "var(--bg-primary)" }}
    >
      {/* 星云氛围：朱红 + 金色双层辉光 */}
      <div
        className="fixed inset-0 z-0 pointer-events-none"
        style={{
          background:
            "radial-gradient(ellipse at 50% 25%, rgba(194,58,48,0.07) 0%, transparent 50%)," +
            "radial-gradient(ellipse at 80% 80%, rgba(201,168,76,0.05) 0%, transparent 45%)",
        }}
      />
      {/* 闪烁星点 */}
      {STARFIELD.map((s, i) => (
        <span
          key={i}
          className="fixed z-0 rounded-full pointer-events-none animate-pulse"
          style={{
            top: s.top,
            left: s.left,
            width: s.size,
            height: s.size,
            background: "var(--accent-gold)",
            opacity: 0.5,
            animationDelay: s.delay,
            animationDuration: "3s",
          }}
        />
      ))}

      <div className="relative z-10 w-full max-w-sm">
        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <div
            className="w-12 h-12 flex items-center justify-center rounded-sm mb-3"
            style={{ background: "var(--accent-red)", boxShadow: "0 0 24px rgba(194,58,48,0.4)" }}
          >
            <span className="text-white text-lg font-black">天宫</span>
          </div>
          <h1
            className="text-2xl font-black tracking-[0.3em]"
            style={{
              background: "linear-gradient(90deg, var(--accent-red-bright), var(--accent-gold-bright))",
              WebkitBackgroundClip: "text",
              backgroundClip: "text",
              color: "transparent",
            }}
          >
            天宫
          </h1>
          <p className="text-xs mt-1.5 font-mono tracking-widest" style={{ color: "var(--text-muted)" }}>
            TIANGONG · AGENT HUB
          </p>
        </div>

        {/* Login Form */}
        <div className="glass-panel p-6 sci-border">
          <div className="section-label mb-4">用户登录 · LOGIN</div>

          <form onSubmit={handleSubmit} className="flex flex-col gap-3">
            <div>
              <label className="text-[10px] font-mono mb-1 block" style={{ color: "var(--text-muted)" }}>
                用户名 · USERNAME
              </label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="请输入用户名"
                autoComplete="username"
                className="w-full px-3 py-2 rounded text-sm outline-none transition-all"
                style={{
                  background: "rgba(0,0,0,0.2)",
                  border: "1px solid var(--border-default)",
                  color: "var(--text-primary)",
                }}
                onFocus={(e) => (e.currentTarget.style.borderColor = "var(--accent-red)")}
                onBlur={(e) => (e.currentTarget.style.borderColor = "var(--border-default)")}
              />
            </div>

            <div>
              <label className="text-[10px] font-mono mb-1 block" style={{ color: "var(--text-muted)" }}>
                密码 · PASSWORD
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••"
                autoComplete="current-password"
                className="w-full px-3 py-2 rounded text-sm outline-none transition-all"
                style={{
                  background: "rgba(0,0,0,0.2)",
                  border: "1px solid var(--border-default)",
                  color: "var(--text-primary)",
                }}
                onFocus={(e) => (e.currentTarget.style.borderColor = "var(--accent-red)")}
                onBlur={(e) => (e.currentTarget.style.borderColor = "var(--border-default)")}
              />
            </div>

            {error && (
              <div
                className="text-xs px-2 py-1.5 rounded font-mono"
                style={{ background: "var(--accent-glow-red)", color: "var(--accent-red)" }}
              >
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loginMutation.isPending}
              className="w-full py-2.5 rounded text-xs font-bold tracking-[0.2em] transition-all hover:brightness-110 disabled:opacity-50"
              style={{
                background: "linear-gradient(90deg, var(--accent-red), var(--accent-red-bright))",
                color: "#fff",
                boxShadow: "0 0 16px rgba(194,58,48,0.25)",
              }}
            >
              {loginMutation.isPending ? "登录中..." : "登 录"}
            </button>
          </form>
        </div>

        {/* Hint — 账号由管理员创建，无公开注册 */}
        <div className="mt-4 text-center">
          <p className="text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>
            账号由管理员创建 · 如需账号或忘记密码请联系管理员
          </p>
        </div>
      </div>
    </div>
  );
}
