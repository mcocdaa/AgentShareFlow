---
name: changelog
description: Turn merged changes into a Keep a Changelog style entry. Use when preparing a release, writing a CHANGELOG section, or summarizing what changed since the last tag.
---

# Changelog

Draft the next release section from the changes the user provides or the current range (`git log <last-tag>..HEAD --oneline --no-merges`).

## Workflow

1. Collect the commits or diffs for the range. If the last tag is unknown, ask for it instead of guessing.
2. Group entries under `Added` / `Changed` / `Fixed` / `Removed`; drop internal-only churn (CI, formatting, refactors) unless it affects users.
3. One line per user-visible change: imperative mood, present tense, name the surface (CLI, registry, Web, plugin).
4. Reference issue or PR numbers only when they appear in the input; never invent them.
5. Output only the new version section, ready to paste above the previous one.

## Example

```markdown
## [0.2.0] - 2026-09-18

### Added

- `agentshare export` writes pack skills as plain SKILL.md directories.
- `agentshare diff <from> <to>` with added/removed/changed file counts.

### Fixed

- `install --force` now replaces a changed signer instead of skipping.
```

## What not to do

- Do not invent dates, issue numbers, or contributors.
- Do not rewrite older sections; changelogs are append-only.
