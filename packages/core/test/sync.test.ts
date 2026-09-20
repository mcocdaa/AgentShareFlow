import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkSyncStatus,
  emptyLockfile,
  formatSyncReport,
  upsertInstall,
} from "../src/index.js";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentshare-sync-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe("sync", () => {
  it("detects synced, missing, and drifted installations correctly", async () => {
    const workspace = await createTempDir();

    // 1. Synced installation
    const syncedDest = path.join(workspace, "skills", "synced-skill");
    await fs.mkdir(syncedDest, { recursive: true });
    await fs.writeFile(path.join(syncedDest, "SKILL.md"), "# Synced", "utf8");

    // 2. Drifted installation (missing SKILL.md)
    const driftedDest = path.join(workspace, "skills", "drifted-skill");
    await fs.mkdir(driftedDest, { recursive: true });
    await fs.writeFile(path.join(driftedDest, "random.txt"), "hello", "utf8");

    // 3. Missing installation (path does not exist)
    const missingDest = path.join(workspace, "skills", "missing-skill");

    let lock = emptyLockfile();
    lock = upsertInstall(lock, {
      owner: "alice",
      name: "synced-skill",
      version: "1.0.0",
      digest: "abc",
      mode: "offline",
      target: "agents",
      scope: "project",
      dest: syncedDest,
      installedAt: new Date().toISOString(),
    });

    lock = upsertInstall(lock, {
      owner: "bob",
      name: "drifted-skill",
      version: "1.0.0",
      digest: "def",
      mode: "offline",
      target: "claude",
      scope: "project",
      dest: driftedDest,
      installedAt: new Date().toISOString(),
    });

    lock = upsertInstall(lock, {
      owner: "carol",
      name: "missing-skill",
      version: "1.0.0",
      digest: "ghi",
      mode: "offline",
      target: "codex",
      scope: "project",
      dest: missingDest,
      installedAt: new Date().toISOString(),
    });

    const report = await checkSyncStatus(lock);
    expect(report.total).toBe(3);
    expect(report.synced).toBe(1);
    expect(report.drifted).toBe(1);
    expect(report.missing).toBe(1);

    const formatted = formatSyncReport(report);
    expect(formatted).toContain("[SYNCED]");
    expect(formatted).toContain("[DRIFTED]");
    expect(formatted).toContain("[MISSING]");
    expect(formatted).toContain("alice/synced-skill");
    expect(formatted).toContain("bob/drifted-skill");
    expect(formatted).toContain("carol/missing-skill");
  });
});
