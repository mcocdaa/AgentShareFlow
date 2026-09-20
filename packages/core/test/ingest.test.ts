import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  detectDeclaredSecrets,
  discoverHarnessSkills,
  ingestSkillFromHarness,
  readPack,
} from "../src/index.js";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentshare-ingest-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe("ingest", () => {
  it("detects secret environment variables from skill markdown and configs", () => {
    const text = `
# Deploy Skill
This skill requires GITHUB_TOKEN to authenticate with GitHub.
Also configure OPENAI_API_KEY and AWS_SECRET_ACCESS_KEY.
Ignore HTTP, JSON, and README tags.
    `;
    const secrets = detectDeclaredSecrets(text);
    expect(secrets).toContain("GITHUB_TOKEN");
    expect(secrets).toContain("OPENAI_API_KEY");
    expect(secrets).toContain("AWS_SECRET_ACCESS_KEY");
    expect(secrets).not.toContain("HTTP");
    expect(secrets).not.toContain("JSON");
    expect(secrets).not.toContain("README");
  });

  it("ingests a local skill from a harness project directory into an agent pack", async () => {
    const workspace = await createTempDir();
    const claudeSkillsDir = path.join(workspace, ".claude", "skills", "code-reviewer");
    await fs.mkdir(claudeSkillsDir, { recursive: true });

    const skillMd = `---
name: code-reviewer
description: Automated code review and security auditing skill.
---

# Code Reviewer
Reviews PRs and audits code.
Requires GITHUB_TOKEN.
`;
    await fs.writeFile(path.join(claudeSkillsDir, "SKILL.md"), skillMd, "utf8");
    await fs.writeFile(path.join(claudeSkillsDir, "review.sh"), "#!/bin/bash\necho ok\n", "utf8");

    // Discover skills
    const discovered = await discoverHarnessSkills("claude", {
      project: true,
      cwd: workspace,
    });
    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.name).toBe("code-reviewer");
    expect(discovered[0]?.hasSkillMd).toBe(true);

    // Ingest into a pack
    const outDir = path.join(workspace, "my-code-reviewer-pack");
    const result = await ingestSkillFromHarness("claude", "code-reviewer", {
      project: true,
      cwd: workspace,
      out: outDir,
      targetHarnesses: ["claude", "codex", "agents"],
    });

    expect(result.harness).toBe("claude");
    expect(result.skillName).toBe("code-reviewer");
    expect(result.outDir).toBe(outDir);
    expect(result.files).toContain("SKILL.md");
    expect(result.files).toContain("review.sh");
    expect(result.files).toContain("agent.json");

    // Verify manifest
    const { manifest } = await readPack(outDir);
    expect(manifest.name).toBe("code-reviewer");
    expect(manifest.mode).toBe("offline");
    expect(manifest.compatibility).toEqual(["claude", "codex", "agents"]);
    expect(manifest.secrets).toContain("GITHUB_TOKEN");
    expect(manifest.metadata.ingestedFrom).toBe("claude");
  });

  it("auto-scaffolds SKILL.md if source skill only contains scripts", async () => {
    const workspace = await createTempDir();
    const skillDir = path.join(workspace, ".codex", "skills", "simple-tool");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, "run.py"), "print('hello')", "utf8");

    const outDir = path.join(workspace, "simple-tool-pack");
    const result = await ingestSkillFromHarness("codex", "simple-tool", {
      project: true,
      cwd: workspace,
      out: outDir,
    });

    expect(result.files).toContain("SKILL.md");
    expect(result.files).toContain("run.py");
    expect(result.files).toContain("agent.json");

    const skillContent = await fs.readFile(path.join(outDir, "SKILL.md"), "utf8");
    expect(skillContent).toContain("simple-tool");
  });
});
