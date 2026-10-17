import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executeInSandbox } from "../src/runtime.js";

describe("Runtime Sandbox", () => {
  const tempDirs: string[] = [];

  async function temporaryDirectory(prefix: string): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it("executes a node script in sandbox with input JSON and parsed output", async () => {
    const dir = await temporaryDirectory("runtime-test-node-");
    const script = `
      let inputData = "";
      process.stdin.on("data", (chunk) => { inputData += chunk; });
      process.stdin.on("end", () => {
        const input = JSON.parse(inputData || "{}");
        const result = { answer: (input.a || 0) + (input.b || 0), echo: input.msg };
        console.log("Processed input successfully");
        console.log(JSON.stringify(result));
      });
    `;
    await fs.writeFile(path.join(dir, "index.js"), script, "utf8");

    const res = await executeInSandbox({
      packDir: dir,
      input: { a: 10, b: 32, msg: "sandbox test" },
      timeoutMs: 3000,
    });

    expect(res.ok).toBe(true);
    expect(res.sandboxed).toBe(true);
    expect(res.exitCode).toBe(0);
    expect(res.output).toEqual({ answer: 42, echo: "sandbox test" });
    expect(res.logs.some((l) => l.includes("Processed input successfully"))).toBe(true);
    expect(res.executionTimeMs).toBeGreaterThanOrEqual(0);
  });

  it("terminates when execution exceeds timeout", async () => {
    const dir = await temporaryDirectory("runtime-timeout-");
    const script = `
      // Infinite loop
      setInterval(() => {}, 1000);
    `;
    await fs.writeFile(path.join(dir, "index.js"), script, "utf8");

    const res = await executeInSandbox({
      packDir: dir,
      timeoutMs: 500, // short timeout
    });

    expect(res.ok).toBe(false);
    expect(res.error).toContain("timed out");
    expect(res.logs.some((l) => l.includes("Sandbox Watchdog"))).toBe(true);
  });

  it("simulates execution for prompt/SKILL.md offline packs", async () => {
    const dir = await temporaryDirectory("runtime-skill-");
    const skillContent = `
# Code Reviewer Pro
This skill reviews code and looks for security flaws.

## Instructions
1. Check for SQL injection.
2. Check for memory leaks.
    `;
    await fs.writeFile(path.join(dir, "SKILL.md"), skillContent, "utf8");
    await fs.writeFile(
      path.join(dir, "agent.json"),
      JSON.stringify({
        spec: "agent-pack/v0",
        name: "code-reviewer-pro",
        version: "1.2.0",
        title: "Code Reviewer Pro",
        description: "Automated code reviewer",
        mode: "offline",
        skills: ["."],
      }),
      "utf8",
    );

    const res = await executeInSandbox({
      packDir: dir,
      input: { prompt: "Please review my login function" },
    });

    expect(res.ok).toBe(true);
    expect(res.sandboxed).toBe(true);
    expect(res.output).toMatchObject({
      simulated: true,
      skill: "Code Reviewer Pro",
      pack: "code-reviewer-pro",
      version: "1.2.0",
      status: "completed",
    });
    expect(res.logs.some((l) => l.includes("Initialized offline skill emulation sandbox"))).toBe(true);
  });

  it("returns clean error for missing pack directory", async () => {
    const res = await executeInSandbox({
      packDir: "/path/that/does/not/exist/ever/12345",
    });

    expect(res.ok).toBe(false);
    expect(res.error).toContain("Directory not found");
  });

  it("rejects entryScript path traversal and symlink escapes outside pack directory", async () => {
    const dir = await temporaryDirectory("runtime-escape-");
    const outsideDir = await temporaryDirectory("runtime-outside-");
    const outsideScript = path.join(outsideDir, "evil.js");
    await fs.writeFile(outsideScript, 'console.log(JSON.stringify({ pwned: true }));', "utf8");
    await fs.writeFile(path.join(dir, "index.js"), 'console.log(JSON.stringify({ ok: 1 }));', "utf8");

    const traversalRes = await executeInSandbox({
      packDir: dir,
      entryScript: "../" + path.basename(outsideDir) + "/evil.js",
    });
    expect(traversalRes.ok).toBe(false);
    expect(traversalRes.error).toMatch(/escapes pack directory/i);

    const symlinkPath = path.join(dir, "linked.js");
    await fs.symlink(outsideScript, symlinkPath);
    const symlinkRes = await executeInSandbox({
      packDir: dir,
      entryScript: "linked.js",
    });
    expect(symlinkRes.ok).toBe(false);
    expect(symlinkRes.error).toMatch(/symlink escapes pack directory/i);
  });

  it("simulates execution for multi-skill packs without a root SKILL.md", async () => {
    const dir = await temporaryDirectory("runtime-multiskill-");
    await fs.mkdir(path.join(dir, "skills", "changelog"), { recursive: true });
    await fs.mkdir(path.join(dir, "skills", "pr-description"), { recursive: true });
    await fs.writeFile(
      path.join(dir, "skills", "changelog", "SKILL.md"),
      "# Changelog\nDraft the next release section.\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(dir, "skills", "pr-description", "SKILL.md"),
      "# PR Description\nWrite a pull request description.\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(dir, "agent.json"),
      JSON.stringify({
        spec: "agent-pack/v0",
        name: "release-helper",
        version: "0.1.0",
        title: "Release Helper",
        description: "Two-skill pack for shipping",
        mode: "offline",
        skills: ["skills/changelog", "skills/pr-description"],
      }),
      "utf8",
    );

    const res = await executeInSandbox({
      packDir: dir,
      input: "Please execute the Release Helper skill for a project security audit.",
    });

    expect(res.ok).toBe(true);
    expect(res.sandboxed).toBe(true);
    expect(res.output).toMatchObject({
      simulated: true,
      skill: "Release Helper",
      pack: "release-helper",
      version: "0.1.0",
      status: "completed",
    });
    expect(res.logs.some((l) => l.includes("skills/changelog/SKILL.md"))).toBe(true);
    expect(res.logs.some((l) => l.includes("skills/pr-description/SKILL.md"))).toBe(true);
  });
});
