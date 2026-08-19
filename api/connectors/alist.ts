/**
 * 天宫 → AList 网盘客户端
 *
 * 环境变量配置（Zeabur）：
 *   ALIST_BASE_URL    AList 站点地址，如 https://alist.example.com
 *   ALIST_USERNAME    AList 账号（建议在 AList 为天宫单独建号，并把账号「基本路径」设为天宫专用目录，如 /115/天宫）
 *   ALIST_PASSWORD    AList 密码
 *   ALIST_BASE_PATH   可选：上传子目录。默认 "/" —— 跟随账号在 AList 中的根目录
 *                     （若 AList 后台为该账号配置了「基本路径」，"/" 自动映射到该目录）
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
  const basePathRaw = (process.env.ALIST_BASE_PATH || "/").trim() || "/";
  const basePath = basePathRaw === "/" ? "/" : `/${basePathRaw.replace(/^\/+|\/+$/g, "")}`;
  const autoRaw = (process.env.ALIST_AUTO_UPLOAD || "").trim().toLowerCase();
  return {
    baseUrl,
    username,
    password,
    basePath,
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

/** 查询当前账号信息（AList /api/me，含账号基本路径 base_path） */
export async function alistMe(cfg: AlistEnvConfig): Promise<{ username: string; basePath: string } | null> {
  try {
    const token = await login(cfg);
    const res = await fetch(`${cfg.baseUrl}/api/me`, {
      headers: { Authorization: token },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const payload = (await res.json()) as { code?: number; data?: { username?: string; base_path?: string } };
    if (payload.code !== 200 || !payload.data) return null;
    return { username: payload.data.username ?? cfg.username, basePath: payload.data.base_path || "/" };
  } catch {
    return null;
  }
}

/** 连接测试：登录 + 列根目录 + 报告账号基本路径（上传实际落点） */
export async function alistTestConnection(cfg: AlistEnvConfig): Promise<{ success: boolean; message: string }> {
  try {
    const root = await alistList(cfg, "/");
    const me = await alistMe(cfg);
    const accountRoot = me?.basePath && me.basePath !== "/" ? me.basePath : null;
    const where = cfg.basePath === "/"
      ? (accountRoot ? `账号根目录（${accountRoot}）` : "账号根目录")
      : cfg.basePath;
    return { success: true, message: `连接成功，根目录 ${root.length} 个条目，上传落点：${where}` };
  } catch (e) {
    return { success: false, message: e instanceof Error ? e.message : "连接失败" };
  }
}
