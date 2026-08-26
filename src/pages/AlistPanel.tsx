/**
 * AList 网盘页面
 * - 连接配置（界面可改，优先于环境变量；密码永不回显）
 * - 连接状态（含真实读写探测）
 * - 文件浏览器（目录导航 + 下载链接）
 * - 任务产物自动上传状态说明
 */
import { useEffect, useState } from "react";
import { trpc } from "@/providers/trpc";
import { AdminGate } from "@/components/AdminGate";
import { HardDrive, RefreshCw, FolderOpen, File, ArrowLeft, ExternalLink, Save, Trash2, Settings2 } from "lucide-react";
import { toast } from "sonner";

function fmtSize(size: number): string {
  if (!size) return "-";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

const inputStyle: React.CSSProperties = {
  background: "rgba(10, 16, 34, 0.6)",
  border: "1px solid var(--border-default)",
  color: "var(--text-primary)",
};

export default function AlistPanel() {
  const [path, setPath] = useState("/");
  const utils = trpc.useUtils();
  const statusQuery = trpc.alist.status.useQuery(undefined, { retry: 1, staleTime: 30_000 });
  const browseQuery = trpc.alist.browse.useQuery({ path }, { retry: 1, staleTime: 30_000 });

  const status = statusQuery.data;
  const files = browseQuery.data?.files ?? [];
  const browseError = browseQuery.data && !browseQuery.data.ok ? browseQuery.data.error : undefined;
  const parentPath = path === "/" ? null : (path.slice(0, path.lastIndexOf("/")) || "/");

  // ─── 连接配置表单 ───
  const [formTouched, setFormTouched] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [basePath, setBasePath] = useState("/");
  const [autoUpload, setAutoUpload] = useState(true);

  // 状态加载后回填表单（只在用户未手动编辑过时）
  useEffect(() => {
    if (status && !formTouched) {
      setBaseUrl(status.baseUrl ?? "");
      setUsername(status.username ?? "");
      setBasePath(status.basePath ?? "/");
      setAutoUpload(status.autoUpload ?? true);
    }
  }, [status, formTouched]);

  const saveMutation = trpc.alist.saveConfig.useMutation({
    onSuccess: (res) => {
      if (!res.success) {
        toast.error(res.error ?? "保存失败");
        return;
      }
      if (res.connected) {
        toast.success(`已保存并验证通过：${res.message}`);
      } else {
        toast.warning(`已保存，但连接探测未通过：${res.message}`);
      }
      setPassword("");
      statusQuery.refetch();
      browseQuery.refetch();
    },
    onError: (e) => toast.error(e.message),
  });

  const clearMutation = trpc.alist.clearConfig.useMutation({
    onSuccess: () => {
      toast.success("已清除界面配置，回退到环境变量");
      setFormTouched(false);
      setPassword("");
      statusQuery.refetch();
      browseQuery.refetch();
    },
    onError: (e) => toast.error(e.message),
  });

  const handleSave = () => {
    if (!baseUrl.trim()) return toast.error("请填写 AList 地址");
    if (!username.trim()) return toast.error("请填写账号");
    if (!password.trim() && !status?.configured) return toast.error("首次配置请填写密码");
    saveMutation.mutate({
      baseUrl: baseUrl.trim(),
      username: username.trim(),
      password: password.trim() ? password : undefined, // 留空 = 保留原密码
      basePath: basePath.trim() || "/",
      autoUpload,
    });
  };

  const handleDownload = async (filePath: string, name: string) => {
    try {
      const res = await utils.alist.getDownloadUrl.fetch({ path: filePath });
      if (res.ok && res.url) {
        window.open(res.url, "_blank");
      } else {
        toast.error(`无法获取下载地址: ${res.ok ? "空链接" : res.error}`);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "获取下载地址失败");
    }
  };

  return (
    <div className="min-h-screen" style={{ background: "var(--bg-primary)" }}>
      <div className="max-w-6xl mx-auto px-4 sm:px-6 pt-24 pb-16">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-black tracking-wider" style={{ color: "var(--text-primary)" }}>
              AList 网盘
            </h1>
            <p className="text-[10px] font-mono mt-1" style={{ color: "var(--text-muted)" }}>
              CLOUD STORAGE · 任务产物自动备份与文件读取
            </p>
          </div>
          <button
            onClick={() => { statusQuery.refetch(); browseQuery.refetch(); }}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded font-mono hover:bg-[rgba(180,200,255,0.05)] transition-colors"
            style={{ color: "var(--text-muted)", border: "1px solid var(--border-default)" }}
          >
            <RefreshCw size={14} /> 刷新
          </button>
        </div>

        {/* 状态卡片 */}
        <div className="glass-panel p-4 sci-border mb-6 flex flex-wrap items-center gap-6">
          <div>
            <div className="text-[10px] font-mono mb-1" style={{ color: "var(--text-muted)" }}>连接状态</div>
            <div className="text-sm font-mono" style={{ color: status?.connected ? "var(--success)" : "var(--accent-red)" }}>
              {status?.configured ? (status.connected ? "● 已连接" : `○ ${status.message}`) : "○ 未配置"}
            </div>
          </div>
          {status?.configured && (
            <>
              <div>
                <div className="text-[10px] font-mono mb-1" style={{ color: "var(--text-muted)" }}>网盘地址</div>
                <div className="text-sm font-mono" style={{ color: "var(--text-primary)" }}>{status.baseUrlHost}</div>
              </div>
              <div>
                <div className="text-[10px] font-mono mb-1" style={{ color: "var(--text-muted)" }}>产物上传目录</div>
                <div className="text-sm font-mono" style={{ color: "var(--accent-cyan)" }}>{status.basePath}/tasks/</div>
              </div>
              <div>
                <div className="text-[10px] font-mono mb-1" style={{ color: "var(--text-muted)" }}>自动上传</div>
                <div className="text-sm font-mono" style={{ color: status.autoUpload ? "var(--success)" : "var(--text-muted)" }}>
                  {status.autoUpload ? "开启" : "关闭"}
                </div>
              </div>
              <div>
                <div className="text-[10px] font-mono mb-1" style={{ color: "var(--text-muted)" }}>配置来源</div>
                <div className="text-sm font-mono" style={{ color: status.source === "ui" ? "var(--accent-cyan)" : "var(--accent-gold)" }}>
                  {status.source === "ui" ? "界面配置" : "环境变量"}
                </div>
              </div>
            </>
          )}
        </div>

        {/* 连接配置表单 */}
        <div className="glass-panel p-4 sci-border mb-6">
          <div className="flex items-center gap-2 mb-3">
            <Settings2 size={14} style={{ color: "var(--accent-cyan)" }} />
            <span className="text-xs font-mono font-bold" style={{ color: "var(--text-primary)" }}>连接配置</span>
            <span className="text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>
              界面配置优先于环境变量 · 密码加密存储、永不回显
            </span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
            <label className="block">
              <div className="text-[10px] font-mono mb-1" style={{ color: "var(--text-muted)" }}>AList 地址</div>
              <input
                value={baseUrl}
                onChange={(e) => { setFormTouched(true); setBaseUrl(e.target.value); }}
                placeholder="https://你的alist地址"
                className="w-full text-xs font-mono px-2.5 py-1.5 rounded outline-none"
                style={inputStyle}
              />
            </label>
            <label className="block">
              <div className="text-[10px] font-mono mb-1" style={{ color: "var(--text-muted)" }}>账号</div>
              <input
                value={username}
                onChange={(e) => { setFormTouched(true); setUsername(e.target.value); }}
                placeholder="tiangong"
                className="w-full text-xs font-mono px-2.5 py-1.5 rounded outline-none"
                style={inputStyle}
              />
            </label>
            <label className="block">
              <div className="text-[10px] font-mono mb-1" style={{ color: "var(--text-muted)" }}>
                密码{status?.configured ? "（留空则保留原密码）" : ""}
              </div>
              <input
                type="password"
                value={password}
                onChange={(e) => { setFormTouched(true); setPassword(e.target.value); }}
                placeholder={status?.configured ? "不修改请留空" : "账号密码"}
                className="w-full text-xs font-mono px-2.5 py-1.5 rounded outline-none"
                style={inputStyle}
              />
            </label>
            <label className="block">
              <div className="text-[10px] font-mono mb-1" style={{ color: "var(--text-muted)" }}>
                上传目录（该账号在 AList 中的路径）
              </div>
              <input
                value={basePath}
                onChange={(e) => { setFormTouched(true); setBasePath(e.target.value); }}
                placeholder="/115/天宫"
                className="w-full text-xs font-mono px-2.5 py-1.5 rounded outline-none"
                style={inputStyle}
              />
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-1.5 text-xs font-mono cursor-pointer" style={{ color: "var(--text-secondary)" }}>
              <input
                type="checkbox"
                checked={autoUpload}
                onChange={(e) => { setFormTouched(true); setAutoUpload(e.target.checked); }}
              />
              任务产物自动上传
            </label>
            <AdminGate>
              <button
                onClick={handleSave}
                disabled={saveMutation.isPending}
                className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded font-mono transition-colors disabled:opacity-50"
                style={{ color: "var(--accent-cyan)", border: "1px solid var(--accent-cyan)" }}
              >
                <Save size={13} /> {saveMutation.isPending ? "保存并探测中..." : "保存并测试连接"}
              </button>
            </AdminGate>
            {status?.source === "ui" && (
              <AdminGate>
                <button
                  onClick={() => clearMutation.mutate()}
                  disabled={clearMutation.isPending}
                  className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded font-mono transition-colors disabled:opacity-50"
                  style={{ color: "var(--accent-red)", border: "1px solid var(--accent-red)" }}
                >
                  <Trash2 size={13} /> 清除界面配置
                </button>
              </AdminGate>
            )}
          </div>
          <div className="text-[10px] font-mono mt-3 leading-relaxed" style={{ color: "var(--text-muted)" }}>
            也可以用 Zeabur 环境变量配置（ALIST_BASE_URL / ALIST_USERNAME / ALIST_PASSWORD / ALIST_BASE_PATH / ALIST_AUTO_UPLOAD）；两者同时存在时以界面配置为准。
          </div>
        </div>

        {/* 文件浏览器 */}
        <div className="glass-panel p-4 sci-border">
          <div className="flex items-center gap-2 mb-3">
            <HardDrive size={14} style={{ color: "var(--accent-cyan)" }} />
            <span className="text-xs font-mono font-bold" style={{ color: "var(--text-primary)" }}>文件浏览</span>
            <div className="flex items-center gap-1.5 text-[11px] font-mono" style={{ color: "var(--text-muted)" }}>
              {parentPath !== null && (
                <button onClick={() => setPath(parentPath)} className="p-0.5 rounded hover:bg-[rgba(180,200,255,0.05)]" title="返回上级">
                  <ArrowLeft size={13} />
                </button>
              )}
              <span>{path}</span>
            </div>
          </div>
          {browseQuery.isLoading ? (
            <div className="text-xs p-4" style={{ color: "var(--text-muted)" }}>读取中...</div>
          ) : browseError ? (
            <div className="text-xs p-4" style={{ color: "var(--accent-red)" }}>{browseError}</div>
          ) : files.length === 0 ? (
            <div className="text-center py-12" style={{ color: "var(--text-muted)" }}>
              <FolderOpen size={32} className="mx-auto mb-3 opacity-30" />
              <div className="text-sm font-mono">空目录</div>
            </div>
          ) : (
            <div className="space-y-1">
              {files.map((f) => (
                <div key={f.path} className="flex items-center justify-between gap-2 px-2 py-1.5 rounded hover:bg-[rgba(180,200,255,0.02)]">
                  <button
                    className="flex items-center gap-2 min-w-0 text-left"
                    onClick={() => f.isDir && setPath(f.path)}
                    disabled={!f.isDir}
                  >
                    {f.isDir
                      ? <FolderOpen size={14} style={{ color: "var(--accent-gold)" }} className="shrink-0" />
                      : <File size={14} style={{ color: "var(--text-muted)" }} className="shrink-0" />}
                    <span className="text-xs font-mono truncate" style={{ color: "var(--text-primary)" }}>{f.name}</span>
                    {!f.isDir && <span className="text-[10px] font-mono shrink-0" style={{ color: "var(--text-muted)" }}>{fmtSize(f.size)}</span>}
                  </button>
                  {!f.isDir && (
                    <button
                      onClick={() => handleDownload(f.path, f.name)}
                      className="p-1 rounded hover:bg-[rgba(180,200,255,0.05)] shrink-0"
                      style={{ color: "var(--accent-cyan)" }}
                      title="打开/下载"
                    >
                      <ExternalLink size={13} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
