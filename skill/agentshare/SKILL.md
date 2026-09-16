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
```

Targets: `agents` (cross-client default), `claude`, `codex`, `opencode`, `openclaw`, `hermes`, or `all`. Add `--project` to install into the current project (e.g. `.claude/skills`) instead of the user directory. `--force` overwrites.

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

- Never put secrets in a pack. Declare names in `secrets: ["GITHUB_TOKEN"]` and let the installer inject values.
- Releases are immutable: bump `version` to publish again.
- Reference paths in `agent.json` (skills, instructions, mcp config) must exist in the pack directory or `push` fails.
- Prefer installing to `agents` (the cross-client `~/.agents/skills` standard) unless the user names a specific harness.
