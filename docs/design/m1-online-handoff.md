# M1 设计：在线交接（链接实时聊天）

状态：待确认（确认后开工）

## 一句话定义

在本地 DSH 里执行 `/share`，得到一个链接；任何人打开链接即可实时与这个 DSH agent 对话。消息经 relay 出站隧道进入本地 DSH 的**只读 fork 会话**，回答流式返回。你关闭 DSH，链接显示离线。

## 已确认决策

1. **每访客独立 fork 会话**：分享绑定一个 agent preset + skills + 工作目录；每个访客获得自己的 fork，互不干扰；owner 可见全部会话。
2. **只读受限**：远程消息只触发只读能力（读文件/知识/skill），禁写、禁 shell/子进程/后台任务。
3. **离线语义**：owner 不在线时链接显示离线，不接受发言（不做排队、不做存档降级）。
4. **relay 复用已搭 registry**：M1 不做账号体系，沿用现有 Bearer token（开发模式可用）。

## 架构

```
访客浏览器 ──SSE(下游) / POST(上游)──► relay (Hono)
                                        ▲
                                        │ 出站 SSE + POST（无需开放入站端口）
                                        │
                              dsh-agentshare 插件（本地 DSH 内）
                                        │
                                 ctx.agents.create() fork
                                 受限 preset + skills + cwd
```

- DSH web server 只绑 loopback（`refs/deepseek-harness/docs/architecture.md:51`），因此**必须出站**，不做端口暴露。
- 传输首选 **SSE + POST**（纯 HTTP，Hono 直接支持，无 upgrade 依赖），WebSocket 作为备选优化。

## Relay 侧

### 数据模型（SQLite，新增于现有 registry）

```sql
CREATE TABLE shares (
  id TEXT PRIMARY KEY,           -- 128-bit 随机，即链接里的能力 token
  owner TEXT NOT NULL,           -- 发布者命名空间（现 Bearer 体制）
  title TEXT NOT NULL,
  preset TEXT,                   -- 共享 agent 的 preset 名称
  project TEXT,                  -- 工作目录（仅存展示用 basename）
  status TEXT NOT NULL,          -- online | offline | revoked
  created_at TEXT NOT NULL,
  last_seen_at TEXT
);

CREATE TABLE share_sessions (
  id TEXT PRIMARY KEY,           -- 访客会话 id
  share_id TEXT NOT NULL,
  visitor_name TEXT,             -- 匿名昵称（可选）
  dsh_session_id TEXT,           -- 本地 DSH fork 出来的 session id
  created_at TEXT NOT NULL
);

CREATE TABLE share_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,            -- visitor | agent | system
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

### API

| 方法 | 路径 | 认证 | 说明 |
|---|---|---|---|
| POST | `/api/v1/shares` | owner Bearer | 创建分享，返回 `{ id, url, status }` |
| GET | `/api/v1/shares/:id` | 公开 | 元数据：title、status、owner 昵称 |
| POST | `/api/v1/shares/:id/revoke` | owner Bearer | 撤销，链接立即失效 |
| GET | `/api/v1/shares/:id/events` | 公开 | 访客 SSE：assistant 流式输出、状态变更 |
| POST | `/api/v1/shares/:id/messages` | 公开 | 访客发言 `{ sessionId?, content, visitorName? }`；无 sessionId 则新建 fork |
| GET | `/api/v1/shares/:id/transcript` | owner Bearer | 全部会话记录 |
| GET | `/api/v1/tunnel/:shareId/events` | owner Bearer | 插件出站 SSE：收访客消息/状态请求 |
| POST | `/api/v1/tunnel/:shareId/frames` | owner Bearer | 插件回传：`agent_chunk` / `agent_done` / `fork_created` / `status` |

限流：每 share 每分钟消息数、每 IP 每分钟消息数（内存计数即可，M1 不引 Redis）。

### 机制

- 在线状态 = 隧道 SSE 是否连接（断线后 `last_seen_at` 超过 15s 标记 offline）。
- 访客 POST 消息时若 offline，返回 409 `share is offline`，页面置灰输入框。
- 每条 assistant 消息在 relay 落库后再转发，保证 transcript 完整。

### 分享页（packages/web 新增）

- 路由 `#/share/:id`：标题 + 状态徽章 + 聊天区（SSE 渲染流式）+ 昵称输入。
- 复用现有 Vite 应用与 API 客户端，不引 router 依赖。

## DSH 插件侧（packages/dsh-plugin）

### 包形态

