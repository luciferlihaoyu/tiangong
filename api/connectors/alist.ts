/**
 * 天宫 → AList 网盘客户端
 *
 * 配置来源（优先级从高到低）：
 *   1. 界面配置：网盘页「连接配置」表单，存 system_settings（key: alist_config）
 *   2. 环境变量（Zeabur，兜底）：
 *      ALIST_BASE_URL / ALIST_USERNAME / ALIST_PASSWORD / ALIST_BASE_PATH / ALIST_AUTO_UPLOAD
 *
 * 上传目录默认 "/" —— 即账号在 AList 中的根目录（若 AList 后台为该账号配置了
 * 「基本路径」，"/" 自动映射到该目录）；也可在界面里直接填子目录如 /115/天宫。
 *
 * 密码只写不回读：status/列表接口永不返回密码。
 */

const TIMEOUT_MS = 60_000;

export interface AlistEnvConfig {
  baseUrl: string;
  username: string;
  password: string;
  basePath: string;
  autoUpload: boolean;
}

function normalizeBasePath(raw: string | undefined): string {
  const trimmed = (raw || "/").trim() || "/";
  if (trimmed === "/") return "/";
  return `/${trimmed.replace(/^\/+|\/+$/g, "")}`;
}

function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

function fromEnv(): AlistEnvConfig | null {
  const baseUrl = normalizeBaseUrl(process.env.ALIST_BASE_URL || "");
  const username = (process.env.ALIST_USERNAME || "").trim();
  const password = process.env.ALIST_PASSWORD || "";
  if (!baseUrl || !username || !password) return null;
  if (!/^https?:\/\//i.test(baseUrl)) return null;
  const autoRaw = (process.env.ALIST_AUTO_UPLOAD || "").trim().toLowerCase();
  return {
    baseUrl,
    username,
    password,
    basePath: normalizeBasePath(process.env.ALIST_BASE_PATH),
    autoUpload: autoRaw !== "0" && autoRaw !== "false",
  };
}

const ALIST_CONFIG_KEY = "alist_config";

export interface AlistStoredConfig {
  baseUrl: string;
  username: string;
  password: string;
  basePath?: string;
  autoUpload?: boolean;
}

/** 读取界面保存的配置（无效/不完整返回 null） */
export async function getAlistDbConfig(): Promise<AlistEnvConfig | null> {
  try {
    const { getSetting } = await import("../lib/settings");
    const raw = await getSetting(ALIST_CONFIG_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AlistStoredConfig>;
    const baseUrl = normalizeBaseUrl(parsed.baseUrl || "");
    const username = (parsed.username || "").trim();
    const password = parsed.password || "";
    if (!baseUrl || !username || !password) return null;
    if (!/^https?:\/\//i.test(baseUrl)) return null;
    return {
      baseUrl,
      username,
      password,
      basePath: normalizeBasePath(parsed.basePath),
      autoUpload: parsed.autoUpload !== false,
    };
  } catch {
    return null;
  }
}

/** 保存界面配置 */
export async function saveAlistDbConfig(cfg: AlistStoredConfig): Promise<void> {
  const { setSetting } = await import("../lib/settings");
  const normalized: AlistStoredConfig = {
    baseUrl: normalizeBaseUrl(cfg.baseUrl),
    username: cfg.username.trim(),
    password: cfg.password,
    basePath: normalizeBasePath(cfg.basePath),
    autoUpload: cfg.autoUpload !== false,
  };
  await setSetting(ALIST_CONFIG_KEY, JSON.stringify(normalized), "alist");
}

/** 清除界面配置（回退到环境变量） */
export async function clearAlistDbConfig(): Promise<void> {
  const { setSetting } = await import("../lib/settings");
  await setSetting(ALIST_CONFIG_KEY, "", "alist");
}

/** 解析生效配置：界面配置优先，环境变量兜底 */
export async function resolveAlistConfig(): Promise<AlistEnvConfig | null> {
  const dbCfg = await getAlistDbConfig();
  return dbCfg ?? fromEnv();
}

/** 配置来源（用于界面展示） */
export async function alistConfigSource(): Promise<"ui" | "env" | null> {
  if (await getAlistDbConfig()) return "ui";
  return fromEnv() ? "env" : null;
}

export function alistBaseUrlHostOf(cfg: AlistEnvConfig | null): string {
  if (!cfg) return "";
  try {
    return new URL(cfg.baseUrl).host;
  } catch {
    return "invalid";
  }
}

// token 缓存（AList token 有效期 48h，提前续期；按 地址::账号 分键，配置切换后互不影响）
const tokenCache = new Map<string, { token: string; obtainedAt: number }>();
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

async function login(cfg: AlistEnvConfig): Promise<string> {
  const key = `${cfg.baseUrl}::${cfg.username}`;
  const cached = tokenCache.get(key);
  if (cached && Date.now() - cached.obtainedAt < TOKEN_TTL_MS) return cached.token;
  const res = await fetch(`${cfg.baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: cfg.username, password: cfg.password }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`AList 登录失败: HTTP ${res.status}`);
  const payload = (await res.json()) as { code?: number; message?: string; data?: { token?: string } };
  const token = payload.data?.token;
  if (!token) throw new Error(`AList 登录失败${payload?.message ? `: ${payload.message}` : "：未返回 token"}`);
  tokenCache.set(key, { token, obtainedAt: Date.now() });
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
  const payload = (await res.json().catch(() => null)) as {
    code?: number;
    message?: string;
    data?: { content?: Array<{ name?: string; size?: number; is_dir?: boolean; modified?: string }> | null };
  } | null;
  if (!res.ok || !payload || payload.code !== 200) {
    throw new Error(`AList 列目录失败 (${dir}): HTTP ${res.status}${payload?.message ? ` ${payload.message}` : ""}`);
  }
  return (payload.data?.content ?? []).map((item) => ({
    name: item.name ?? "",
    path: `${dir === "/" ? "" : dir}/${item.name ?? ""}`,
    isDir: Boolean(item.is_dir),
    size: item.size ?? 0,
    modified: item.modified,
  }));
}

/** 目录是否存在 */
async function alistDirExists(cfg: AlistEnvConfig, path: string): Promise<boolean> {
  try {
    const token = await login(cfg);
    const res = await fetch(`${cfg.baseUrl}/api/fs/get`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: token },
      body: JSON.stringify({ path }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return false;
    const payload = (await res.json()) as { code?: number; data?: { is_dir?: boolean } };
    return payload.code === 200 && payload.data?.is_dir === true;
  } catch {
    return false;
  }
}

/** 建目录；目录已存在视为成功 */
export async function alistMkdir(cfg: AlistEnvConfig, path: string): Promise<void> {
  if (await alistDirExists(cfg, path)) return;
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

/** 逐级确保目录存在（部分存储驱动不会在上传时自动创建父目录）；权限错误直接抛出便于诊断 */
export async function alistEnsureDir(cfg: AlistEnvConfig, path: string): Promise<void> {
  const segs = path.split("/").filter(Boolean);
  let cur = "";
  for (const seg of segs) {
    cur += `/${seg}`;
    await alistMkdir(cfg, cur);
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

/** 删除文件/目录（尽力而为，供写探测清理） */
export async function alistRemove(cfg: AlistEnvConfig, dir: string, names: string[]): Promise<void> {
  try {
    const token = await login(cfg);
    await fetch(`${cfg.baseUrl}/api/fs/remove`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: token },
      body: JSON.stringify({ dir, names }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    /* 清理失败不影响探测结论 */
  }
}

/** 连接测试：登录 + 列目录 + 真实写探测（建目录 → 写文件 → 删除），逐步报告失败点 */
export async function alistTestConnection(cfg: AlistEnvConfig): Promise<{ success: boolean; message: string }> {
  const me = await alistMe(cfg);
  const accountRoot = me?.basePath && me.basePath !== "/" ? me.basePath : null;
  const where = cfg.basePath === "/"
    ? (accountRoot ? `账号根目录（${accountRoot}）` : "账号根目录")
    : cfg.basePath;
  try {
    await alistList(cfg, "/");
  } catch (e) {
    return { success: false, message: `列目录失败: ${e instanceof Error ? e.message : String(e)}` };
  }
  // 写探测
  const probeDir = cfg.basePath === "/" ? "/.tiangong-probe" : cfg.basePath;
  const probeFile = `${probeDir}/.write-probe.txt`;
  try {
    await alistEnsureDir(cfg, probeDir);
  } catch (e) {
    return { success: false, message: `读取正常，但建目录被拒（${probeDir}）: ${e instanceof Error ? e.message : String(e)}——请检查 AList 账号的「写入」权限` };
  }
  try {
    await alistUpload(cfg, probeFile, Buffer.from("probe", "utf-8"));
  } catch (e) {
    return { success: false, message: `读取正常、目录可用，但写文件被拒（${probeFile}）: ${e instanceof Error ? e.message : String(e)}` };
  }
  await alistRemove(cfg, probeDir, [".write-probe.txt"]);
  if (cfg.basePath === "/") await alistRemove(cfg, "/", [".tiangong-probe"]);
  return { success: true, message: `连接成功（读/写均正常），上传落点：${where}` };
}
