# 天宫 SSO 联邦登录（协议 v2：Ed25519 / EdDSA）

天宫作为主平台，为已登录用户签发进入璇玑等子服务的短期一次性票据；
子服务验票后建立本地会话。本文档描述 v2 协议（非对称签名）及与 v1 的兼容关系。

## 协议总览

```
┌────────┐  1. 管理员登录天宫，点击进入子服务          ┌────────┐
│  天宫  │ ── platform.launch(app="xuanji") ──────────▶│  浏览器 │
│ 签发方 │     返回 {ok, url, expiresInSec:120}        └───┬────┘
│        │                                                 │ 2. 302 跳转
│        │  3. 接收端拉取公钥（缓存 10 分钟）               ▼
│        │ ◀── GET /api/sso/jwks.json ──────────────  ┌────────┐
│        │     {keys:[{kty:"OKP",crv:"Ed25519",       │  璇玑  │
│        │               x,kid,alg:"EdDSA",use:"sig"}]}│ 验收方 │
│        │                                             └───┬────┘
└────────┘  4. GET /sso/launch?token=<jwt> 验票建会话 ───┘
```

## 端点（天宫）

| 端点 | 说明 |
| --- | --- |
| `GET /api/sso/jwks.json` | JWKS 公钥集合（匿名可访问；只含公钥材料） |
| tRPC `platform.launch` | 管理员签发票据，返回 `{ok:true, url:"<service>/sso/launch?token=…", expiresInSec:120}` |

## 票据格式

- 算法：EdDSA（Ed25519），header：`{alg:"EdDSA", kid:<16位hex>}`
- claims：`{typ:"sso-launch", sub, role, app, username?, iat, exp=iat+120s, jti(uuid)}`
- `jti` 一次性：接收端在 `exp + 60s` 时钟容差窗口内拒绝重放。

## 接收端验签（璇玑 `api/sso-router.ts`）

1. 读 token header 的 `alg` 与 `kid`；
2. `alg==="EdDSA"`：按 `TIANGONG_JWKS_URL`（默认 `https://tiangg.zeabur.app/api/sso/jwks.json`）
   拉取 JWKS（模块级缓存 10 分钟，超时 5s）；`kid` 未命中时强制刷新一次（防轮换窗口误杀），
   用对应公钥 `jose importJWK + jwtVerify`；
3. `alg==="HS256"`：回退共享密钥 `TIANGONG_SSO_SECRET` 验签（部署顺序错位与回滚的安全网）；
4. typ / app / exp / sub / role / jti 校验与 v1 完全一致；
5. 通过则种 `xuanji_session` cookie 并 302 `/`；任何失败不建会话（401）。

## 密钥管理（天宫）

优先级：

1. **环境变量 `SSO_SIGNING_KEY_JWK`**（推荐生产）：JSON 格式
   ```json
   {"private":{"kty":"OKP","crv":"Ed25519","x":"…","d":"…"},
    "public":{"kty":"OKP","crv":"Ed25519","x":"…"}}
   ```
   配置后不落盘。
2. **持久化文件**：`<DATABASE_URL 同目录>/sso-ed25519-key.json`（0600），重启复用同一把密钥。
3. **自动生成**：两者皆无时现场生成 Ed25519 并持久化；持久化失败回退进程内临时密钥
   （重启后 kid 变化，接收端未知 kid 强制刷新 JWKS 后自愈）。

### 轮换

把新密钥对 `{private, public}` 放进 `SSO_SIGNING_KEY_JWK`，重启天宫即完成轮换。
本实现 JWKS 单 key 简化（新旧两把公钥不并存）：轮换瞬间接收端缓存的旧 JWKS 不含新 kid，
但「未知 kid 强制刷新」机制保证下一次请求即恢复，实际中断 ≈ 0。

### 生成一对新密钥

```bash
node -e '
const { generateKeyPairSync } = require("node:crypto");
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
console.log(JSON.stringify({
  private: privateKey.export({ format: "jwk" }),
  public:  publicKey.export({ format: "jwk" }),
}));
'
```

## v1 兼容（HS256）

- 天宫 `TIANGONG_SSO_SECRET` / `APP_SECRET` **不再用于签发**，仅作历史兼容保留；
- 接收端在 `alg==="HS256"` 且配置了 `TIANGONG_SSO_SECRET` 时仍可验 v1 票据；
- 两个验证来源都未配置时，接收端返回 501（"SSO 未配置"，沿用 v1 语义）；
  配置了任一来源后，验签失败一律 401。

## 部署检查单

- [ ] 天宫：无需强制新增环境变量（自动生成密钥即可用）；生产建议显式配置 `SSO_SIGNING_KEY_JWK`
- [ ] 天宫：确认 `GET /api/sso/jwks.json` 匿名可达（部署网关勿拦截 `.json` 路径）
- [ ] 璇玑：`TIANGONG_JWKS_URL` 可选（默认指向天宫生产地址）；`TIANGONG_SSO_SECRET` 保留即可启用 HS256 兼容
- [ ] 轮换演练：换 `SSO_SIGNING_KEY_JWK` 重启 → 用旧票据应 401、新票据正常
- [ ] 私钥安全：`SSO_SIGNING_KEY_JWK` 与 `sso-ed25519-key.json` 严禁提交 git / 打入日志
