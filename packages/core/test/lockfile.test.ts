import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LOCKFILE_SPEC,
  emptyLockfile,
  parseLockfile,
  readLockfile,
  upsertInstall,
  writeLockfile,
} from "../src/index.js";

const tempDirs: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentshare-lock-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("lockfile", () => {
  it("reads a missing file as an empty lockfile", async () => {
    const dir = await temporaryDirectory();
    const lock = await readLockfile(path.join(dir, "missing.json"));
    expect(lock).toEqual({ spec: LOCKFILE_SPEC, installs: [] });
    expect(emptyLockfile()).toEqual(lock);
  });

  it("round-trips through disk and applies defaults", async () => {
    const dir = await temporaryDirectory();
    const file = path.join(dir, "agentshare.lock.json");
    const lock = upsertInstall(emptyLockfile(), {
      owner: "o",
      name: "n",
      version: "1.0.0",
      digest: "abc",
      mode: "offline",
      target: "agents",
      scope: "project",
      dest: "/tmp/x/n",
      registry: "http://relay.test",
      installedAt: "2026-09-18T00:00:00.000Z",
    });
    await writeLockfile(file, lock);
    expect(await readLockfile(file)).toEqual(lock);
    expect(parseLockfile({ spec: LOCKFILE_SPEC }).installs).toEqual([]);
  });

  it("upserts by owner, name, and destination", () => {
    const base = upsertInstall(emptyLockfile(), {
      owner: "o",
      name: "n",
      version: "1.0.0",
      digest: "a",
      mode: "offline",
      target: "agents",
      scope: "user",
      dest: "/u/n",
      installedAt: "t1",
    });
    const next = upsertInstall(base, {
      owner: "o",
      name: "n",
      version: "2.0.0",
      digest: "b",
      mode: "offline",
      target: "agents",
      scope: "user",
      dest: "/u/n",
      installedAt: "t2",
    });
    expect(next.installs).toHaveLength(1);
    expect(next.installs[0]?.version).toBe("2.0.0");
    const otherDest = upsertInstall(next, {
      owner: "o",
      name: "n",
      version: "1.0.0",
      digest: "a",
      mode: "offline",
      target: "codex",
      scope: "user",
      dest: "/c/n",
      installedAt: "t3",
    });
    expect(otherDest.installs).toHaveLength(2);
  });

  it("rejects malformed lockfiles", () => {
    expect(() => parseLockfile({ spec: "agentshare-lock/v9" })).toThrow();
    expect(() =>
      parseLockfile({
        spec: LOCKFILE_SPEC,
        installs: [{ owner: "o", name: "n" }],
      }),
    ).toThrow();
  });
});
