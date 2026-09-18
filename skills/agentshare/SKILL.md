---
name: agentshare
description: Publish, discover, and install Agent Packs on an AgentShare registry. Use when the user wants to share an agent or skill, hand off a project agent, publish a prompt/MCP pack, search for reusable agent packs, or install a shared pack into Claude Code, Codex, opencode, OpenClaw, or Hermes.
---

# AgentShare

AgentShare is a registry for Agent Packs: portable folders containing a `SKILL.md`, prompts, MCP config, and/or an online agent endpoint (MCP/A2A). It is how a user's agent gets shared, versioned, and handed off.

## When to use

Reach for this skill when the user says things like:

- "share this agent/skill with my team"
- "publish this prompt pack"
- "hand off this project so people can ask my agent questions"
- "find a pack for X" / "install a pack someone shared"

## Commands

Run through the CLI (installed globally or via `npx @agentshare/cli`):

```bash
agentshare login --registry <url> --token <token> --owner <owner>
agentshare whoami

agentshare pack [dir] [--out <file>]          # validate + create tarball
agentshare push [dir] [--dry-run]             # validate, pack, publish
agentshare search <query> [--json]
agentshare info <owner>/<name>[@version] [--json]
agentshare install <owner>/<name>[@version] --target <targets>
agentshare update [owner/name] [--dry-run]    # reinstall locked packs to latest
agentshare diff <from> <to> [--json]           # compare two pack versions file by file
agentshare star <owner>/<name>                 # star a pack (unstar to remove)
agentshare serve --mcp                         # stdio MCP server: search/info/install as tools
```

Installs are recorded in a lockfile (`agentshare.lock.json`): project installs record in the project root, user-level installs in the CLI config directory. Each entry keeps owner/name/version, tarball digest, target, scope, destination, and registry, so `agentshare update` can reinstall to the same places and `--dry-run` shows the version plan first.

Targets: `agents` (cross-client default), `claude`, `codex`, `opencode`, `openclaw`, `hermes`, or `all`. Add `--project` to install into the current project (e.g. `.claude/skills`) instead of the user directory. `--force` overwrites.

## Continuing a handoff in Codex

```bash
agentshare handoff import ./handoff.json --target codex --dir ./project --json
agentshare handoff import ./handoff.json --target codex --dir ./project --confirm <digest> --json
```

The first command only previews; review its content, destination and warnings before confirming the returned digest. The destination must already exist. Confirmation writes `handoff.json`, `handoff.md` and `CODEX-PROMPT.md` in a new independent subdirectory, not a skill installation. Ask Codex in the receiving project to read the returned prompt path. Existing instructions are not overwritten and no commands are executed. Permissions require fresh authorization; references are neither copied nor verified, so missing files and source-machine paths require manual resolution. This imports selected context, not a running Agent or its credentials.

## Creating a pack

1. Create a directory with `agent.json` (the manifest) and a `SKILL.md`.
2. Minimal offline manifest:

```json
{
  "spec": "agent-pack/v0",
  "name": "my-agent",
  "version": "0.1.0",
  "title": "My Agent",
  "description": "What it does and when to use it.",
  "mode": "offline",
  "tags": ["handoff"],
  "skills": ["."]
}
```

3. Validate and publish:

```bash
agentshare push ./my-agent --dry-run
agentshare push ./my-agent
```

## Modes

- `offline`: files only, installed into local harness skill directories.
- `endpoint`: declares `endpoint: { type: "mcp" | "a2a", url, agentCard? }` for a user-hosted live agent. Installing only links the pack; asking questions happens against the endpoint.
- `runtime`: declares a container `runtime` for hosted execution (registry support is on the roadmap).

## Rules

- `push`, `install`, and `update` run a security scan (prompt injection, dangerous commands). High-severity findings block the action; only pass `--allow-risky` after the user has reviewed the findings and explicitly accepted the risk. Never use it silently.
- Sign releases with `agentshare keygen` once and `agentshare push --sign`; install and update verify signatures and refuse a changed signer unless the user explicitly reinstalls with `--force`.
- Never put secrets in a pack. Declare names in `secrets: ["GITHUB_TOKEN"]` and let the installer inject values.
- Releases are immutable: bump `version` to publish again.
- Reference paths in `agent.json` (skills, instructions, mcp config) must exist in the pack directory or `push` fails.
- Prefer installing to `agents` (the cross-client `~/.agents/skills` standard) unless the user names a specific harness.
