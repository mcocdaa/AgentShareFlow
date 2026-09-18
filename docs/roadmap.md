# Roadmap

差异化定位：**跨 harness 中立 + 离线/在线双形态 + 对话即资产（交接/问答）**。不做通用 skill 商店。

## M1 — 在线交接（DSH 插件优先）

- [x] relay：shares / share_sessions / share_messages + tunnel SSE/POST + 访客聊天页（`#/share/:id`）
- [x] 协议与客户端：`@agentshare/core/share.ts`（TunnelClient / ShareClient + 单测）
- [x] DSH 插件源码：`/share`、`/shares`、`/unshare` + 只读 fork（sandbox read-only + `tools.guard`）+ 流式转发
- [x] relay 冒烟：mock 隧道端到端（online → 问答 → 流式 → transcript → revoke 410）
- [x] clone 构建集成：sync 脚本接入 `tsconfig.host.json`，core 按 `lib/types` 约定参与整仓构建
- [x] 真机联调：真实 DSH + 真实模型跑通「访客提问 → fork → 流式回复 → transcript」
- [x] 只读策略对抗性审计：白名单 `tools.guard`（仅 15 个只读工具），实测 `read` 通过、`bash`/`write` 被拒且无文件落盘
- [x] `share_create` 工具：owner agent 可调用创建分享（探针实测生效），并对访客不可见（`tools.restrict` + guard）
- [x] 回合收尾：以 `agent/status → idle` 为界 flush `agent_done`，多步工具调用不再碎片化
- [x] 分发链路：`dsh plugin --profile demo add <目录>` 成功入 profile 且 `--dump-config` 可见；core 以 `file:` 依赖随插件走
- [x] 公网部署：`AGENTSHARE_PUBLIC_URL` + registry 托管 Web 静态页 + Dockerfile/compose（后台构建验证中）
- [x] endpoint 分享：任意 A2A agent（AgentCard 校验、`SendMessage` 兼容 `message/send`、`contextId` 多轮）
- [x] A2A facade：tunnel 分享暴露为 A2A agent（Agent Card + JSON-RPC `SendMessage`/`message/send`，`contextId` 多轮），冒烟含卡片发现、两轮连续、离线/撤销/未知方法错误
- [ ] 插件 npm 发布：发布准备已完成（包元数据 / README / `release.yml` / `pnpm pack` 校验，workspace 依赖正确改写）；待 `npm login` 后打 `v*` tag 发布

## M2 — 跨工具交接（进行中）

- [x] `handoff/v0` 契约：目标/完成标准、约束与环境、资料来源、关键决策（含证据）、进度待办、成果、授权状态（core `handoff.ts` + zod + Markdown + 测试）
- [x] DSH 导出：owner agent 调 `handoff_draft` 生成草稿（预览不落盘），用户 `/handoff <digest>` 确认后写入 `agentshare-handoff-*/`；访客 fork 不可用
- [x] Codex 导入：`agentshare handoff import <file>` 默认预览（警告/需重新授权/引用需人工核对），`--confirm <digest>` 写入独立目录 + `CODEX-PROMPT.md`；不覆盖项目指令、不执行命令、不继承授权
- [x] 真实续做验证：DSH 导出 → CLI 导入 → 真实 Codex 完成待办 → 独立复跑验收测试 3/3
- [x] 可对话交接页：分享携带 handoff，访客页呈现目标/待办/决策与证据（`handoff/v0`）
- [x] 成果回流：`submission/v0` 提交（摘要/变更/未解决问题）→ 拥有者 CLI 接收或退回（附言）→ 决策以系统消息回到访客会话
- [ ] 公开案例展示「原任务 → 交接 → 后续成果」（需单独同意）

## P0 — 骨架（已完成）

- [x] pnpm monorepo：core / cli / registry / web
- [x] Agent Pack 规范 v0 + zod schema + 打包/解包/校验
- [x] CLI：login / pack / push / search / info / install（6 个 harness 目录）
- [x] Registry：Hono + node:sqlite + 本地 tarball 存储 + Bearer 鉴权
- [x] Web：搜索 + 详情 + 安装命令
- [x] 门面 skill `skills/agentshare/SKILL.md` + 示例包
- [x] 仓库整理：docs 索引与 design 目录、registry packs/share 路由拆分、web 页面拆分、脚本重命名
- [x] 首次提交并推送远程（`faac75a` 起）

## P1 — 离线包 MVP（4–6 周）

- [ ] 账号体系（OIDC / magic link），org / 命名空间
- [x] 版本 diff：`agentshare diff <from> <to>`（文件级 added/removed/changed + 行数，`--json`）
- [ ] 发布 pipeline：CI 发布（`examples/publish-workflow.yml` 模板已给，待真实仓库验证）、多 skill pack 示例
- [x] 安装升级：`agentshare update`（`--dry-run` 先看版本计划）、lockfile（`agentshare-lock/v0`）、来源记录（digest/registry/target/scope/dest）
- [x] 发布扫描：`high/medium` 规则（提示注入、危险命令、隐藏字符）；`push`/`install`/`update` 本地拦截 + registry 服务端拦截，`--allow-risky` 显式越过
- [ ] manifest 签名（minisign）、安装量 / 星标
- [ ] 互操作：导入 ClawHub / Smithery / skills.sh；导出为标准 SKILL.md 目录
- [x] `agentshare serve --mcp`：stdio MCP server 暴露 `agentshare_search` / `agentshare_info` / `agentshare_install`（高危扫描阻断以 `isError` 返回）；冒烟含 initialize/tools/搜索/信息/安装/坏输入

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
