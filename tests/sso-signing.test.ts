/**
 * SSO 票据签名模块单测（协议 v2：Ed25519 / EdDSA）—— 只覆盖 api/lib/sso-signing.ts。
 *
 * 运行（不要跑全量套件）：npx vitest run tests/sso-signing.test.ts
 *
 * 覆盖点：
 * - 密钥管理：未配置 env 时生成 Ed25519 并持久化（0600）；重启复用同一把；
 *   SSO_SIGNING_KEY_JWK 配置优先且不落盘；非法配置报清晰错误。
 * - kid 推导：sha256(x) 前 16 位 hex。
 * - signSsoTicket：header alg=EdDSA + kid；claims 完整；exp-iat=120s；jti 为 UUID。
 * - 端到端：JWKS 公钥可验签自产票据；篡改票据验签失败。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as jose from "jose";
import {
  getSsoJwks,
  signSsoTicket,
  _resetSsoSigningForTest,
} from "../api/lib/sso-signing";

// ─── 测试脚手架 ───

const tmpDirs: string[] = [];
function makeDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-sso-test-"));
  tmpDirs.push(dir);
  return dir;
}

/** 指向临时数据目录的标准 DATABASE_URL（file: 协议） */
function fileDbUrl(dataDir: string): string {
  return `file:${path.join(dataDir, "tiangong.db")}`;
}

/** 把一对 JWK 打包成 SSO_SIGNING_KEY_JWK 环境变量格式 */
function jwkEnvValue(privateJwk: jose.JWK, publicJwk: jose.JWK): string {
  return JSON.stringify({ private: privateJwk, public: publicJwk });
}

/** 取 JWKS 首把公钥并导入为可验签的 CryptoKey */
async function importFirstJwksKey(): Promise<CryptoKey> {
  const jwk = getSsoJwks().keys[0]!;
  return (await jose.importJWK(
    { kty: jwk.kty, crv: jwk.crv, x: jwk.x } as jose.JWK,
    "EdDSA",
  )) as CryptoKey;
}

beforeEach(() => {
  delete process.env.SSO_SIGNING_KEY_JWK;
  delete process.env.TIANGONG_ARTIFACT_ROOT;
  _resetSsoSigningForTest();
});

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── 密钥管理与 JWKS ───

