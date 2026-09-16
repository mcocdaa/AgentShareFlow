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
- **M1 在线交接**：relay、分享协议、DSH 插件源码完成，relay 冒烟通过；真机联调待 `refs/deepseek-harness` 安装构建。
- 细节与后续计划见 `docs/roadmap.md`。

License: TBD
