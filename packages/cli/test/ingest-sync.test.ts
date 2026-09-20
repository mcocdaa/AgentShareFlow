import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ingestCommand, syncCommand } from "../src/commands.js";
import { LOCKFILE_FILENAME, emptyLockfile, upsertInstall, writeLockfile } from "@agentshare/core";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentshare-cli-ingest-sync-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe("cli ingest and sync commands", () => {
  it("ingests skill from a harness directory and generates pack with agent.json", async () => {
    const cwd = await createTempDir();
    const claudeDir = path.join(cwd, ".claude", "skills", "test-runner");
    await fs.mkdir(claudeDir, { recursive: true });
    await fs.writeFile(
      path.join(claudeDir, "SKILL.md"),
      `---
name: test-runner
description: Automated test execution skill.
---
# Test Runner
Uses CI_TOKEN and GITHUB_TOKEN.
`,
      "utf8",
    );
    await fs.writeFile(path.join(claudeDir, "run.sh"), "#!/bin/bash\necho ok", "utf8");

    const outDir = path.join(cwd, "ingested-pack");
    await ingestCommand("test-runner", {
      from: "claude",
      project: true,
      cwd,
      out: outDir,
    });

    const statAgentJson = await fs.stat(path.join(outDir, "agent.json"));
    expect(statAgentJson.isFile()).toBe(true);

    const manifest = JSON.parse(await fs.readFile(path.join(outDir, "agent.json"), "utf8"));
    expect(manifest.name).toBe("test-runner");
    expect(manifest.compatibility).toContain("claude");
    expect(manifest.secrets).toContain("GITHUB_TOKEN");
  });

  it("lists discovered skills when no skillName is passed", async () => {
    const cwd = await createTempDir();
    const codexDir = path.join(cwd, ".codex", "skills", "db-helper");
    await fs.mkdir(codexDir, { recursive: true });
    await fs.writeFile(path.join(codexDir, "SKILL.md"), "# DB Helper", "utf8");

    let logged = "";
    const origLog = console.log;
    console.log = (msg: string) => {
      logged += msg + "\n";
    };

    try {
      await ingestCommand(undefined, {
        from: "codex",
        project: true,
        cwd,
      });
    } finally {
      console.log = origLog;
    }

    expect(logged).toContain("db-helper");
  });

  it("sync command reports lockfile status accurately", async () => {
    const cwd = await createTempDir();
    const origCwd = process.cwd();
    process.chdir(cwd);

    try {
      const lockfile = path.join(cwd, LOCKFILE_FILENAME);
      const skillPath = path.join(cwd, "skills", "my-skill");
      await fs.mkdir(skillPath, { recursive: true });
      await fs.writeFile(path.join(skillPath, "SKILL.md"), "# Skill", "utf8");

      let lock = emptyLockfile();
      lock = upsertInstall(lock, {
        owner: "test",
        name: "my-skill",
        version: "1.0.0",
        digest: "xyz",
        mode: "offline",
        target: "agents",
        scope: "project",
        dest: skillPath,
        installedAt: new Date().toISOString(),
      });
      await writeLockfile(lockfile, lock);

      let logged = "";
      const origLog = console.log;
      console.log = (msg: string) => {
        logged += msg + "\n";
      };

      try {
        await syncCommand({ project: true });
      } finally {
        console.log = origLog;
      }

      expect(logged).toContain("AgentShareFlow Sync Status Report");
      expect(logged).toContain("[SYNCED]");
      expect(logged).toContain("test/my-skill@1.0.0");
    } finally {
      process.chdir(origCwd);
    }
  });
});
