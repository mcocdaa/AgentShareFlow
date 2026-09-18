# Registry API v0

Base: `/api/v1`，JSON；tarball 为 `application/gzip`。

## 认证

- 请求头 `Authorization: Bearer <token>`。
- 服务端环境变量 `AGENTSHARE_TOKENS=token:owner,token2:owner2`。
- 未设置 `AGENTSHARE_TOKENS` 时为开发模式：任意非空 token，owner 取 `AGENTSHARE_DEV_OWNER`（默认 `dev`）。
- owner 命名空间：小写字母/数字/连字符，≤40。
- **OIDC 会话（可选）**：设置 `OIDC_ISSUER` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` / `OIDC_AUTH_SECRET`（≥32 字符）后启用，基于官方 `@hono/oidc-auth`（不自定义流程）。端点：`GET /api/v1/auth/login`（无会话 302 到 IdP）、`GET /api/v1/auth/callback`、`GET /api/v1/auth/logout`、`GET /api/v1/me`。owner 由 `OIDC_OWNER_CLAIM`（默认 `email`）映射：先查 `OIDC_OWNER_MAP`（`值:owner` 逗号列表），否则取邮箱本地部分 slug 化。已登录会话在所有拥有者接口上可代替 Bearer token；Bearer 优先。IdP 需支持发现端点与 refresh token，且 issuer 必须是 HTTPS（oauth4webapi 拒绝 HTTP）。

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

## 在线交接 API（M1 已实现）

公开接口（无需认证；分享 id 即 128-bit 能力 token）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/shares/:id` | 元数据 `{ id, owner, title, project, status, createdAt, lastSeenAt }` |
| GET | `/api/v1/shares/:id/events?sessionId=` | 访客 SSE：`status` / `message` / `delta` / `done` / `ping`；带 sessionId 时先重放该会话历史 |
| POST | `/api/v1/shares/:id/messages` | 访客发言 `{ sessionId?, content, visitorName? }` → `{ sessionId, message }` |

拥有者接口（`Authorization: Bearer <token>`，owner 必须匹配）：

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/v1/shares` | 创建分享 `{ title, project? }` |
| GET | `/api/v1/shares` | 列出自己的分享 |
| POST | `/api/v1/shares/:id/revoke` | 撤销：status=revoked，关闭隧道与访客流 |
| GET | `/api/v1/shares/:id/transcript` | 会话与消息全量 |
| GET | `/api/v1/tunnel/:shareId/events` | 插件出站隧道（SSE；服务端每 15s 发帧 ping） |
| POST | `/api/v1/tunnel/:shareId/frames` | 插件回传帧：`agent_chunk` / `agent_done` / `agent_error` / `fork_created` |

状态语义：`online` 以隧道连接为准（内存），断线即 `offline`，撤销后永久 `revoked`。
限流：每分享 30 条/分钟、每会话 10 条/分钟。帧类型见 `packages/core/src/share.ts`（`TunnelFrame`）。

### 分享模式

`POST /api/v1/shares` 支持两种模式：

- `mode: "tunnel"`（默认）：DSH 插件经出站隧道接入，`online` 以隧道连接为准。
- `mode: "endpoint"`：任意 A2A agent。请求体需带 `agentCardUrl`（基址或 `agent-card.json` 直链，relay 会归一化到 `/.well-known/agent-card.json`）。relay 拉取并校验卡片后保存，`endpoint_url` 取卡片里的 `url` 字段；该模式恒为 `online`（除 revoke 外），错误在消息响应里以 `system` 消息回传。

访客消息在 endpoint 模式下由 relay 直接调用 A2A（JSON-RPC `SendMessage`，-32601 时回退 `message/send`），把结果取文本后落库并广播；`share_sessions.a2a_context_id` 保存 A2A `contextId` 以维持多轮。

### 响应补充

分享详情/`url` 字段：由 `AGENTSHARE_PUBLIC_URL`（或请求来源）拼出 `…/#/share/<id>`；`mode` 标识模式；endpoint 模式附带 `agent: { name, description, skills }`；创建/详情附带完整 `handoff`（若有），列表只给 `hasHandoff`。

### A2A facade（tunnel 分享对外即 A2A agent）

任何 A2A 客户端可通过分享 id 发现并调用 tunnel 分享：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/shares/:id/agent-card.json` | Agent Card（`.well-known/agent-card.json` 同义路径）；`url` 指向 JSON-RPC 端点，附带 `handoff` 摘要（若有） |
| POST | `/api/v1/shares/:id/a2a` | JSON-RPC：`SendMessage` 与 `message/send`；`message.contextId` 映射到会话（无则新建并返回），回复取自该会话下一条 `agent` 消息 |

结果：`{ task: { id, contextId, status.state: TASK_STATE_COMPLETED, artifacts: [{ parts: [{ text }] }] } }`。JSON-RPC 错误（HTTP 200）：`-32010` 已撤销、`-32011` endpoint 分享不支持、`-32020` 离线、`-32029` 限流、`-32030` 超时（`AGENTSHARE_A2A_TIMEOUT_MS`，默认 120s）、`-32040` agent 错误帧。同一 contextId 复用同一会话，多轮连续。

### 成果回流（submission/v0）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/v1/shares/:id/submissions` | 访客提交成果 `{ spec: "submission/v0", summary, changes?, openQuestions?, authorName?, sessionId? }`；`sessionId` 必须是该分享的会话，限流 10 条/分钟 |
| GET | `/api/v1/shares/:id/submissions?sessionId=` | 访客按自己的会话查询；拥有者带 token 可查全部 |
| POST | `/api/v1/shares/:id/submissions/:submissionId/decision` | 仅拥有者：`{ decision: "accepted" \| "rejected", note? }` |

状态：`pending` → `accepted` / `rejected`（仅一次，重复决策 409）。决策会写入访客会话一条 `system` 消息并通过 SSE 推送（无 `sessionId` 的提交只落库、不通知）。校验：`summary` 1–4000 字，`changes` ≤50 条、`openQuestions` ≤20 条、每条 ≤1000 字；`authorName` ≤40。

CLI（拥有者侧）：`agentshare share submissions <shareId>`、`agentshare share decide <shareId> <submissionId> --accept|--reject [--note ...]`。

### 错误补充

| 状态码 | 场景 |
|---|---|
| 403 | 非分享拥有者访问拥有者接口 |
| 409 | 分享离线时发言 / 重复决策 |
| 410 | 分享已撤销后发言 |
| 429 | 触发限流 |

## v1 目标（排期）

- 在线 agent：`POST /api/v1/agents` 支持 `endpoint` / `runtime` 模式；`GET /api/v1/agents/:owner/:name/.well-known/agent-card.json` 反代 A2A 卡片。
- 对话资产：分享 transcript 冻结/导出，支持 fork 继续（`session import` 在 DSH 侧缺失，见 roadmap）。
- 认证升级：registry 签发 token / OIDC；发布签名校验（minisign）。
- 联邦：从 ClawHub / Smithery / skills.sh 导入。
