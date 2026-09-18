# @agentshare/core

AgentShareFlow 的共享核心：Agent Pack 规范、打包与校验、分享隧道协议、A2A 客户端、交接（handoff/v0）与成果（submission/v0）契约。

- ESM + NodeNext；Node ≥ 22.5。
- 单一导出入口：`import { ... } from "@agentshare/core"`。
- 契约文档：`docs/spec/agent-pack.md`、`docs/spec/registry-api.md`（主仓库）。

主要导出：

| 模块 | 内容 |
|---|---|
| `manifest.ts` | `agent-pack/v0` zod schema、harness 列表 |
| `pack.ts` | tarball 打包 / 解包 / digest |
| `harness.ts` | 各 harness 安装目录映射 |
| `share.ts` | `TunnelClient` / `ShareClient`（分享、消息、成果、A2A facade 调用） |
| `a2a.ts` | 无依赖 A2A 客户端（Agent Card、`SendMessage`、文本提取） |
| `handoff.ts` | `handoff/v0` 校验、Markdown 渲染、导入预览与确认 |
| `submission.ts` | `submission/v0` 校验 |

MIT License。
