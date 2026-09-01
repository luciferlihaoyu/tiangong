/**
 * SSO 联邦登录票据签名（协议 v2：Ed25519 / EdDSA）
 *
 * 协议演进：
 * - v1（HS256 共享密钥）：platform-router 用 TIANGONG_SSO_SECRET/APP_SECRET 对称签票，
 *   接收端（璇玑等）持同一密钥验签。缺点：每个接收端都持有签发能力，密钥分发面大。
 * - v2（Ed25519 非对称，本模块）：天宫私钥签票，JWKS 公钥端点（GET /api/sso/jwks.json）
 *   供接收端拉取验签；接收端 TIANGONG_SSO_SECRET 仅作历史兼容（HS256 票据回退验签）。
 *
 * 密钥来源（优先级）：
 * 1. 环境变量 SSO_SIGNING_KEY_JWK：JSON `{"private":PrivateKeyJwk,"public":PublicKeyJwk}`
 *    —— 换入新密钥对即完成轮换（轮换 = 改 env 重启，单 key 简化实现）。
 * 2. 数据目录持久化文件 sso-ed25519-key.json（0600）：重启复用同一把密钥，
 *    保证 kid 稳定、接收端 JWKS 缓存不失效。
 * 3. 都没有：crypto.generateKeyPairSync("ed25519") 现场生成并持久化；持久化失败
 *    回退进程内临时密钥（kid 变化，接收端未知 kid 强制刷新 JWKS 后自愈）。
 *
 * 安全边界：
 * - 私钥材料只存在于 env / 持久化文件 / 进程内存，绝不进日志、绝不出现在 JWKS。
 * - JWKS 只含公钥（kty/crv/x/kid/alg/use）。
 * - kid = sha256(publicJwk.x) 前 16 位 hex。
 */

import { createHash, generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { SignJWT } from "jose";

/** 持久化文件名（与 SQLite 同目录，随数据卷持久化） */
const KEY_FILE_NAME = "sso-ed25519-key.json";
/** 私钥文件权限：仅属主可读写 */
const KEY_FILE_MODE = 0o600;
/** 票据默认有效期（秒）：与 v1 契约一致 */
export const SSO_TICKET_TTL_SECONDS = 120;

/** Ed25519 OKP JWK（私钥含 d，公钥只有 x） */
interface OkpJwk {
  kty: string;
  crv: string;
  x: string;
  d?: string;
}

/** SSO_SIGNING_KEY_JWK 环境变量 / 持久化文件的格式 */
interface SsoKeyPairJwk {
  private: OkpJwk;
  public: OkpJwk;
}

/** 签发上下文：解析后的密钥对与 kid（模块级惰性单例） */
interface SsoSigningContext {
  pair: SsoKeyPairJwk;
  kid: string;
}

let cachedContext: SsoSigningContext | null = null;

// ─── 数据目录解析 ───

/**
 * 数据目录 = DATABASE_URL 所在目录（密钥与数据库同卷持久化，同生共死）。
 * - `file:<path>`：剥协议与查询串取路径（兼容 `file:./x.db?param=...`）
 * - 纯路径：直传（与 queries/connection.ts resolveDbPath 惯例一致）
 * - mysql DSN / `:memory:` / 空：回退 artifact 卷（与 resolveDbPath 兜底一致）
 */
function resolveDataDir(): string {
  const databaseUrl = process.env.DATABASE_URL ?? "";
  let dbPath = "";
  if (databaseUrl.startsWith("file:")) {
    dbPath = databaseUrl.slice("file:".length).split("?")[0] ?? "";
  } else if (
    databaseUrl &&
    !databaseUrl.startsWith("mysql://") &&
    !databaseUrl.startsWith("mysql2://") &&
    databaseUrl !== ":memory:"
  ) {
    dbPath = databaseUrl;
  }
  if (!dbPath) {
    dbPath = path.join(process.env.TIANGONG_ARTIFACT_ROOT ?? "/app/data/tiangong-artifacts", "tiangong.db");
  }
  return path.dirname(path.resolve(dbPath));
}

// ─── 密钥来源 ───

/** 来源 1：SSO_SIGNING_KEY_JWK 环境变量（优先；配置了即不落盘） */
function parseEnvKeyPair(): SsoKeyPairJwk | null {
  const raw = process.env.SSO_SIGNING_KEY_JWK;
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("SSO_SIGNING_KEY_JWK 配置无效：不是合法 JSON");
  }
  const pair = parsed as Partial<SsoKeyPairJwk> | null;
  if (
    !pair ||
    typeof pair !== "object" ||
    !pair.private ||
    !pair.private.kty ||
    !pair.private.d ||
    !pair.public ||
    !pair.public.x
  ) {
    throw new Error(
      "SSO_SIGNING_KEY_JWK 配置无效：需要 {\"private\":PrivateKeyJwk,\"public\":PublicKeyJwk}，且 public.x 用于推导 kid",
    );
  }
  return pair as SsoKeyPairJwk;
}

