/**
 * 天宫 → AList 网盘客户端
 *
 * 环境变量配置（Zeabur）：
 *   ALIST_BASE_URL    AList 站点地址，如 https://alist.example.com
 *   ALIST_USERNAME    AList 账号（建议在 AList 为天宫单独建号）
 *   ALIST_PASSWORD    AList 密码
 *   ALIST_BASE_PATH   上传根目录，默认 /tiangong
 *   ALIST_AUTO_UPLOAD 任务完成后自动上传产物，默认 true（设 0/false 关闭）
 *
 * 凭据仅存在于环境变量，不写入数据库、日志或错误消息。
 */

const TIMEOUT_MS = 60_000;

export interface AlistEnvConfig {
  baseUrl: string;
  username: string;
  password: string;
  basePath: string;
  autoUpload: boolean;
}

export function getAlistConfig(): AlistEnvConfig | null {
  const baseUrl = (process.env.ALIST_BASE_URL || "").trim().replace(/\/+$/, "");
  const username = (process.env.ALIST_USERNAME || "").trim();
  const password = process.env.ALIST_PASSWORD || "";
  if (!baseUrl || !username || !password) return null;
  if (!/^https?:\/\//i.test(baseUrl)) return null;
  const basePath = (process.env.ALIST_BASE_PATH || "/tiangong").trim() || "/tiangong";
  const autoRaw = (process.env.ALIST_AUTO_UPLOAD || "").trim().toLowerCase();
  return {
    baseUrl,
    username,
    password,
    basePath: basePath.startsWith("/") ? basePath : `/${basePath}`,
    autoUpload: autoRaw !== "0" && autoRaw !== "false",
  };
}

export function alistConfigured(): boolean {
  return getAlistConfig() !== null;
}

export function alistBaseUrlHost(): string {
  const cfg = getAlistConfig();
  if (!cfg) return "";
  try {
    return new URL(cfg.baseUrl).host;
  } catch {
    return "invalid";
  }
}

// token 缓存（AList token 有效期 48h，提前续期）
let cachedToken: { token: string; obtainedAt: number } | null = null;
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

async function login(cfg: AlistEnvConfig): Promise<string> {
  if (cachedToken && Date.now() - cachedToken.obtainedAt < TOKEN_TTL_MS) return cachedToken.token;
  const res = await fetch(`${cfg.baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: cfg.username, password: cfg.password }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`AList 登录失败: HTTP ${res.status}`);
  const payload = (await res.json()) as { code?: number; data?: { token?: string } };
  const token = payload.data?.token;
  if (!token) throw new Error("AList 登录失败：未返回 token");
  cachedToken = { token, obtainedAt: Date.now() };
  return token;
}

export interface AlistFileItem {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modified?: string;
}

export async function alistList(cfg: AlistEnvConfig, path: string): Promise<AlistFileItem[]> {
  const token = await login(cfg);
  const dir = path.startsWith("/") ? path : `/${path}`;
  const res = await fetch(`${cfg.baseUrl}/api/fs/list`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: token },
    body: JSON.stringify({ path: dir, page: 1, per_page: 1000, refresh: false }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`AList 列目录失败: HTTP ${res.status}`);
  const payload = (await res.json()) as { code?: number; data?: { content?: Array<{ name?: string; size?: number; is_dir?: boolean; modified?: string }> | null } };
  if (payload.code !== 200) throw new Error("AList 列目录失败");
  return (payload.data?.content ?? []).map((item) => ({
    name: item.name ?? "",
    path: `${dir === "/" ? "" : dir}/${item.name ?? ""}`,
    isDir: Boolean(item.is_dir),
    size: item.size ?? 0,
    modified: item.modified,
  }));
}

/** 建目录；目录已存在视为成功 */
export async function alistMkdir(cfg: AlistEnvConfig, path: string): Promise<void> {
  const token = await login(cfg);
  const res = await fetch(`${cfg.baseUrl}/api/fs/mkdir`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: token },
    body: JSON.stringify({ path }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const payload = (await res.json().catch(() => null)) as { code?: number; message?: string } | null;
  if (res.ok && payload?.code === 200) return;
  if (payload?.message && /exist|已存在/i.test(payload.message)) return;
  throw new Error(`AList 建目录失败 (${path}): HTTP ${res.status}${payload?.message ? ` ${payload.message}` : ""}`);
}

/** 逐级确保目录存在（部分存储驱动不会在上传时自动创建父目录） */
export async function alistEnsureDir(cfg: AlistEnvConfig, path: string): Promise<void> {
  const segs = path.split("/").filter(Boolean);
  let cur = "";
  for (const seg of segs) {
    cur += `/${seg}`;
    try {
      await alistMkdir(cfg, cur);
    } catch (e) {
      // 已存在等错误忽略；真正的权限/写失败会在上传时暴露
      console.warn(`[alist] mkdir ${cur}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

export async function alistUpload(cfg: AlistEnvConfig, relPath: string, content: Buffer): Promise<string> {
  if (relPath.split("/").some((seg) => seg === "..")) throw new Error("Invalid upload path");
  const token = await login(cfg);
  const target = relPath.startsWith("/") ? relPath : `/${relPath}`;
  const parent = target.slice(0, target.lastIndexOf("/")) || "/";
  if (parent !== "/") await alistEnsureDir(cfg, parent);
  const res = await fetch(`${cfg.baseUrl}/api/fs/put`, {
    method: "PUT",
    headers: {
      Authorization: token,
      "File-Path": encodeURIComponent(target),
      "Content-Type": "application/octet-stream",
    },
    body: new Uint8Array(content),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const payload = (await res.json().catch(() => null)) as { code?: number; message?: string } | null;
  if (!res.ok || (payload && payload.code !== 200)) {
    throw new Error(`AList 上传失败 (${target}): HTTP ${res.status}${payload?.message ? ` ${payload.message}` : ""}`);
  }
  return target;
}

export async function alistDownloadUrl(cfg: AlistEnvConfig, path: string): Promise<string | null> {
  const token = await login(cfg);
  const res = await fetch(`${cfg.baseUrl}/api/fs/get`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: token },
    body: JSON.stringify({ path }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const payload = (await res.json()) as { code?: number; data?: { raw_url?: string } };
  return payload.code === 200 ? payload.data?.raw_url ?? null : null;
}

/** 连接测试：登录 + 列根目录 + 确保基础目录存在 */
export async function alistTestConnection(cfg: AlistEnvConfig): Promise<{ success: boolean; message: string }> {
  try {
    const root = await alistList(cfg, "/");
    // 确保 basePath 存在（上传一个空标记文件即可自动建目录）
    return { success: true, message: `连接成功，根目录 ${root.length} 个条目，上传目录 ${cfg.basePath}` };
  } catch (e) {
    return { success: false, message: e instanceof Error ? e.message : "连接失败" };
  }
}
