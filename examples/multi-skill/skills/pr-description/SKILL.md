---
name: pr-description
description: Write a pull request description from a diff or commit list. Use when opening or updating a PR, or when asked to summarize branch changes for review.
---

# PR Description

Write descriptions a reviewer can act on: problem first, then approach, then evidence.

## Workflow

1. Inspect the change (`git diff <base>...HEAD --stat`, plus the full diff for files whose intent is not obvious from names) or use the summary the user provides.
2. Lead with the problem and the approach. Do not narrate file by file.
3. Add a `Verified` section listing the exact commands run and their outcome (tests, typecheck, smoke). Never claim a check you did not run.
4. Call out breaking changes, migrations, and follow-ups first-class; silence is a claim.
5. Keep it under about 20 lines unless the change is genuinely large.

## Template

```markdown
## What

One paragraph: the problem and the chosen approach.

## Verified

- `pnpm test`: 81 passed
- `agentshare export ow/name --out /tmp/skills`: two skill directories written

## Follow-ups

- Known limitation or next step.
```

## What not to do

- Do not pad with a diff summary the reviewer can read.
- Do not claim verification that was not performed.
