import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { diffLines, diffPackDirs } from "../src/index.js";

const tempDirs: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentshare-diff-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("diffLines", () => {
  it("counts additions and deletions", () => {
    expect(diffLines(["a", "b"], ["a", "b", "c"])).toEqual({ additions: 1, deletions: 0 });
    expect(diffLines(["a", "b", "c"], ["a", "b"])).toEqual({ additions: 0, deletions: 1 });
    expect(diffLines(["a", "b"], ["a", "c"])).toEqual({ additions: 1, deletions: 1 });
    expect(diffLines(["same"], ["same"])).toEqual({ additions: 0, deletions: 0 });
  });
});

describe("diffPackDirs", () => {
  it("classifies added, removed, changed, and unchanged files", async () => {
    const from = await temporaryDirectory();
    const to = await temporaryDirectory();
    await fs.writeFile(path.join(from, "SKILL.md"), "line one\nline two\n");
    await fs.writeFile(path.join(to, "SKILL.md"), "line one\nline two changed\n");
    await fs.mkdir(path.join(to, "references"), { recursive: true });
    await fs.writeFile(path.join(to, "references/new.md"), "new\n");
    await fs.mkdir(path.join(from, "scripts"), { recursive: true });
    await fs.writeFile(path.join(from, "scripts/old.sh"), "old\n");
    await fs.writeFile(path.join(from, "AGENTS.md"), "same\n");
    await fs.writeFile(path.join(to, "AGENTS.md"), "same\n");
    await fs.writeFile(path.join(from, "logo.png"), Buffer.from([0, 1, 2]));
    await fs.writeFile(path.join(to, "logo.png"), Buffer.from([0, 1, 3]));

    const diff = await diffPackDirs(from, to);
    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(1);
    expect(diff.changed).toBe(2);
    const byPath = new Map(diff.files.map((file) => [file.path, file]));
    expect(byPath.get("SKILL.md")).toMatchObject({ status: "changed", additions: 1, deletions: 1 });
    expect(byPath.get("references/new.md")).toMatchObject({ status: "added" });
    expect(byPath.get("scripts/old.sh")).toMatchObject({ status: "removed" });
    expect(byPath.get("AGENTS.md")).toMatchObject({ status: "unchanged" });
    expect(byPath.get("logo.png")).toMatchObject({ status: "changed", binary: true });
  });

  it("treats a missing directory as all-added or all-removed", async () => {
    const from = await temporaryDirectory();
    await fs.writeFile(path.join(from, "SKILL.md"), "x\n");
    const missing = path.join(from, "does-not-exist");
    expect((await diffPackDirs(missing, from)).added).toBe(1);
    expect((await diffPackDirs(from, missing)).removed).toBe(1);
  });
});
