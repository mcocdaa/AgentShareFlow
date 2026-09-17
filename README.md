# AgentShareFlow

发布、发现、安装 **Agent Pack** 的开放注册表，以及把本地 agent 会话实时交接给他人的分享链路（M1 优先支持 DeepSeek Harness）。

- **离线包**：把 skill / 提示词 / MCP 配置打包发布，一键安装到 Claude Code / Codex / opencode / OpenClaw / Hermes。
- **在线交接**：DSH 里执行 `/share` 得到实时链接，访客在网页上与你的 agent 对话（只读、逐访客独立 fork 会话）。
- 遵循 [agentskills.io](https://agentskills.io) 开放标准；契约见 `docs/spec/`。

## 仓库结构

```
packages/
  core/            规范与共享逻辑：Agent Pack（zod）、打包/校验/解包、harness 目录、分享协议与隧道客户端
  cli/             agentshare CLI：login / pack / push / search / info / install
  registry/        中转服务：Hono + node:sqlite；packs API、分享 API、隧道 hub、本地存储
  web/             Vite + React：包浏览 + 访客聊天页（#/share/:id）
  dsh-plugin/      DeepSeek Harness 插件（非 pnpm workspace 成员，见下）
skills/
  agentshare/      给 agent 用的门面 skill（SKILL.md）
examples/
  hello-handoff/   最小示例 Agent Pack
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
```

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

## 认证（v0）

- registry 读取 `AGENTSHARE_TOKENS`，格式 `token:owner,token2:owner2`；未设置时为开发模式，任意 token 可用，owner 取 `AGENTSHARE_DEV_OWNER`（默认 `dev`）。
- CLI 配置存于 `~/.config/agentshare/config.json`（可用 `AGENTSHARE_CONFIG` 覆盖路径）。
- 发布不可变：`owner/name@version` 已存在返回 409；分享链接 id 即能力 token，可随时 revoke。

## 状态

- **P0**：离线包发布/安装链路可用（CLI + registry + Web）。
- **M1 在线交接**：已在真实 DSH + 真实模型上端到端验证——访客提问 → 独立只读 fork 会话 → 流式回复 → transcript 落库；剩下只读对抗性审计、`share_create` 工具与插件 npm 分发（见 `docs/roadmap.md`）。
- 联调细节与修复记录见 `docs/design/m1-online-handoff.md`。

License: TBD
