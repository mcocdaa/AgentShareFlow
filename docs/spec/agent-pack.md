# Agent Pack 规范 v0

`spec: agent-pack/v0`

Agent Pack 是发布到注册表的不可变版本化包。三种模式：

| mode | 含义 | 运行位置 |
|---|---|---|
| `offline` | 纯文件包：SKILL.md、提示词、MCP 配置、参考资料 | 安装到本地 harness |
| `endpoint` | 指向用户自托管的在线 agent（MCP 或 A2A 端点） | 用户自己的机器/服务器 |
| `runtime` | 声明容器镜像，由注册表侧沙箱托管（排期中） | 托管运行时 |

## 目录结构

```
my-agent/
├── agent.json          # 必需：manifest
├── SKILL.md            # 推荐：门面 skill（agentskills.io 标准）
├── AGENTS.md           # 可选：项目指令
├── mcp.json            # 可选：MCP server 配置
├── references/         # 可选：按需加载的文档
├── scripts/            # 可选：可执行脚本
└── Dockerfile          # mode=runtime 时必需（或 manifest.runtime.image）
```

`skills` 数组列出包内 skill 目录（相对路径）。只包含一个根 skill 时用 `["."]`。

## agent.json 字段

| 字段 | 必需 | 约束 | 说明 |
|---|---|---|---|
| `spec` | 是 | 固定 `agent-pack/v0` | 规范版本 |
| `name` | 是 | 小写字母/数字/连字符，≤64 | 包名，须与注册表路径一致 |
| `version` | 是 | semver | 发布不可变 |
| `title` | 是 | ≤120 | 展示名 |
| `description` | 是 | ≤1024 | 做什么 + 什么时候用 |
| `mode` | 是 | `offline` / `endpoint` / `runtime` | 见上表 |
| `tags` | 否 | ≤16 个，每个 ≤32 | 搜索标签 |
| `license` | 否 | ≤120 | 许可证名或文件引用 |
| `compatibility` | 否 | harness 列表 | 默认 `["agents"]`，可选 `claude`/`codex`/`opencode`/`openclaw`/`hermes` |
| `skills` | 否 | 相对路径数组 | skill 目录，根 skill 用 `"."` |
| `instructions` | 否 | 相对路径数组 | 如 `AGENTS.md` |
| `mcp` | 否 | `{ "config": "mcp.json" }` | MCP 配置文件名 |
| `endpoint` | mode=endpoint 时 | `{ type, url, agentCard? }` | `type` 为 `mcp`/`a2a`；`agentCard` 指向 A2A Agent Card |
| `runtime` | mode=runtime 时 | `{ image? 或 dockerfile?, port?, protocol }` | 二选一，不能同时给 |
| `secrets` | 否 | `ENV_STYLE` 名称数组 | **只写名称，绝不写值** |
| `metadata` | 否 | string→string | author/homepage/repository 等 |

## 校验规则

- `mode=offline` 不得声明 `endpoint` / `runtime`。
- 引用路径必须存在（注册表和 CLI 都会校验）。
- `name` 全库唯一于 `owner` 之下；`version` 发布后不可覆盖。
- digest：注册表按 tarball 的 SHA-256 记录，发布时可带 `x-pack-digest` 校验。

## 安全

- 包内一律不写密钥；`secrets` 只列名字，由安装方运行时注入。
- 发布内容按不可信输入处理：解包时禁用路径逃逸（node-tar 默认行为）、后续加扫描与签名（见 roadmap）。
- 签名（minisign / sigstore）与来源证明为 v1 目标。

## 安装映射（v0）

`agentshare install owner/name --target <harness>` 将 `skills` 中每个条目拷贝到：

| harness | 用户级目录 | 项目级目录（`--project`） |
|---|---|---|
| `agents`（跨客户端标准） | `~/.agents/skills` | `.agents/skills` |
| `claude` | `~/.claude/skills` | `.claude/skills` |
| `codex` | `~/.codex/skills` | `.codex/skills` |
| `opencode` | `~/.config/opencode/skills` | `.opencode/skills` |
| `openclaw` | `~/.openclaw/skills` | `skills` |
| `hermes` | `~/.hermes/skills` | `.hermes/skills` |

目标已存在时默认跳过，`--force` 覆盖。
