import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  HARNESS_TARGETS,
  createPackTarball,
  expandHome,
  extractPackTarball,
  parseManifest,
  readPack,
  resolveSkillsDir,
} from "../src/index.js";

const offlineManifest = {
  spec: "agent-pack/v0",
  name: "hello-handoff",
  version: "0.1.0",
  title: "Hello Handoff",
  description: "Minimal handoff pack for tests.",
  mode: "offline",
};

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentshare-core-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("parseManifest", () => {
  it("applies defaults", () => {
    const manifest = parseManifest(offlineManifest);
    expect(manifest.tags).toEqual([]);
    expect(manifest.skills).toEqual([]);
    expect(manifest.secrets).toEqual([]);
    expect(manifest.compatibility).toEqual(["agents"]);
    expect(manifest.metadata).toEqual({});
  });

  it("rejects invalid names and versions", () => {
    expect(() => parseManifest({ ...offlineManifest, name: "Bad Name" })).toThrow();
    expect(() => parseManifest({ ...offlineManifest, version: "1.0" })).toThrow();
    expect(() => parseManifest({ ...offlineManifest, spec: "agent-pack/v1" })).toThrow();
  });

  it("requires endpoint for endpoint mode and runtime for runtime mode", () => {
    expect(() => parseManifest({ ...offlineManifest, mode: "endpoint" })).toThrow(/endpoint/);
    expect(() => parseManifest({ ...offlineManifest, mode: "runtime" })).toThrow(/runtime/);
  });

  it("rejects endpoint/runtime on offline mode", () => {
    expect(() =>
      parseManifest({
        ...offlineManifest,
        endpoint: { type: "mcp", url: "https://example.com/mcp" },
      }),
    ).toThrow(/offline/);
  });

  it("requires exactly one of image or dockerfile for runtime", () => {
    expect(() =>
      parseManifest({ ...offlineManifest, mode: "runtime", runtime: { port: 8080 } }),
    ).toThrow();
    expect(() =>
      parseManifest({
        ...offlineManifest,
        mode: "runtime",
        runtime: { image: "ghcr.io/example/agent:1", dockerfile: "Dockerfile" },
      }),
    ).toThrow();
    const manifest = parseManifest({
      ...offlineManifest,
      mode: "runtime",
      runtime: { dockerfile: "Dockerfile" },
    });
    expect(manifest.runtime?.protocol).toBe("mcp");
  });

  it("rejects plaintext-looking secret values with bad names", () => {
    expect(() => parseManifest({ ...offlineManifest, secrets: ["github_token"] })).toThrow();
  });
});

describe("readPack", () => {
  it("reads and validates a pack directory", async () => {
    await fs.writeFile(path.join(tmpDir, "agent.json"), JSON.stringify(offlineManifest));
    await fs.writeFile(path.join(tmpDir, "SKILL.md"), "# skill");
    const pack = await readPack(tmpDir);
    expect(pack.manifest.name).toBe("hello-handoff");
  });

  it("fails on missing manifest and missing referenced paths", async () => {
    await expect(readPack(tmpDir)).rejects.toThrow(/missing agent.json/);
    await fs.writeFile(
      path.join(tmpDir, "agent.json"),
      JSON.stringify({ ...offlineManifest, skills: ["nope"] }),
    );
    await expect(readPack(tmpDir)).rejects.toThrow(/missing path: nope/);
  });
});

describe("tarball roundtrip", () => {
  it("packs and extracts, excluding node_modules", async () => {
    await fs.writeFile(path.join(tmpDir, "agent.json"), JSON.stringify(offlineManifest));
    await fs.writeFile(path.join(tmpDir, "SKILL.md"), "# skill");
    await fs.mkdir(path.join(tmpDir, "node_modules", "junk"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "node_modules", "junk", "index.js"), "junk");

    const tarball = path.join(tmpDir, "pack.tgz");
    const result = await createPackTarball(tmpDir, tarball);
    expect(result.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(result.size).toBeGreaterThan(0);

    const dest = path.join(tmpDir, "extracted");
    await extractPackTarball(tarball, dest);
    await expect(fs.access(path.join(dest, "SKILL.md"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(dest, "node_modules"))).rejects.toThrow();
  });
});

describe("harness targets", () => {
  it("expands home paths", () => {
    expect(expandHome("~/x")).toBe(path.join(os.homedir(), "x"));
  });

  it("resolves user and project dirs", () => {
    expect(resolveSkillsDir("claude")).toBe(path.join(os.homedir(), ".claude", "skills"));
    expect(resolveSkillsDir("hermes", { project: true, cwd: "/tmp/proj" })).toBe(
      path.resolve("/tmp/proj", HARNESS_TARGETS.hermes.project),
    );
    expect(resolveSkillsDir("opencode")).toBe(
      path.join(os.homedir(), ".config", "opencode", "skills"),
    );
  });
});
