import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPackTarball,
  generateSigningKeyPair,
  readPack,
} from "@agentshare/core";
import { initCommand, publishCommand } from "../src/commands.js";

const tempDirs: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("agentshare init", () => {
  it("initializes a valid agent pack with defaults in non-interactive mode", async () => {
    const dir = await temporaryDirectory("agentshare-init-test-");
    await initCommand(dir, { yes: true });

    const pack = await readPack(dir);
    expect(pack.manifest.spec).toBe("agent-pack/v0");
    expect(pack.manifest.version).toBe("0.1.0");
    expect(pack.manifest.mode).toBe("offline");
    expect(pack.manifest.skills).toEqual(["."]);
    expect(pack.manifest.compatibility).toEqual(["agents", "claude", "codex"]);

    const skillContent = await fs.readFile(path.join(dir, "SKILL.md"), "utf8");
    expect(skillContent).toContain("## When to Use");
    expect(skillContent).toContain("## Capabilities");
  });

  it("initializes an agent pack with custom options, MCP, and declarative secrets", async () => {
    const dir = await temporaryDirectory("agentshare-init-custom-");
    await initCommand(dir, {
      yes: true,
      name: "data-analyzer",
      version: "1.2.0",
      title: "Data Analyzer Agent",
      description: "Extracts insights from large CSV datasets.",
      mode: "offline",
      targets: "claude,codex",
      mcp: true,
      mcpConfig: "mcp.json",
      secrets: "DATABASE_URL,OPENAI_API_KEY",
      tags: "data,analysis,sql",
    });

    const pack = await readPack(dir);
    expect(pack.manifest.name).toBe("data-analyzer");
    expect(pack.manifest.version).toBe("1.2.0");
    expect(pack.manifest.title).toBe("Data Analyzer Agent");
    expect(pack.manifest.compatibility).toEqual(["claude", "codex"]);
    expect(pack.manifest.mcp?.config).toBe("mcp.json");
    expect(pack.manifest.secrets).toEqual(["DATABASE_URL", "OPENAI_API_KEY"]);
    expect(pack.manifest.tags).toEqual(["data", "analysis", "sql"]);

    // Verify mcp.json was created
    const mcpRaw = await fs.readFile(path.join(dir, "mcp.json"), "utf8");
    const mcpConfig = JSON.parse(mcpRaw) as { mcpServers: Record<string, unknown> };
    expect(mcpConfig.mcpServers).toHaveProperty("sample");
  });
});

describe("agentshare publish", () => {
  it("executes static scan, packaging, and dry-run preview successfully", async () => {
    const dir = await temporaryDirectory("agentshare-publish-test-");
    await initCommand(dir, {
      yes: true,
      name: "verified-pack",
      version: "0.5.0",
      title: "Verified Pack",
    });

    // Run publish in dry-run mode
    await expect(
      publishCommand(dir, {
        dryRun: true,
        yes: true,
      }),
    ).resolves.not.toThrow();
  });

  it("verifies Ed25519 signature locally during publish preview", async () => {
    const dir = await temporaryDirectory("agentshare-sign-publish-");
    await initCommand(dir, {
      yes: true,
      name: "signed-pack",
      version: "1.0.0",
      title: "Signed Pack",
    });

    const keyFile = path.join(dir, "key.json");
    const keys = generateSigningKeyPair();
    await fs.writeFile(keyFile, JSON.stringify(keys, null, 2));

    await expect(
      publishCommand(dir, {
        dryRun: true,
        yes: true,
        sign: true,
        key: keyFile,
      }),
    ).resolves.not.toThrow();
  });
});
