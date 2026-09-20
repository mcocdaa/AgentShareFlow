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
});
