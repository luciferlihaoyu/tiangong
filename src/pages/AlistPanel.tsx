/**
 * AList 网盘页面
 * - 连接状态（环境变量配置）
 * - 文件浏览器（目录导航 + 下载链接）
 * - 任务产物自动上传状态说明
 */
import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { HardDrive, RefreshCw, FolderOpen, File, ArrowLeft, ExternalLink } from "lucide-react";
import { toast } from "sonner";

function fmtSize(size: number): string {
  if (!size) return "-";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export default function AlistPanel() {
  const [path, setPath] = useState("/");
  const utils = trpc.useUtils();
  const statusQuery = trpc.alist.status.useQuery(undefined, { retry: 1, staleTime: 30_000 });
  const browseQuery = trpc.alist.browse.useQuery({ path }, { retry: 1, staleTime: 30_000 });

  const status = statusQuery.data;
  const files = browseQuery.data?.files ?? [];
  const browseError = browseQuery.data && !browseQuery.data.ok ? browseQuery.data.error : undefined;
  const parentPath = path === "/" ? null : (path.slice(0, path.lastIndexOf("/")) || "/");

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
            </>
          )}
        </div>

        {!status?.configured && (
          <div className="glass-panel p-6 sci-border mb-6 text-xs font-mono" style={{ color: "var(--text-muted)" }}>
            <div className="font-bold mb-2" style={{ color: "var(--accent-gold)" }}>配置方法（Zeabur 环境变量）</div>
            <pre className="text-[11px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>{`ALIST_BASE_URL=https://你的alist地址
ALIST_USERNAME=天宫专用账号
ALIST_PASSWORD=账号密码
ALIST_BASE_PATH=/tiangong        （可选，默认 /tiangong）
ALIST_AUTO_UPLOAD=true            （可选，默认开启）`}</pre>
          </div>
        )}

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