/** 来源 2：数据目录持久化文件（不存在/损坏返回 null，走生成） */
function readPersistedKeyPair(keyFile: string): SsoKeyPairJwk | null {
  try {
    const pair = JSON.parse(fs.readFileSync(keyFile, "utf8")) as Partial<SsoKeyPairJwk>;
    if (pair.private?.d && pair.public?.x) return pair as SsoKeyPairJwk;
  } catch {
    // 文件不存在或损坏：正常路径，现场生成
  }
  return null;
}

/** 来源 3：现场生成并持久化（写失败不致命：回退进程内临时密钥，接收端会自愈） */
function generateAndPersist(keyFile: string): SsoKeyPairJwk {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pair: SsoKeyPairJwk = {
    private: privateKey.export({ format: "jwk" }) as OkpJwk,
    public: publicKey.export({ format: "jwk" }) as OkpJwk,
  };
  try {
    fs.mkdirSync(path.dirname(keyFile), { recursive: true });
    // 先以 0600 写入；若文件已存在（理论上不会），chmod 兜底收紧权限
    fs.writeFileSync(keyFile, JSON.stringify(pair), { mode: KEY_FILE_MODE });
    fs.chmodSync(keyFile, KEY_FILE_MODE);
    console.warn(`[sso] 已生成 Ed25519 SSO 签名密钥并持久化到 ${keyFile}`);
  } catch (e) {
    console.warn(
      `[sso] SSO 签名密钥持久化失败，本次运行使用进程内临时密钥（重启后 kid 变化，接收端将自动刷新 JWKS）:`,
      e instanceof Error ? e.message : e,
    );
  }
  return pair;
}

/** 惰性单例：首次调用才解析 env / 读文件 / 生成密钥，避免 boot 早期副作用 */
function getSigningContext(): SsoSigningContext {
  if (cachedContext) return cachedContext;
  const keyFile = path.join(resolveDataDir(), KEY_FILE_NAME);
  const pair = parseEnvKeyPair() ?? readPersistedKeyPair(keyFile) ?? generateAndPersist(keyFile);
  const kid = createHash("sha256").update(pair.public.x).digest("hex").slice(0, 16);
  cachedContext = { pair, kid };
  return cachedContext;
}

// ─── 公开 API ───

/** SSO launch 票据 claims（iat/exp/jti 由本模块补齐，调用方语义与 v1 一致） */
export interface SsoTicketClaims {
  typ: string;
  sub: string;
  role: string;
  app: string;
  username?: string;
}

/** 用 Ed25519 私钥签发 SSO 票据：header {alg:"EdDSA", kid}，claims 原样 + iat/exp/jti */
export async function signSsoTicket(
  claims: SsoTicketClaims,
  opts?: { expiresInSec?: number },
): Promise<string> {
  const ctx = getSigningContext();
  const ttl = opts?.expiresInSec ?? SSO_TICKET_TTL_SECONDS;
  return await new SignJWT({
    typ: claims.typ,
    sub: claims.sub,
    role: claims.role,
    app: claims.app,
    ...(claims.username ? { username: claims.username } : {}),
  })
    .setProtectedHeader({ alg: "EdDSA", kid: ctx.kid })
    .setIssuedAt()
    .setExpirationTime(`${ttl}s`)
    .setJti(crypto.randomUUID())
    .sign(ctx.pair.private);
}

/** JWKS 公钥集合（协议 v2 验签来源；只含公钥材料）。挂载于 GET /api/sso/jwks.json */
export function getSsoJwks(): {
  keys: Array<{ kty: "OKP"; crv: "Ed25519"; x: string; kid: string; alg: "EdDSA"; use: "sig" }>;
} {
  const ctx = getSigningContext();
  return {
    keys: [{ kty: "OKP", crv: "Ed25519", x: ctx.pair.public.x, kid: ctx.kid, alg: "EdDSA", use: "sig" }],
  };
}

/** 测试辅助：重置惰性单例（仅测试用，勿在业务代码调用） */
export function _resetSsoSigningForTest(): void {
  cachedContext = null;
}
