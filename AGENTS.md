# AgentShareFlow — notes for coding agents

## Commands

```bash
pnpm install
pnpm build          # topological, core first
pnpm test           # vitest (core)
pnpm typecheck      # builds first, then tsc --noEmit per package
pnpm registry       # registry dev server on :8787
pnpm web            # web dev server on :5173 (proxies /api -> :8787)
pnpm cli -- --help  # run CLI from source
pnpm mock:share     # relay end-to-end smoke without DSH (start registry first)
pnpm mock:a2a       # mock A2A agent for endpoint-share smoke on :9999
pnpm dsh:sync       # sync core + dsh-plugin into refs/deepseek-harness
```

## Layout

- `packages/core` owns the Agent Pack spec (zod schema), manifest validation, tarball create/extract, harness skill-directory mapping, the share tunnel protocol/client (`src/share.ts`), and the dependency-free A2A client (`src/a2a.ts`). CLI, registry, web, and the DSH plugin depend on it.
- `packages/cli` is the `agentshare` binary (commander).
- `packages/registry` is the HTTP API (Hono + `node:sqlite`) plus the in-memory share hub. Routes are split: `app.ts` composes (and serves `packages/web/dist` when present), `pack-routes.ts` serves packs, `share-routes.ts` serves tunnel + endpoint (A2A) shares, handoff-bearing share pages, outcome submissions, and the A2A facade that exposes tunnel shares as A2A agents. `oidc.ts`/`identity.ts` add optional OIDC sessions via the official `@hono/oidc-auth` middleware. `AGENTSHARE_PUBLIC_URL` drives share links.
- `packages/web` is a Vite React SPA, hash routing, no router dependency: `App.tsx` shell + pack list, `PackDetail.tsx`, `SharePage.tsx` (`#/share/:id` visitor chat), shared bits in `components.tsx`.
- `packages/dsh-plugin` is the DeepSeek Harness plugin. It is NOT a pnpm workspace member (DSH deps come from the harness workspace); sync it with `pnpm dsh:sync` into `refs/deepseek-harness/packages/community/`, then run `pnpm install && pnpm run build` inside the clone before `--patch` runs. Its tsconfig is clone-relative on purpose; do not run its tsc from this repo.
- The clone's `tsconfig.host.json` is edited by `pnpm dsh:sync` (idempotent) to include both synced packages; `refs/` stays untracked.
- `skills/agentshare/SKILL.md` is the agent-facing front door; keep it in sync with CLI flags.
- `docs/README.md` indexes docs: `docs/spec/*` are contracts (change with code), `docs/design/*` are design docs, `docs/roadmap.md` tracks the plan.

## Conventions

- ESM + NodeNext everywhere: relative imports need a `.js` extension. The DSH plugin is the exception — it uses `.ts` extensions like the harness sources.
- The zod schema in `packages/core/src/manifest.ts` is the single source of truth for pack fields.
- No comments in code unless behavior is non-obvious.
- Never store secrets in packs, manifests, or share config — secret names only (`secrets: ["GITHUB_TOKEN"]`, `tokenEnv: AGENTSHARE_TOKEN`).
- Releases are immutable: `(owner, name, version)` conflict returns 409.
- CLI output is for humans by default and machine-readable with `--json`.
- Registry ships must keep `refs/` untracked; the DSH clone is a local dev dependency.
