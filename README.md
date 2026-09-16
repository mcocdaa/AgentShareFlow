# AgentShareFlow

发布、发现、安装 **Agent Pack** 的开放注册表（registry）。

一个 Agent Pack 可以是一份离线 skill / 提示词 / MCP 配置包，也可以指向一个在线 agent（MCP / A2A 端点）。目标场景：工作交接、离职知识转移、项目问答、分享有趣的 agent。

跨 harness：Claude Code / Codex / opencode / OpenClaw / Hermes，遵循 [agentskills.io](https://agentskills.io) 开放标准。

## 仓库结构

```
packages/
  core/        Agent Pack 规范（zod schema）、打包/校验/解包、harness 目录解析
  cli/         agentshare CLI：login / pack / push / search / info / install
  registry/    Hono + node:sqlite + 本地包存储的注册表服务
  web/         Vite + React 浏览界面
skill/
  agentshare/  给 agent 用的门面 skill（SKILL.md）
examples/
  hello-handoff/  最小示例包
docs/
  spec/agent-pack.md     Agent Pack 规范 v0
  spec/registry-api.md   注册表 API 契约 v0
  roadmap.md             阶段计划
```

## 快速开始

```bash
pnpm install
pnpm build

# 终端 1：注册表（默认 :8787）
AGENTSHARE_TOKENS=devtoken:myowner pnpm registry

# 终端 2：Web（默认 :5173，已代理 /api 到 8787）
pnpm web

# 终端 3：CLI 走一遍发布 → 搜索 → 安装
node packages/cli/dist/index.js login --registry http://localhost:8787 --token devtoken --owner myowner
node packages/cli/dist/index.js push examples/hello-handoff
node packages/cli/dist/index.js search handoff
node packages/cli/dist/index.js install myowner/hello-handoff --target agents
```

## 在线交接（M1，DSH 插件）

把本地 DSH 会话分享成一个实时只读链接，访客在 Web 聊天页对话：

```bash
# relay + Web（同上）
AGENTSHARE_TOKENS=devtoken:myowner pnpm registry
pnpm web

# 同步插件到 refs/deepseek-harness 并在 clone 内运行（需要 DEEPSEEK_API_KEY）
pnpm dsh:dev
cd refs/deepseek-harness && pnpm install
pnpm run dsh web --patch ./packages/community/dsh-agentshare/cordis.source.patch.yml
```

DSH 里执行 `/share` 得到 `http://localhost:8787/#/share/<id>`，访客打开即聊；`/shares` 列表、`/unshare` 撤销。
协议与客户端在 `packages/core/src/share.ts`；无 DSH 时可用 `node scripts/mock-plugin.mjs` 做 relay 冒烟。

开发模式（免构建）：

```bash
pnpm --filter @agentshare/cli dev -- --help
pnpm --filter @agentshare/registry dev
pnpm --filter @agentshare/web dev
```

## 认证（v0）

- 注册表读取 `AGENTSHARE_TOKENS`，格式 `token:owner,token2:owner2`；未设置时为开发模式，任意 token 可用，owner 取 `AGENTSHARE_DEV_OWNER`（默认 `dev`）。
- CLI 配置存于 `~/.config/agentshare/config.json`（可用 `AGENTSHARE_CONFIG` 覆盖路径）。
- 发布不可变：`owner/name@version` 已存在则返回 409。

## 状态

- P0 骨架：离线包发布/安装链路可用（CLI + registry + Web）。
- M1 在线交接：relay（shares/tunnel/聊天页）+ DSH 插件源码完成，relay 冒烟通过；真机联调待 `refs/deepseek-harness` 安装构建。
- 详见 `docs/roadmap.md` 与 `docs/spec/m1-online-handoff.md`。

License: TBD
