import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { policyCheckCommand, publishCommand } from "../src/commands.js";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentshare-cli-policy-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe("cli policy check and publish integration", () => {
  it("passes compliant pack when policy rules are met", async () => {
    const cwd = await createTempDir();
    const manifest = {
      spec: "agent-pack/v0",
      name: "compliant-pack",
      version: "1.0.0",
      title: "Compliant Pack",
      description: "Tested under enterprise policy",
      mode: "offline",
      license: "Apache-2.0",
      compatibility: ["agents", "claude"],
      skills: ["."],
      instructions: [],
      secrets: ["GITHUB_TOKEN"],
      metadata: {},
    };
    await fs.writeFile(path.join(cwd, "agent.json"), JSON.stringify(manifest, null, 2), "utf8");
    await fs.writeFile(path.join(cwd, "SKILL.md"), "# Compliant Skill\n", "utf8");

    const policy = {
      name: "strict-corp-policy",
      version: "1.0.0",
      rules: [
        {
          id: "approved-license",
          description: "Must use Apache-2.0 or MIT",
          level: "error",
          condition: {
            field: "manifest.license",
            operator: "in",
            values: ["Apache-2.0", "MIT"],
          },
        },
      ],
    };
    const policyFile = path.join(cwd, "policy.json");
    await fs.writeFile(policyFile, JSON.stringify(policy, null, 2), "utf8");

    let logged = "";
    const origLog = console.log;
    console.log = (msg: string) => {
      logged += msg + "\n";
    };

    try {
      await policyCheckCommand(cwd, { policy: policyFile });
    } finally {
      console.log = origLog;
    }

    expect(logged).toContain("Status: ✓ PASSED");
  });

  it("blocks publish when policy rule is violated", async () => {
    const cwd = await createTempDir();
    const manifest = {
      spec: "agent-pack/v0",
      name: "violating-pack",
      version: "1.0.0",
      title: "Violating Pack",
      description: "Uses unapproved license",
      mode: "offline",
      license: "GPL-3.0",
      compatibility: ["agents"],
      skills: ["."],
      instructions: [],
      secrets: [],
      metadata: {},
    };
    await fs.writeFile(path.join(cwd, "agent.json"), JSON.stringify(manifest, null, 2), "utf8");
    await fs.writeFile(path.join(cwd, "SKILL.md"), "# Skill\n", "utf8");

    const policy = {
      name: "strict-corp-policy",
      version: "1.0.0",
      rules: [
        {
          id: "approved-license",
          description: "Must use Apache-2.0 or MIT",
          level: "error",
          condition: {
            field: "manifest.license",
            operator: "in",
            values: ["Apache-2.0", "MIT"],
          },
        },
      ],
    };
    const policyFile = path.join(cwd, "policy.json");
    await fs.writeFile(policyFile, JSON.stringify(policy, null, 2), "utf8");

    await expect(
      publishCommand(cwd, {
        policy: policyFile,
        dryRun: true,
        yes: true,
      }),
    ).rejects.toThrow("publish blocked by enterprise policy");
  });
});