- npm 包 `dsh-agentshare`，`package.json` 含 `dsh.bundle`（`cordis.patch.yml`），可 `dsh plugin --profile <p> add` 安装（npm / github / tgz）。
- 开发用 `--patch` 绝对路径模块（`refs/deepseek-harness/docs/user/develop/basic/index.md:46`）。

### 注册的能力

| 能力 | API | 用途 |
|---|---|---|
| 命令 `/share` | `ctx.commands.register` | 创建/撤销分享，打印链接 |
| 工具 `share_create` / `share_list` / `share_revoke` | `ctx.tools.register` | 让 agent 自己也能发起分享 |
| 受限 preset | agent preset 机制 | 访客 fork 专用的只读 agent 组合 |
| Web 面板 | `ctx.slots` + `dsh.client` | 分享列表、在线访客、会话记录、撤销按钮 |
| 隧道客户端 | 出站 SSE + POST（Node fetch） | 常驻连接 relay，断线指数退避重连 |
| 配置 | `Config` schema + `ctx.settings` | relay URL、owner、token 引用 |

### share 流程

1. `/share` 收集：当前 session 的 preset、cwd、标题（默认取目录名）。
2. 插件调 relay `POST /api/v1/shares`（Bearer owner token 来自 `ctx.credentials`，只存引用）。
3. 插件在本地记录 shareId ↔ preset/cwd 映射（`ctx.storage`）。
4. 启动隧道：SSE 收帧 → 访客消息 → `ctx.agents.create({ preset: "agentshare-readonly", cwd, seed })` fork → 把输出流按 chunk 通过 POST 回传。
5. 会话结束（访客关闭/超时）时汇总 transcript 在 relay 落库。

### 只读隔离（已按源码验证修正）

DSH 的 preset 只能由文件系统发现，插件无法在运行时注册，因此不使用自注册 preset。访客 fork 的隔离改为：

1. `setup` 中挂载 owner 会话的 preset：`ctx.agentPresets.mount(agentCtx, presetId)`，`presetId` 取 `ctx.get('agentPresets')?.composedPreset(parent.ctx)`（与 `childSessionMeta` 同源做法）。
2. 同一 `setup` 中追加 `agent.session.append('sandbox/mode', { mode: 'read-only', source: 'delegation' })`（默认即 read-only，显式声明保证可审计）。
3. `agentCtx.tools.restrict({ deny: [...] })` 屏蔽写与执行类工具：`bash`、`pwsh`、`str_replace_editor`、`terminal_*`、`job_*`、`ralph`、`spawn_teammate`、`team_task_*`、`send_message`、`interrupt_agent`、`cordis_*`、`create_goal`、`ask_user_question`。
4. 访客消息注入为普通 user message，不携带 owner 凭据上下文；`ctx.credentials` 不在访客 agent 的作用域链上。

## 隧道帧协议（v0）

```json
{ "type": "visitor_message", "shareId": "...", "sessionId": "...", "content": "...", "visitorName": "..." }
{ "type": "agent_chunk", "shareId": "...", "sessionId": "...", "content": "..." }
{ "type": "agent_done", "shareId": "...", "sessionId": "..." }
{ "type": "fork_created", "shareId": "...", "sessionId": "...", "dshSessionId": "..." }
{ "type": "status", "shareId": "...", "status": "online" }
{ "type": "ping" }
```

## 里程碑

| 步骤 | 内容 | 验收 |
|---|---|---|
| M1.0 | 隧道打通：插件连 relay，在线状态可见，ping/pong | relay 页面看到 online，断开 15s 后 offline |
| M1.1 | 单访客单轮：聊天页 → 只读 fork 会话 → 流式回答 | 一轮问答端到端跑通 |
| M1.2 | 多访客多轮：独立 fork、transcript、revoke、限流 | 两个访客互不干扰，revoke 立即失效 |
| M1.3 | 收紧与打磨：只读 preset 审计、错误处理、web 面板 | 冒烟测试 + 手工审计工具面 |

## M1 明确不做

账号/OIDC、付费、离线存档降级、留言排队、对话导入/导出交接、插件市场、访客实名、多 relay 联邦。

## 已按源码验证的实现要点

