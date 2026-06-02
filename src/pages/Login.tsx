import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { setToken } from "@/hooks/useAuth";

export default function Login() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isRegister, setIsRegister] = useState(false);
  const [regName, setRegName] = useState("");

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

  const registerMutation = trpc.auth.register.useMutation({
    onSuccess: (data) => {
      if ("success" in data && data.success) {
        setIsRegister(false);
        setError("");
        loginMutation.mutate({ username, password });
      } else if ("error" in data) {
        setError(data.error as string);
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
    if (isRegister) {
      registerMutation.mutate({ username, password, name: regName || username });
    } else {
      loginMutation.mutate({ username, password });
    }
  };

  const isLoading = loginMutation.isPending || registerMutation.isPending;

  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-grid" style={{ backgroundColor: 'var(--bg-primary)' }}>
      <div className="fixed inset-0 z-0" style={{ background: 'radial-gradient(ellipse at 50% 30%, rgba(194,58,48,0.04) 0%, transparent 50%)' }} />

      <div className="relative z-10 w-full max-w-sm">
        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <div className="w-12 h-12 flex items-center justify-center rounded-sm mb-3"
            style={{ background: 'var(--accent-red)', boxShadow: '0 0 20px rgba(194,58,48,0.3)' }}>
            <span className="text-white text-lg font-black">天宫</span>
          </div>
          <h1 className="text-xl font-black tracking-widest" style={{ color: 'var(--text-primary)' }}>
            天宫
          </h1>
          <p className="text-xs mt-1 font-mono" style={{ color: 'var(--text-muted)' }}>
            TIANGONG · AGENT HUB
          </p>
        </div>

        {/* Login Form */}
        <div className="glass-panel p-6 sci-border">
          <div className="section-label mb-4">
            {isRegister ? '注册新账号 · REGISTER' : '用户登录 · LOGIN'}
          </div>

          <form onSubmit={handleSubmit} className="flex flex-col gap-3">
            <div>
              <label className="text-[10px] font-mono mb-1 block" style={{ color: 'var(--text-muted)' }}>
                用户名 · USERNAME
              </label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="admin"
                className="w-full px-3 py-2 rounded text-sm outline-none transition-all"
                style={{
                  background: 'rgba(0,0,0,0.2)',
                  border: '1px solid var(--border-default)',
                  color: 'var(--text-primary)',
                }}
                onFocus={(e) => e.currentTarget.style.borderColor = 'var(--accent-red)'}
                onBlur={(e) => e.currentTarget.style.borderColor = 'var(--border-default)'}
              />
            </div>

            {isRegister && (
              <div>
                <label className="text-[10px] font-mono mb-1 block" style={{ color: 'var(--text-muted)' }}>
                  昵称 · NAME
                </label>
                <input
                  type="text"
                  value={regName}
                  onChange={(e) => setRegName(e.target.value)}
                  placeholder="选填"
                  className="w-full px-3 py-2 rounded text-sm outline-none transition-all"
                  style={{
                    background: 'rgba(0,0,0,0.2)',
                    border: '1px solid var(--border-default)',
                    color: 'var(--text-primary)',
                  }}
                  onFocus={(e) => e.currentTarget.style.borderColor = 'var(--accent-red)'}
                  onBlur={(e) => e.currentTarget.style.borderColor = 'var(--border-default)'}
                />
              </div>
            )}

            <div>
              <label className="text-[10px] font-mono mb-1 block" style={{ color: 'var(--text-muted)' }}>
                密码 · PASSWORD
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••"
                className="w-full px-3 py-2 rounded text-sm outline-none transition-all"
                style={{
                  background: 'rgba(0,0,0,0.2)',
                  border: '1px solid var(--border-default)',
                  color: 'var(--text-primary)',
                }}
                onFocus={(e) => e.currentTarget.style.borderColor = 'var(--accent-red)'}
                onBlur={(e) => e.currentTarget.style.borderColor = 'var(--border-default)'}
              />
            </div>

            {error && (
              <div className="text-xs px-2 py-1.5 rounded font-mono" style={{ background: 'var(--accent-glow-red)', color: 'var(--accent-red)' }}>
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={isLoading}
              className="w-full py-2.5 rounded text-xs font-bold tracking-wider transition-all hover:brightness-110 disabled:opacity-50"
              style={{
                background: 'var(--accent-red)',
                color: '#fff',
                boxShadow: '0 0 16px rgba(194,58,48,0.2)',
              }}>
              {isLoading ? '处理中...' : isRegister ? '注册' : '登录'}
            </button>
          </form>

          <div className="mt-4 text-center">
            <button
              onClick={() => { setIsRegister(!isRegister); setError(''); }}
              className="text-xs font-mono transition-colors hover:text-[var(--accent-gold)]"
              style={{ color: 'var(--text-muted)' }}>
              {isRegister ? '已有账号？去登录 →' : '没有账号？去注册 →'}
            </button>
          </div>
        </div>

        {/* Hint */}
        <div className="mt-4 text-center">
          <p className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>
            默认管理员: admin / admin
          </p>
        </div>
      </div>
    </div>
  );
}
