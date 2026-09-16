# dsh-agentshare

DeepSeek Harness（dsh）插件：把当前会话分享成一个只读的实时链接，访客在网页上对话，消息经 relay 出站隧道进入本地 DSH 的独立 fork 会话。

源码位于本仓库 `packages/dsh-plugin/`，但**不是本仓库 pnpm workspace 的成员**；开发/运行都在 `refs/deepseek-harness` 这个 clone 里进行：

```bash
pnpm dsh:sync
cd refs/deepseek-harness
pnpm install
pnpm run dsh web --patch ./packages/community/dsh-agentshare/cordis.source.patch.yml
```

配置（profile 的 `cordis.patch.yml` 或插件 config）：

```yaml
- id: dsh-agentshare
  name: dsh-agentshare
  config:
    registry: http://localhost:8787
    tokenEnv: AGENTSHARE_TOKEN   # 只写名字，值由 credentials 提供
```

`AGENTSHARE_TOKEN` 需要能通过 dsh 的 credentials 解析（环境变量优先）。

命令：

- `/share` 创建分享并启动隧道，返回链接
- `/shares` 列出活动分享
- `/unshare [id]` 撤销（缺省撤销最近一个）

本地 relay：在本仓库 `AGENTSHARE_TOKENS=devtoken:you pnpm registry`，Web 分享页在 `pnpm web` 的 `#/share/<id>`。

注意：本目录的 `tsconfig.json` 使用 clone 内相对路径（`../../../tsconfig.base.json`），只应在同步进 clone 后运行 `tsc`。
