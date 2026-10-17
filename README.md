<div align="center">

# AgentShareFlow

**Open registry, sandbox playground, and live session handoff relay for AI Agent Packs.**

[![Family: *Flow](https://img.shields.io/badge/family-*Flow-8A2BE2.svg)](https://github.com/mcocdaa)
[![CI](https://github.com/mcocdaa/AgentShareFlow/actions/workflows/ci.yml/badge.svg)](https://github.com/mcocdaa/AgentShareFlow/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/mcocdaa/AgentShareFlow?display_name=tag&sort=semver)](https://github.com/mcocdaa/AgentShareFlow/releases)
[![TypeScript 5.x](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)
[![Docker Ready](https://img.shields.io/badge/docker-ready-blue.svg)](Dockerfile)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[English](README.md) · [简体中文](README_CN.md)

<img src="docs/assets/demo_registry.gif" alt="AgentShareFlow Demo" width="840">

</div>

---

## ✨ Highlights

- **Multi-Harness Agent Pack Packaging**: Package skills, prompts, and MCP server specs once and install with a single command into **Claude Code**, **Codex**, **OpenCode**, **OpenClaw**, and **Hermes**, aligned with the [agentskills.io](https://agentskills.io) open specification.
- **Security Scanner & Lockfile Integrity**: Built-in static analysis blocks prompt-injection patterns and high-risk shell commands on `push`/`install`/`update`, backed by Ed25519 cryptographic signing (`agentshare keygen` / `push --sign`) and deterministic lockfiles.
- **Interactive Sandbox Playground & Symmetric Auth**: Test published Agent Packs directly in the browser playground (`#/playground`) and publish or manage packs with unified Bearer Token (`AGENTSHARE_TOKENS`) or OIDC authentication across WebUI and CLI.
- **Live Session Handoff & A2A Relay**: Share active local agent sessions via `/share` with per-visitor read-only forked contexts, or expose local A2A-compatible agents (`agentshare expose`) through outbound WebSocket tunnels without opening inbound ports.
- **Built-in MCP Server & Federated Ecosystem**: Run `agentshare serve --mcp` so any MCP-capable agent can autonomously search, inspect, and install verified Agent Packs, or import existing skills from ClawHub, Smithery, and `skills.sh`.
- **Cross-Tool Handoff Bundles**: Export and resume full conversation context, workspace diffs, and verifiable task submissions (`handoff/v0` & `submission/v0`) across heterogeneous agent harnesses.

---

## 🚀 Quick Start

### Option 1: Docker Compose (Recommended — 1 Command)

Start the unified registry, SQLite storage, and bundled Web UI on a single port:

```bash
AGENTSHARE_TOKENS='devtoken:myowner' docker compose up -d --build
```

Open **`http://localhost:8787`** in your browser to explore the Registry, Sandbox Playground, and Publish UI.

### Option 2: From Source (`pnpm`)

> **Prerequisites**: Node.js >= 22 (with built-in `node:sqlite`) and `pnpm` >= 9.

```bash
pnpm install && pnpm build
AGENTSHARE_TOKENS='devtoken:myowner' pnpm registry   # Starts API & Web relay on http://localhost:8787
pnpm web                                             # Optional: Vite dev server on http://localhost:5173
node packages/cli/dist/index.js login --registry http://localhost:8787 --token devtoken --owner myowner
node packages/cli/dist/index.js push examples/hello-handoff
```

---

## 🤖 CLI & MCP Usage

### Core CLI Workflow

```bash
# 1. Authenticate against your registry
agentshare login --registry http://localhost:8787 --token devtoken --owner myowner

# 2. Validate, security-scan, and publish an Agent Pack
agentshare push examples/hello-handoff

# 3. Search & inspect packs in the registry
agentshare search handoff
agentshare info myowner/hello-handoff

# 4. Install into your target harness (claude | codex | opencode | openclaw | hermes | agents)
agentshare install myowner/hello-handoff --target claude
```

### MCP Server Configuration (`agentshare serve --mcp`)

Expose `agentshare_search`, `agentshare_info`, and `agentshare_install` directly to your AI coding assistant:

```json
{
  "mcpServers": {
    "agentshare": {
      "command": "npx",
      "args": ["-y", "@agentshare/cli", "serve", "--mcp", "--registry", "http://localhost:8787"],
      "env": {
        "AGENTSHARE_TOKEN": "devtoken"
      }
    }
  }
}
```

### Interoperability & Local Agent Tunneling

```bash
# Import skills/servers from external registries into standard Agent Packs
agentshare import clawhub steipete/weather --out ./weather
agentshare import smithery upstash/context7-mcp --out ./context7

# Expose a local A2A agent through the relay without public inbound ports
agentshare expose --a2a http://127.0.0.1:9999 --title "My Local Agent"
```

---

## 📚 Documentation & Architecture

### Workspace Layout

| Directory | Package / Role | Description |
| :--- | :--- | :--- |
| `packages/core` | `@agentshare/core` | Zod schemas (`agent.json`), pack/unpack engine, security scanner, A2A & share tunnel protocol |
| `packages/cli` | `@agentshare/cli` | `agentshare` CLI (`login`, `push`, `search`, `install`, `update`, `import`, `expose`, `serve --mcp`) |
| `packages/registry` | `@agentshare/registry` | Hono + `node:sqlite` HTTP server: Packs API, Sandbox Playground, Share/Tunnel Hub, A2A Facade |
| `packages/web` | `@agentshare/web` | React + Vite Web UI for browsing packs, interactive playground, Web publishing, and live share chat |
| `packages/dsh-plugin` | `dsh-agentshare` | DeepSeek Harness plugin providing `/share`, `/shares`, and `/unshare` live session handoff |
| `examples/` | Sample Packs | Ready-to-publish single-skill (`hello-handoff`) and multi-skill (`multi-skill`) Agent Packs |

### Specifications & Design Docs

- **[Documentation Index](docs/README.md)** — Full overview of architecture notes, milestones, and roadmap.
- **[Agent Pack Specification v0](docs/spec/agent-pack.md)** — `agent.json` schema, pack modes, security scan rules, and harness path mappings.
- **[Registry HTTP API Specification v0](docs/spec/registry-api.md)** — REST endpoints for pack publishing, search, live shares, WebSocket tunnels, and SSE streams.
- **[M1 Online Handoff Design](docs/design/m1-online-handoff.md)** — Architecture for read-only visitor session forking and tunnel relay.

---

## 📄 License

Released under the [MIT License](LICENSE).
