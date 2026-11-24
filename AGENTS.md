# AgentShareFlow v2 — notes for coding agents

## Commands

Requires Node.js >= 22.5.0 (built-in `node:sqlite`) and `pnpm@10.32.1`.

```bash
pnpm install
pnpm build              # topological build across all 4 workspace packages
pnpm test               # vitest across workspace packages
pnpm typecheck          # tsc --noEmit per package
pnpm server             # pure API + WS control/signaling & room server dev on :8787
pnpm web                # standalone Vite React dev server on :5173 (proxies /api, /healthz, /ws -> VITE_PROXY_TARGET, default :8787)
pnpm node -- --help     # run agentshare CLI from source
pnpm demo               # local demo: pure API server (:8787) + separate static Web UI (:5173) + #general + @helper-bot
```

## Workspace Layout

- `packages/core` (`@agentshare/core`) owns shared v2 protocol Zod schemas & mention/signing helpers (`src/protocol.ts`, including `IceServerConfigSchema`), Ed25519/X25519 + HKDF-SHA256 + AES-256-GCM E2EE DM crypto (`src/crypto.ts`), DNS/IP SSRF guard (`src/ssrf.ts`), 3-tier fallback transport router (`src/transport.ts`: `Direct HTTP -> WebRTC DataChannel (werift) -> Optional E2EE Relay`), and HTTP/A2A agent adapter client (`src/a2a.ts`). Exposes both `.` (Node) and `./protocol` (100% browser-safe, Zod-only).
- `packages/server` (`@agentshare/server`, private) is the self-hosted **pure API + WebSocket** Control/Signaling & Room Server (Hono + `@hono/node-server` + `ws` + `node:sqlite` WAL). Serves `/healthz`, `/api/v2/*`, and authenticated WebSocket `/ws` with configurable CORS (`AGENTSHARE_CORS_ORIGINS`, default `*`; `OPTIONS` preflight returns `204` before auth; unknown routes including `/` return JSON `404`). Has **zero static frontend hosting**. Advertises WebRTC STUN/ICE servers via `AGENTSHARE_STUN_URLS` (default `stun:stun.l.google.com:19302`) and enforces a 64 KiB cap on signaling payloads. Optional E2EE relay is controlled by `AGENTSHARE_ENABLE_RELAY` (default `false`) and admin `PATCH /api/v2/admin/settings`.
- `packages/node` (`@agentshare/node`, binary `agentshare`) is the local agent node daemon + CLI + MCP server. Manages `~/.agentshare/` (`identity.json`, `session.json`, `policy.json`, `daemon.json`, `local.db`), Direct P2P HTTP receiver (`POST /p2p/v2/message`), WebRTC DataChannel peer manager (`src/webrtc.ts` via `werift`, with `--no-webrtc` / `--stun <urls>` CLI options), `127.0.0.1`-only Local Control API (`/local/*`, allowing `http://localhost:*` and `http://127.0.0.1:*` by default plus `--allowed-origins <csv>` for separately hosted Web UIs), Local Policy Guard (`auto` / `read_only_scoped` / `manual_approval`), adapters (`mcp`, `http`, `a2a`, `cli`), JSON-RPC 2.0 stdio MCP server (7 tools), and `demo-bot`.
- `packages/web` (`@agentshare/web`, private) is the **standalone** Vite + React 19 Discord-style Web SPA (ZH/EN i18n, invite-code auth, rooms with `@mention` autocomplete and loop-breaker banner, friends & pair codes, admin settings, and optional localhost DM/approval panel with Direct / WebRTC P2P / Relay badges). Connects to any backend via `?server=<url>`, the login screen's server URL switcher (`localStorage`), build-time `VITE_API_BASE_URL`, or same-origin fallback, and ships `nginx.conf` for independent static hosting.
- `Dockerfile.server`, `Dockerfile.web`, and `docker-compose.yml` build and run the decoupled backend (`:8787`, zero `packages/web`) and non-root Nginx frontend (`:3000` -> `:8080`) as two independent containers.
- `scripts/demo.mjs` boots the built `@agentshare/server` (`:8787`), a separate static HTTP server for `packages/web/dist` (`:5173`, `WEB_PORT`), and `@agentshare/node` (`@helper-bot` with `allowedOrigins: [webUrl]`) for `pnpm demo`.
- `skills/agentshare/SKILL.md` is the agent-facing front door; keep it in sync with `packages/node` CLI commands and MCP tools.
- `docs/architecture.md` and `docs/README.md` document the v2 architecture and invariants; update alongside protocol or behavior changes.

## Conventions & Invariants

- **Strict frontend/backend separation**: `packages/server` MUST remain a pure API + WebSocket server and MUST NEVER serve static frontend files from `packages/web/dist`. `Dockerfile.server` MUST NEVER copy or bundle `packages/web`; `Dockerfile.web` serves the static SPA via Nginx independently.
- **ESM + NodeNext everywhere**: relative imports in `packages/core`, `packages/server`, and `packages/node` MUST include `.js` extensions.
- **Browser-safe Web boundary**: `packages/web` MUST NEVER import `node:*` modules; import shared types and helpers ONLY from `@agentshare/core/protocol`.
- **Single source of truth**: `packages/core/src/protocol.ts` owns all wire schemas, frame unions, `HANDLE_PATTERN`, and `DEFAULT_MAX_AGENT_HOPS`.
- **Zero server-side DM persistence**: `packages/server` MUST NEVER add a `dm_messages` table or store 1v1 DM contents. All 1v1 DMs are E2EE and persisted only in each node's local SQLite (`~/.agentshare/local.db`).
- **Invite-only registration**: `POST /api/v2/auth/register` MUST reject requests without a valid, unexpired invite code (`403`). Session tokens are stored only as `SHA-256` hashes, and `/ws` auth is checked on HTTP `upgrade` before `handleUpgrade` (`401` + socket destroy on failure).
- **SSRF & redirect protection**: All outbound Direct P2P HTTP and HTTP/A2A requests MUST run `assertSafeExternalUrl` (DNS all-records + private IPv4/IPv6 check) and use `redirect: "manual"`, rejecting 3xx responses.
- **No shell injection & no committed secrets**: CLI adapters MUST use `shell: false`; never store secrets in manifests, policy files, or git — reference env var names only (`tokenEnv`).
- **Minimal comments**: no comments in code unless behavior is non-obvious.
- **Untracked local refs**: keep `refs/` untracked.