1. **创建/fork**：`ctx.agents.create({ sessionId, meta: { cwd, agentPreset, parentSession, isSeeded }, seed, inheritedEventCount, setup })`；`seed` 取 owner 会话的完整已完成回合前缀（`snapshotEvents()` 取到最后一个 `turn/end`，与 `subagent-fork-in-process` 相同做法，需带 `no-deprecated` 说明）；`setup` 负责挂 preset 与限制工具。
2. **流式**：全局订阅 `agent/assistant-stream`，`frame.type === 'chunk' && frame.chunk.type === 'text-delta'` 转发增量，`frame.type === 'end'` 收尾。发消息用 `createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })` + `agent.followup(...)`。
3. **命令**：`ctx.commands.register({ name, description, handler })`，handler 收到 `{ agent, rawInput, signal }`，`agent` 即当前会话，用于取 preset/cwd/seed。
4. **工具**：`ctx.tools.register(defineTool({...}))`，`output` 字段必填。
5. **凭证**：config 字段标 `.role('credential-ref')`，运行时 `credentialRef()` → `ctx.credentials.resolve()` 解析，值不落盘。
6. **插件包**：function-plugin（具名 `name`/`inject`/`Config`/`apply`，无 default export）；可安装分发用 `dsh.bundle` + `cordis.patch.yml`；本地开发用 `cordis.source.patch.yml`。
7. **会话隔离**：访客 fork 用 `meta.parentSession` 记录来源，但 seed 只含已完成回合；访客之间各自独立 `sessionId`。
8. **inject**：必需服务 `commands`、`tools`、`credentials`、`agents`；`agentPresets` 用 `ctx.get('agentPresets')` 可选获取。

## 待运行期验证的风险

- `agent/assistant-stream` 载荷字段名以实现版本为准（当前按 clone 版本编写）。
- 多步回合（工具调用穿插）时 `end` 帧可能出现多次；M1 以 buffer 累积、最后一个 `end` 收尾为准。
- 插件经 `dsh plugin add` 安装到 profile 时的依赖解析：开发期先用同步脚本把 `@agentshare/core` 与插件一起放进 clone workspace。

## 插件包位置与工作区

- 源码在 `packages/dsh-plugin`，**不作为本仓库 pnpm workspace 成员**（避免在无 DSH 依赖时安装/构建失败）。
- `scripts/sync-dsh-plugin.sh`（`pnpm dsh:sync`）把 `packages/core`（含构建产物）与 `packages/dsh-plugin` 同步到 `refs/deepseek-harness/packages/community/` 下，形成 clone 内 workspace 包，再用 `pnpm run dsh web --patch .../cordis.source.patch.yml` 运行。

## 联调结果（2026-09-16，真实 DSH + 真实模型）

环境：`refs/deepseek-harness`（clone，已 `pnpm install && pnpm run build`）、隔离 `DSH_HOME=/tmp/opencode/dsh-home`、relay 本地 8787。

已验证：
- 插件源码经 `--patch` 加载，命令/事件注册成功；分享创建、隧道 online、`/shares` 状态一致。
- 访客消息 → relay → 隧道 → 本地 DSH 创建**独立 fork 会话**（`dsh_session_id` 回填 transcript）。
- fork 继承 owner 的 route（provider/model），真实模型回合成功；文本增量经隧道流式回传聊天页。
- transcript 落库（visitor/agent/system）、revoke 生效、离线 409。
- 探针 `dev/probe.ts` 可在无 Web UI 的情况下触发分享，便于端到端验证。

联调中发现并修复的问题（均已进代码）：
1. **构建集成**：core 需按 DSH 约定输出 `lib/types`；`scripts/sync-dsh-plugin.sh` 负责改写 core 包元数据并把两个包接入 clone 的 `tsconfig.host.json`。
2. **工具限制**：`tools.restrict()` 要求 deny 名单是全局已注册工具，在 agent 作用域会直接抛错；改为 agent 作用域 `tools.guard()`（单调拒绝，按名前缀/精确匹配）。
3. **模型选择**：直接 `ctx.agents.create` 的 fork 缺少 route，`{{model}}` 模板变量无值导致 prompt 组装失败；改为继承 owner 的 `agentOptions` 并在 setup 中 `installModelSelection`。
4. **探针 inject**：读取 `ctx.agentDefaultModel` 需要显式 `inject`。

遗留（见 roadmap M1）：
- 只读策略的对抗性审计（诱导 bash 调用未产生执行输出，但未做穷尽验证）。
- `share_create` 工具（tool 执行上下文尚未提供 agent 引用）。
- `agent/assistant-stream` 多步回合的 `end` 语义在工具调用穿插时的收尾策略。

---

## 与现有脚手架的关系

- `packages/core`：复用（Pack 规范、打包），M1 新增 `share` 相关类型。
- `packages/registry`：扩展 shares 表与路由；现有 packs API 不动。
- `packages/web`：新增 `#/share/:id` 聊天页。
- `packages/cli`：M1 不动（留作后续 CI 发布/非 DSH harness 客户端）。
- 新增 `packages/dsh-plugin`：M1 的主交付物。
