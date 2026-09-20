# AgentShareFlow

> 发布、发现、安装 Agent Pack 的开放注册表与跨 Agent 实时会话分享网络。

[![Family: *Flow](https://img.shields.io/badge/family-*Flow-8A2BE2.svg)](https://github.com/mcocdaa)
[![CI](https://github.com/mcocdaa/AgentShareFlow/actions/workflows/ci.yml/badge.svg)](https://github.com/mcocdaa/AgentShareFlow/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/mcocdaa/AgentShareFlow?display_name=tag&sort=semver)](https://github.com/mcocdaa/AgentShareFlow/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)
[![Docker](https://img.shields.io/badge/docker-ready-blue.svg)](Dockerfile)

发布、发现、安装 **Agent Pack** 的开放注册表，以及把本地 agent 会话实时交接给他人的分享链路（M1 优先支持 DeepSeek Harness）。

- **离线包**：把 skill / 提示词 / MCP 配置打包发布，一键安装到 Claude Code / Codex / opencode / OpenClaw / Hermes。
- **在线交接**：DSH 里执行 `/share` 得到实时链接，访客在网页上与你的 agent 对话（只读、逐访客独立 fork 会话）。
- 遵循 [agentskills.io](https://agentskills.io) 开放标准；契约见 `docs/spec/`。

## 仓库结构

```
packages/
  core/            规范与共享逻辑：Agent Pack（zod）、打包/校验/解包、harness 目录、分享协议与隧道客户端
  cli/             agentshare CLI：login / pack / push / search / info / install / update / export / import / handoff / share / expose / serve --mcp
  registry/        中转服务：Hono + node:sqlite；packs API、分享 API、隧道 hub、本地存储
  web/             Vite + React：包浏览 + 发布页（#/publish）+ 访客聊天页（#/share/:id）
  dsh-plugin/      DeepSeek Harness 插件（非 pnpm workspace 成员，见下）
skills/
  agentshare/      给 agent 用的门面 skill（SKILL.md）
examples/
  hello-handoff/   最小示例 Agent Pack
  multi-skill/     多 skill pack 示例（changelog + pr-description）
docs/
  README.md        文档索引
  spec/            契约：agent-pack.md、registry-api.md
  design/          设计文档：m1-online-handoff.md
  roadmap.md       路线图与当前冲刺
scripts/
  sync-dsh-plugin.sh   同步 core + 插件到 refs/deepseek-harness，供 DSH 开发
  mock-share-agent.mjs 不依赖 DSH 的 relay 冒烟客户端
```

## 快速开始

```bash
pnpm install
pnpm build

# 终端 1：registry（默认 :8787）
AGENTSHARE_TOKENS=devtoken:myowner pnpm registry

# 终端 2：Web（默认 :5173，已代理 /api 到 8787）
pnpm web

# 终端 3：CLI 走一遍发布 → 搜索 → 安装
node packages/cli/dist/index.js login --registry http://localhost:8787 --token devtoken --owner myowner
node packages/cli/dist/index.js push examples/hello-handoff
node packages/cli/dist/index.js search handoff
node packages/cli/dist/index.js install myowner/hello-handoff --target agents
node packages/cli/dist/index.js update myowner/hello-handoff --dry-run   # 安装有 lockfile 记录，可升级
node packages/cli/dist/index.js diff myowner/hello-handoff@0.1.0 myowner/hello-handoff@0.2.0
node packages/cli/dist/index.js export myowner/hello-handoff --out ./skills   # 导出成扁平 SKILL.md 目录
node packages/cli/dist/index.js push examples/multi-skill               # 多 skill pack 示例
```

CI 发布：复制 `examples/publish-workflow.yml` 到 pack 仓库的 `.github/workflows/`，配好 `AGENTSHARE_REGISTRY` / `AGENTSHARE_TOKEN` secrets，推 `v*` tag 即自动校验、扫描并发布。

开发模式（免构建）：

```bash
pnpm --filter @agentshare/cli dev -- --help
pnpm --filter @agentshare/registry dev
pnpm --filter @agentshare/web dev
pnpm mock:share   # relay 全链路冒烟（另开终端先起 registry）
```

## 公网部署（relay + 分享页）

registry 会同时托管 API 与 Web 分享页（构建后的 `web/dist`），所以一个进程就是完整中转：

```bash
AGENTSHARE_TOKENS='s3cret:alice' AGENTSHARE_PUBLIC_URL='https://relay.example.com' \
  docker compose up -d --build
```

或者直接 Docker：

```bash
docker build -t agent-share-flow-relay .
docker run -d -p 8787:8787 -v relay-data:/data \
  -e AGENTSHARE_TOKENS='s3cret:alice' \
  -e AGENTSHARE_PUBLIC_URL='https://relay.example.com' \
  agent-share-flow-relay
```

- `AGENTSHARE_PUBLIC_URL` 决定分享链接里的域名（缺省用请求来源），建议置于 HTTPS 反向代理之后。
- 数据落在 `/data`（SQLite + packs 目录），生产请挂卷。
- 国内构建：`docker build --build-arg NPM_REGISTRY=https://registry.npmmirror.com ...`。
- 环境变量总览：`PORT`、`AGENTSHARE_DATA`、`AGENTSHARE_TOKENS`、`AGENTSHARE_PUBLIC_URL`、`AGENTSHARE_WEB_DIR`（默认 `packages/web/dist`）。

## MCP：让 agent 直接用注册表

`agentshare serve --mcp` 启动 stdio MCP server，暴露三个工具：`agentshare_search`（按关键词搜索）、`agentshare_info`（查看版本/targets/secrets/endpoint）、`agentshare_install`（安装到本地 harness，高危扫描自动拦截）。

```json
{
  "mcpServers": {
    "agentshare": {
      "command": "npx",
      "args": ["-y", "@agentshare/cli", "serve", "--mcp", "--registry", "https://relay.example.com"],
      "env": { "AGENTSHARE_TOKEN": "<token>" }
    }
  }
}
```

安装到用户级目录（`~/.agents/skills` 等）；高危包会被安全扫描阻断，MCP 工具以 `isError` 返回原因。

## 从其他 registry 导入（ClawHub / Smithery / skills.sh）

```bash
agentshare import clawhub steipete/weather --out ./weather        # skill -> offline pack
agentshare import smithery upstash/context7-mcp --out ./context7  # MCP server -> endpoint pack
agentshare import skills-sh vercel-labs/skills --skill find-skills --out ./find-skills
agentshare push ./weather   # 审核后用既有的扫描/签名流程发布
```

- **clawhub**：公开 API 拉取 skill zip 与元数据（版本、主题、所需环境变量名），生成 offline pack。
- **smithery**：读取公开 registry 的服务器信息，生成 endpoint pack（MCP URL + 说明用 SKILL.md），安装时输出在线端点。
- **skills-sh**：其 API 需要 Vercel OIDC，这里直接从 GitHub 源仓库导入（git tree + 逐文件，`raw.githubusercontent.com` 不可达时回退 contents API；设置 `GITHUB_TOKEN` 提高限额）。`--skill` 选单个技能，不传则整仓全部 skill 导入为一个多 skill pack。
- 导入只写本地目录，不执行任何内容；发布前仍走 `push` 的安全扫描，安装仍校验签名。

## 分享任意 A2A agent（endpoint 模式）

任何实现了 A2A 协议（v1.0 `SendMessage`，兼容旧 `message/send`）并且能访问到 Agent Card 的 agent，都可以一条链接分享给访客，不需要你在本机跑任何插件：

```bash
curl -X POST https://relay.example.com/api/v1/shares \
  -H "authorization: Bearer $AGENTSHARE_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"title":"my a2a agent","mode":"endpoint","agentCardUrl":"https://agent.example.com"}'
```

relay 会拉取并校验 `/.well-known/agent-card.json`，保存卡片信息，访客打开返回的 `url` 即可对话；多轮通过 A2A `contextId` 维持。框架无关（ADK / LangGraph / CrewAI / 自研均可）。

本地验证：`pnpm mock:a2a` 起一个 mock A2A agent，再按上面的 curl 创建分享。

## 把 tunnel 分享当 A2A agent 调用

每个 tunnel 分享同时是一个 A2A agent，任何 A2A 客户端都能发现并调用：

```bash
# Agent Card（`.well-known/agent-card.json` 同义）
curl https://relay.example.com/api/v1/shares/<id>/agent-card.json

# JSON-RPC：SendMessage（兼容 message/send），contextId 维持多轮
curl -X POST https://relay.example.com/api/v1/shares/<id>/a2a \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":"1","method":"SendMessage","params":{"message":{"parts":[{"text":"这个任务现在到哪一步了？"}]}}}'
```

也可用 core 客户端：`fetchAgentCard(cardUrl)` + `sendA2AMessage(card.url, text, { contextId })`。离线/撤销分别返回 `-32020`/`-32010`。

## 暴露本地 agent（`agentshare expose`）

本地跑着 A2A agent、又不想暴露公网端口时，用 CLI 经隧道挂到 relay 上（outbound，无入站端口）：

```bash
agentshare expose --a2a http://127.0.0.1:9999 --title "my local agent"
# expose  Mock A2A Agent -> https://relay.example.com/#/share/<id>
# facade  https://relay.example.com/api/v1/shares/<id>/a2a
```

- 启动时校验本地 Agent Card；访客打开分享链接对话，消息转发给本地 A2A（`SendMessage`，兼容 `message/send`），会话经 `contextId` 保持多轮。
- 同一分享同时是 A2A agent（facade），任何 A2A 客户端可直接调用。
- Ctrl+C 断开隧道并自动 revoke 分享。本地验证：`pnpm mock:a2a` 起 mock agent，再执行上面的命令。

## 嵌入分享对话（iframe）

分享页提供紧凑版 `#/embed/<id>`（无导航、固定高度），可直接嵌到文档站或内网页面：

```html
<iframe src="https://relay.example.com/#/embed/<id>" style="width:100%;height:520px;border:0"
        title="agent share"></iframe>
```

只有分享在线时可用；访客消息仍走同样的限流与只读策略，revoke 后 iframe 内即时变成已撤销状态。

## 在线交接（M1，DSH 插件）

```bash
# relay + Web（同上）
AGENTSHARE_TOKENS=devtoken:myowner pnpm registry
pnpm web

# 同步插件到 refs/deepseek-harness，并在 clone 内运行（需要 DEEPSEEK_API_KEY）
pnpm dsh:sync
cd refs/deepseek-harness
pnpm install
pnpm run dsh web --patch ./packages/community/dsh-agentshare/cordis.source.patch.yml
```

DSH 里 `/share` 返回 `http://localhost:8787/#/share/<id>`；`/shares` 列表、`/unshare` 撤销。
协议与客户端在 `packages/core/src/share.ts`；细节见 `docs/design/m1-online-handoff.md` 与 `packages/dsh-plugin/README.md`。

## 认证与安全（v0）

- registry 读取 `AGENTSHARE_TOKENS`，格式 `token:owner,token2:owner2`；未设置时为开发模式，任意 token 可用，owner 取 `AGENTSHARE_DEV_OWNER`（默认 `dev`）。
- CLI 配置存于 `~/.config/agentshare/config.json`（可用 `AGENTSHARE_CONFIG` 覆盖路径）。
- 发布不可变：`owner/name@version` 已存在返回 409；分享链接 id 即能力 token，可随时 revoke。
- 发布扫描：`push`/`install`/`update` 扫描提示注入与危险命令，`high` 阻断（`--allow-risky` 显式越过）；registry 发布侧再次拦截。规则见 `docs/spec/agent-pack.md`。
- 账号（可选）：设置 `OIDC_ISSUER` 等四项后启用 OIDC 登录（官方 `@hono/oidc-auth`），浏览器会话可代替 token 作为 owner，org 用 `OIDC_OWNER_MAP` 映射。见 `.env.example`。
- 发布签名：`agentshare keygen` + `push --sign`（ed25519，Node 内置）；install/update 校验签名，换签名者默认拒绝。星标一人一星，展示在搜索与详情。
- 导出：`agentshare export <ref> --out <dir>` 把 pack 的多个 skill 写成扁平 SKILL.md 目录（同样扫描/验签，`--force` 覆盖），供不支持的 harness 或 skills.sh 风格目录直接使用。


## 状态

- **P0**：离线包发布/安装链路可用（CLI + registry + Web）。
- **M1 在线交接**：真实 DSH + 真实模型端到端验证；只读白名单、`share_create`、公网部署、endpoint（A2A）分享、A2A facade 均完成；剩插件 npm 分发。
- **M2 跨工具交接**：`handoff/v0` 导出（DSH）→ 导入（Codex，真实续做验证）→ 可对话交接页 → 成果回流（submission/v0）完成。
- **P1 离线包 MVP**：diff、update/lockfile、发布扫描、账号（OIDC）、星标、签名、`export`、互操作导入（ClawHub / Smithery / skills.sh）、`serve --mcp` 完成；剩 CI 发布模板真实仓库验证与 npm 首发（待登录）。
- **P2 在线 agent**：endpoint 分享 + A2A facade、`agentshare expose`（本地 A2A 经隧道）、分享对话（SSE/会话记录/限流）、`#/embed/:id` 嵌入版、Web 发布页完成；配额与运行时托管未做。
- 联调细节与修复记录见 `docs/design/m1-online-handoff.md`。

License: MIT
