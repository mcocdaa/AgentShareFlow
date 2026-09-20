import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPackTarball } from "@agentshare/core";
import { runCommand } from "../src/commands.js";

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
  process.exitCode = undefined;
});

describe("agentshare run", () => {
  it("executes a local agent pack directory in sandbox and prints output", async () => {
    const dir = await temporaryDirectory("agentshare-run-cli-");
    const script = `
      let buf = "";
      process.stdin.on("data", (c) => { buf += c; });
      process.stdin.on("end", () => {
        const inp = JSON.parse(buf || "{}");
        console.log("Calculated answer:");
        console.log(JSON.stringify({ result: (inp.x || 0) * 2 }));
      });
    `;
    await fs.writeFile(path.join(dir, "index.js"), script);
    await fs.writeFile(
      path.join(dir, "agent.json"),
      JSON.stringify({
        spec: "agent-pack/v0",
        name: "doubler",
        version: "0.1.0",
        title: "Doubler Agent",
        description: "Multiplies by 2",
        mode: "runtime",
        skills: ["."],
      }),
    );

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      await runCommand(dir, {
        input: JSON.stringify({ x: 21 }),
        timeout: "3000",
      });

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("Agent Pack Sandbox Execution"),
      );
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("SUCCESS"),
      );
      expect(process.exitCode).toBeFalsy();
    } finally {
      logSpy.mockRestore();
    }
  });

  it("executes a local tarball (.tgz) file directly", async () => {
    const dir = await temporaryDirectory("agentshare-run-tar-src-");
    const outDir = await temporaryDirectory("agentshare-run-tar-out-");
    const script = `
      console.log(JSON.stringify({ greeting: "hello from tarball" }));
    `;
    await fs.writeFile(path.join(dir, "index.js"), script);
    await fs.writeFile(
      path.join(dir, "agent.json"),
      JSON.stringify({
        spec: "agent-pack/v0",
        name: "tar-runner",
        version: "1.0.0",
        title: "Tar Runner",
        description: "Runs from tar",
        mode: "offline",
        skills: ["."],
      }),
    );

    const tarballPath = path.join(outDir, "pack.tgz");
    await createPackTarball(dir, tarballPath);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runCommand(tarballPath, { json: true });

      const jsonCall = logSpy.mock.calls.find((call) => {
        try {
          const parsed = JSON.parse(call[0] as string);
          return parsed.ok === true && parsed.output?.greeting === "hello from tarball";
        } catch {
          return false;
        }
      });
      expect(jsonCall).toBeDefined();
    } finally {
      logSpy.mockRestore();
    }
  });
});
