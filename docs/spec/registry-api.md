# Registry API v0

Base: `/api/v1`，JSON；tarball 为 `application/gzip`。

## 认证

- 请求头 `Authorization: Bearer <token>`。
- 服务端环境变量 `AGENTSHARE_TOKENS=token:owner,token2:owner2`。
- 未设置 `AGENTSHARE_TOKENS` 时为开发模式：任意非空 token，owner 取 `AGENTSHARE_DEV_OWNER`（默认 `dev`）。
- owner 命名空间：小写字母/数字/连字符，≤40。

## 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 服务信息 |
| GET | `/healthz` | 健康检查 `{ ok, packs }` |
| GET | `/api/v1/search?q=&mode=` | 搜索（每个 `owner/name` 只返回最新版） |
| GET | `/api/v1/agents/:owner/:name` | 最新版详情 + `versions` 列表 |
| GET | `/api/v1/agents/:owner/:name/:version` | 指定版本详情 |
| GET | `/api/v1/agents/:owner/:name/:version/download` | 下载 tarball（计数 +1） |
| POST | `/api/v1/agents` | 发布（需认证，multipart） |

### 详情响应

```json
{
  "owner": "myowner",
  "name": "hello-handoff",
  "version": "0.1.0",
  "title": "Hello Handoff",
  "description": "...",
  "mode": "offline",
  "tags": ["handoff"],
  "downloads": 3,
  "createdAt": "2026-09-16T08:00:00.000Z",
  "digest": "sha256:...",
  "size": 2048,
  "downloadUrl": "/api/v1/agents/myowner/hello-handoff/0.1.0/download",
  "manifest": { "spec": "agent-pack/v0", "...": "完整 manifest" },
  "versions": ["0.1.0"]
}
```

### 搜索响应

```json
{ "items": [ { "owner": "...", "name": "...", "version": "...", "title": "...", "description": "...", "mode": "offline", "tags": [], "downloads": 0, "createdAt": "..." } ] }
```

### 发布（POST /api/v1/agents）

`multipart/form-data`：

| 字段 | 类型 | 说明 |
|---|---|---|
| `manifest` | string | `agent.json` 内容（JSON 字符串） |
| `tarball` | file | pack 目录的 `.tgz` |

可选请求头 `x-pack-digest: <sha256-hex>`，与服务端计算结果不符则 400。

成功：`201 { "ok": true, "ref": "owner/name@1.0.0", "digest": "...", "size": 1234 }`

## 错误

```json
{ "error": "human readable message", "details": "optional" }
```

| 状态码 | 场景 |
|---|---|
| 400 | manifest 非法、缺字段、digest 不符、owner 非法 |
| 401 | 缺 token 或 token 无效 |
| 404 | owner/name/version 不存在 |
| 409 | 版本已存在（发布不可变） |

## v1 目标（排期）

- 在线 agent：`POST /api/v1/agents` 支持 `endpoint` / `runtime` 模式；`GET /api/v1/agents/:owner/:name/.well-known/agent-card.json` 反代 A2A 卡片。
- 对话：`POST /api/v1/agents/:owner/:name/:version/chat`（SSE），会话可冻结为只读分享页。
- 认证升级：registry 签发 token / OIDC；发布签名校验（minisign）。
- 联邦：从 ClawHub / Smithery / skills.sh 导入。