describe("getSsoJwks（Ed25519 密钥管理）", () => {
  it("未配置 env：生成密钥并持久化到 DATABASE_URL 同目录，文件权限 0600", () => {
    const dataDir = makeDataDir();
    process.env.DATABASE_URL = fileDbUrl(dataDir);

    const jwks = getSsoJwks();

    expect(jwks.keys).toHaveLength(1);
    const key = jwks.keys[0]!;
    expect(key.kty).toBe("OKP");
    expect(key.crv).toBe("Ed25519");
    expect(key.alg).toBe("EdDSA");
    expect(key.use).toBe("sig");
    expect(typeof key.x).toBe("string");
    // kid = sha256(x) 前 16 位 hex
    expect(key.kid).toBe(
      createHash("sha256").update(key.x!).digest("hex").slice(0, 16),
    );

    // 持久化：{private, public} JWK JSON，权限 0600
    const keyFile = path.join(dataDir, "sso-ed25519-key.json");
    expect(fs.existsSync(keyFile)).toBe(true);
    expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600);
    const persisted = JSON.parse(fs.readFileSync(keyFile, "utf8")) as {
      private: { kty: string; d?: string };
      public: { x?: string };
    };
    expect(persisted.private.kty).toBe("OKP");
    expect(persisted.private.d).toBeTruthy(); // 私钥材料只在文件里，绝不进日志/JWKS
    expect(persisted.public.x).toBe(key.x);
  });

  it("重启复用：单例重置后从持久化文件读回同一把密钥（同 kid）", () => {
    const dataDir = makeDataDir();
    process.env.DATABASE_URL = fileDbUrl(dataDir);

    const kid1 = getSsoJwks().keys[0]!.kid;
    _resetSsoSigningForTest();
    const kid2 = getSsoJwks().keys[0]!.kid;

    expect(kid2).toBe(kid1);
  });

  it("DATABASE_URL 为 mysql DSN：数据目录回退到 TIANGONG_ARTIFACT_ROOT", () => {
    const dataDir = makeDataDir();
    process.env.DATABASE_URL = "mysql://user:pass@host:3306/db";
    process.env.TIANGONG_ARTIFACT_ROOT = dataDir;

    const jwks = getSsoJwks();

    expect(jwks.keys).toHaveLength(1);
    expect(fs.existsSync(path.join(dataDir, "sso-ed25519-key.json"))).toBe(true);
  });

  it("配置 SSO_SIGNING_KEY_JWK：直接使用 env 密钥，不落盘", async () => {
    const dataDir = makeDataDir();
    process.env.DATABASE_URL = fileDbUrl(dataDir);
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicJwk = await jose.exportJWK(publicKey);
    const privateJwk = await jose.exportJWK(privateKey);
    process.env.SSO_SIGNING_KEY_JWK = jwkEnvValue(privateJwk, publicJwk);

    const jwks = getSsoJwks();

    expect(jwks.keys[0]!.x).toBe(publicJwk.x);
    expect(fs.existsSync(path.join(dataDir, "sso-ed25519-key.json"))).toBe(false);
  });

  it("SSO_SIGNING_KEY_JWK 缺 public 或非法 JSON：抛出含变量名的清晰错误", () => {
    const dataDir = makeDataDir();
    process.env.DATABASE_URL = fileDbUrl(dataDir);

    process.env.SSO_SIGNING_KEY_JWK = "{not-json";
    expect(() => getSsoJwks()).toThrow(/SSO_SIGNING_KEY_JWK/);

    process.env.SSO_SIGNING_KEY_JWK = JSON.stringify({ private: { kty: "OKP" } });
    expect(() => getSsoJwks()).toThrow(/SSO_SIGNING_KEY_JWK/);
  });
});

// ─── 票据签发 ───

describe("signSsoTicket（EdDSA 签发）", () => {
  it("header 带 alg=EdDSA 与 kid；claims 完整；exp-iat=120s；jti 为 UUID", async () => {
    process.env.DATABASE_URL = fileDbUrl(makeDataDir());

    const token = await signSsoTicket({
      typ: "sso-launch",
      sub: "42",
      role: "admin",
      app: "xuanji",
      username: "bixiao",
    });

    const header = jose.decodeProtectedHeader(token);
    expect(header.alg).toBe("EdDSA");
    expect(header.kid).toBe(getSsoJwks().keys[0]!.kid);

    const { payload } = await jose.jwtVerify(token, await importFirstJwksKey(), {
      algorithms: ["EdDSA"],
    });
    expect(payload.typ).toBe("sso-launch");
    expect(payload.sub).toBe("42");
    expect(payload.role).toBe("admin");
    expect(payload.app).toBe("xuanji");
    expect(payload.username).toBe("bixiao");
    expect(typeof payload.iat).toBe("number");
    expect((payload.exp as number) - (payload.iat as number)).toBe(120);
    expect(payload.jti).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("端到端：签名票据可用 JWKS 公钥验签；篡改后验签失败", async () => {
    process.env.DATABASE_URL = fileDbUrl(makeDataDir());

    const token = await signSsoTicket({ typ: "sso-launch", sub: "1", role: "admin", app: "beidou" });
    await expect(
      jose.jwtVerify(token, await importFirstJwksKey(), { algorithms: ["EdDSA"] }),
    ).resolves.toBeTruthy();

    // 篡改 payload（换最后一段签名的首字符）后必须验签失败
    const [h, p, s] = token.split(".");
    const tamperedSig = (s![0] === "A" ? "B" : "A") + s!.slice(1);
    await expect(
      jose.jwtVerify(`${h}.${p}.${tamperedSig}`, await importFirstJwksKey(), {
        algorithms: ["EdDSA"],
      }),
    ).rejects.toThrow();
  });
});
