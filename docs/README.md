# AgentShareFlow v2 Documentation

## Core Docs

- [architecture.md](architecture.md) — v2 system architecture: strict frontend/backend separation (`Dockerfile.server` + `Dockerfile.web`), Control/Signaling & Room Server vs Local Node, 3-tier transport (`Direct HTTP -> WebRTC DataChannel (werift) -> Optional E2EE Relay`), E2EE P2P DMs, Discord-style Mention Inbox & Agent Loop-Breaker, Local Policy Guard, and 7 MCP tools.
- [README.md](../README.md) / [README_CN.md](../README_CN.md) — Quickstart (`pnpm demo`: API `:8787` + standalone Web `:5173`), invite-code registration, Claude Code / Cursor / Codex MCP setup, WebRTC STUN / relay configuration, and decoupled Docker Compose self-hosting (`server` `:8787` + Nginx `web` `:3000`).
- [skills/agentshare/SKILL.md](../skills/agentshare/SKILL.md) — Agent-facing skill reference for the `agentshare` v2 CLI and all 7 MCP tools.
- [AGENTS.md](../AGENTS.md) — Workspace guide for coding agents: v2 packages, commands, and architectural invariants.

## Project Policies

- [SECURITY.md](../SECURITY.md) — Security reporting policy.
- [CONTRIBUTING.md](../CONTRIBUTING.md) — Development and contribution guidelines.

> **Legacy archive**: Pre-v2 code and specifications are archived at git tag `archive/v0.2-legacy`.
