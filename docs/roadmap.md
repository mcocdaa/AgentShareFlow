# Roadmap

差异化定位：**跨 harness 中立 + 离线/在线双形态 + 对话即资产（交接/问答）**。不做通用 skill 商店。

## M1 — 在线交接（当前冲刺，DSH 插件优先）

- [x] relay：shares / share_sessions / share_messages + tunnel SSE/POST + 访客聊天页（`#/share/:id`）
- [x] 协议与客户端：`@agentshare/core/share.ts`（TunnelClient / ShareClient + 单测）
- [x] DSH 插件源码：`/share`、`/shares`、`/unshare` + 只读 fork（sandbox read-only + tools restrict）+ 流式转发
- [x] relay 冒烟：mock 隧道端到端（online → 问答 → 流式 → transcript → revoke 410）
- [ ] DSH 真机联调：`pnpm dsh:dev` + clone 内 `pnpm install` + `--patch` 运行，验证 fork/流式
- [ ] 插件在 clone 内 typecheck 通过，补 `share_create` 工具（tool 侧 agent 上下文就绪后）

## P0 — 骨架（已完成）

- [x] pnpm monorepo：core / cli / registry / web
- [x] Agent Pack 规范 v0 + zod schema + 打包/解包/校验
- [x] CLI：login / pack / push / search / info / install（6 个 harness 目录）
- [x] Registry：Hono + node:sqlite + 本地 tarball 存储 + Bearer 鉴权
- [x] Web：搜索 + 详情 + 安装命令
- [x] 门面 skill `skill/agentshare/SKILL.md` + 示例包
- [ ] 首次提交后推送远程

## P1 — 离线包 MVP（4–6 周）

- [ ] 账号体系（OIDC / magic link），org / 命名空间
- [ ] 发布 pipeline：CI 发布（GitHub Action）、多 skill pack、版本 diff
- [ ] 安装升级：`agentshare update`、lockfile、来源记录
- [ ] 质量与安全：manifest 签名（minisign）、发布扫描（提示注入 / 危险命令）、安装量 / 星标
- [ ] 互操作：导入 ClawHub / Smithery / skills.sh；导出为标准 SKILL.md 目录
- [ ] `agentshare serve --mcp`：让 agent 直接搜索/安装注册表

## P2 — 在线 agent（5–7 周）

- [ ] `endpoint` 模式：注册 MCP / A2A 端点，校验 Agent Card，反代与鉴权
- [ ] `agentshare expose`：本地 agent 通过隧道（outbound WS）挂公网链接
- [ ] 聊天控制台：SSE 流式、会话记录、限流与配额
- [ ] 对话冻结与分享：只读分享页 + fork 继续问（交接核心）
- [ ] 可嵌入 chat widget（iframe）

## P3 — 社区与托管运行时（4 周+）

- [ ] 评论 / collection / fork / remix / 徽章
- [ ] 团队空间与私有注册表、审计
- [ ] `runtime` 模式：沙箱托管容器（gVisor / Firecracker / Cloudflare Containers），按 agent 发 token
- [ ] 支付与分成（付费 agent）
- [ ] 联邦：A2A 注册表互通

## 里程碑判断

- M1：能发布/安装离线包，5 个 harness 全部验证通过
- M2：能给同事发一个「问项目 agent」的链接，对方无需本地环境即可使用
- M3：有外部贡献者的包与真实交接案例
