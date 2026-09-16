# dsh-agentshare

DeepSeek Harness（dsh）插件：把当前会话分享成一个只读的实时链接，访客在网页上对话，消息经 relay 出站隧道进入本地 DSH 的独立 fork 会话。

源码位于本仓库 `packages/dsh-plugin/`，但**不是本仓库 pnpm workspace 的成员**；开发/运行都在 `refs/deepseek-harness` 这个 clone 里进行。

## 开发循环

```bash
# 1) 同步进 clone（会改写 core 包元数据并把两个包接入 tsconfig.host.json）
pnpm dsh:sync

# 2) clone 内安装与整仓构建（core/插件作为 workspace 包参与）
cd refs/deepseek-harness
pnpm install
pnpm run build

# 3) 运行（隔离 DSH_HOME 避免旧 profile 包干扰）
DSH_HOME=/tmp/dsh-home AGENTSHARE_TOKEN=<relay token> \
  pnpm run dsh web --patch ./packages/community/dsh-agentshare/cordis.source.patch.yml
```

本地 relay：在本仓库 `AGENTSHARE_TOKENS=devtoken:you pnpm registry`，Web 分享页在 `pnpm web` 的 `#/share/<id>`。

## 配置

profile 或 patch 行里的插件 config：

```yaml
- id: dsh-agentshare
  name: dsh-agentshare
  config:
    registry: http://localhost:8787
    tokenEnv: AGENTSHARE_TOKEN   # 只写名字，值由 dsh credentials 提供
```

`AGENTSHARE_TOKEN` 需要能通过 dsh 的 credentials 解析（环境变量优先）。

## 使用

- `/share` 创建分享并启动隧道，返回链接
- `/shares` 列出活动分享
- `/unshare [id]` 撤销（缺省撤销最近一个）

## 开发探针（dev-only）

`dev/probe.ts` + `cordis.dev.patch.yml` 用于无 Web UI 的端到端验证：启动后自动创建一个 agent、建立分享、跑一轮 seed 对话，并打印链接。

```bash
DSH_HOME=/tmp/dsh-home AGENTSHARE_TOKEN=devtoken \
  pnpm run dsh web --patch ./packages/community/dsh-agentshare/cordis.dev.patch.yml
```

## 只读策略

访客 fork 在 `setup` 中：挂载 owner 的 preset（如存在）→ 继承 owner 的 route（provider/model）并 `installModelSelection` → `tools.guard` 拒绝写/执行类工具（`bash`、`pwsh`、`str_replace_editor`、`terminal_*`、`job_*`、`team_task_*`、`cordis_*` 等）→ 会话追加 `sandbox/mode: read-only`。

注意：本目录的 `tsconfig.json` 使用 clone 内相对路径（`../../../tsconfig.base.json`，references 指向 `../../core/*` 等），只应在同步进 clone 后编译。
