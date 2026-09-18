# @agentshare/cli

AgentShareFlow 命令行客户端。

```bash
npm install -g @agentshare/cli
# 或
npx @agentshare/cli --help
```

## 命令

```bash
agentshare login --registry <url> --token <token> [--owner <owner>]
agentshare whoami

agentshare pack [dir] [--out <file>]            # 校验并打包
agentshare push [dir] [--dry-run]               # 发布 Agent Pack
agentshare search <query> [--json]
agentshare info <owner>/<name>[@version] [--json]
agentshare install <owner>/<name>[@version] --target <targets>

agentshare handoff import <handoff.json> [--target codex] [--dir <dir>] [--confirm <digest>] [--json]

agentshare share submissions <shareId> [--json]
agentshare share decide <shareId> <submissionId> --accept|--reject [--note <text>] [--json]
```

- `install` 目标：`agents`（跨客户端默认）、`claude`、`codex`、`opencode`、`openclaw`、`hermes`、`all`；`--project` 安装到当前项目。
- `handoff import` 默认只预览并返回 digest；确认后写入独立目录，不覆盖项目指令、不执行命令。
- `share` 命令用于原任务人查看并接收/退回访客成果。

配置存于 `~/.config/agentshare/config.json`（`AGENTSHARE_CONFIG` 可覆盖）。

MIT License。
