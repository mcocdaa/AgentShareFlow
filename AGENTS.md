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
```

## Layout

- `packages/core` owns the Agent Pack spec (zod schema), manifest validation, tarball create/extract, harness skill-directory mapping, and the share tunnel protocol/client (`src/share.ts`). CLI, registry, web, and the DSH plugin depend on it.
- `packages/cli` is the `agentshare` binary (commander).
- `packages/registry` is the HTTP API (Hono + `node:sqlite` + local tarball storage) plus the in-memory share hub.
- `packages/web` is a Vite React SPA, hash routing, no router dependency. `#/share/:id` is the visitor chat page.
- `packages/dsh-plugin` is the DeepSeek Harness plugin. It is NOT a pnpm workspace member (DSH deps are private); sync it with `scripts/dsh-dev.sh` into `refs/deepseek-harness/packages/community/` for dev. Its tsconfig is clone-relative on purpose.
- `skill/agentshare/SKILL.md` is the agent-facing front door; keep it in sync with CLI flags.
- `docs/spec/*` are contracts. Change them together with code.

## Commands

- `node scripts/mock-plugin.mjs` exercises the share relay end-to-end without DSH.
- `pnpm typecheck` requires `refs/deepseek-harness` only for the DSH plugin, which is excluded.

## Conventions

- ESM + NodeNext everywhere: relative imports need a `.js` extension.
- The zod schema in `packages/core/src/manifest.ts` is the single source of truth for pack fields.
- No comments in code unless behavior is non-obvious.
- Never store secrets in packs or manifests — secret names only (`secrets: ["GITHUB_TOKEN"]`).
- Releases are immutable: `(owner, name, version)` conflict returns 409.
- CLI output is for humans by default and machine-readable with `--json`.
