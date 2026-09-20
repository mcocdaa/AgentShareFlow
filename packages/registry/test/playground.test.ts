import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import {
  createPackTarball,
  generateSigningKeyPair,
  signDigest,
  encodePublicKeyHeader,
} from "@agentshare/core";
import { createHash } from "node:crypto";

describe("Registry Playground Sandbox Endpoint", () => {
  const tempDirs: string[] = [];

  async function temporaryDirectory(prefix: string): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it("executes an agent pack within the isolated sandbox via POST /playground", async () => {
    const dataDir = await temporaryDirectory("agentshare-reg-play-");
    const packDir = await temporaryDirectory("agentshare-play-pack-");

    const app = createApp({ dataDir });

    const keyPair = generateSigningKeyPair();
    const manifest = {
      spec: "agent-pack/v0",
      name: "runtime-calc",
      version: "1.0.0",
      title: "Runtime Calculator",
      description: "Calculates in sandbox",
      mode: "runtime",
      runtime: {
        image: "node:alpine",
        port: 8080,
        protocol: "mcp",
      },
      skills: ["."],
    };

    const indexCode = `
      let inputData = "";
      process.stdin.on("data", (c) => { inputData += c; });
      process.stdin.on("end", () => {
        const input = JSON.parse(inputData || "{}");
        const res = { sum: (input.x || 0) + (input.y || 0) };
        console.log("Calculated sum in sandbox");
        console.log(JSON.stringify(res));
      });
    `;

    await fs.writeFile(path.join(packDir, "agent.json"), JSON.stringify(manifest));
    await fs.writeFile(path.join(packDir, "index.js"), indexCode);
    const tarballPath = path.join(packDir, "pack.tgz");
    await createPackTarball(packDir, tarballPath);
    const tarball = await fs.readFile(tarballPath);
    const digest = createHash("sha256").update(tarball).digest("hex");
    const signature = signDigest(keyPair.privateKey, digest);

    const form = new FormData();
    form.set("manifest", JSON.stringify(manifest));
    form.set("tarball", new Blob([tarball], { type: "application/gzip" }), "pack.tgz");

    const pubRes = await app.request("/api/v1/agents", {
      method: "POST",
      headers: {
        authorization: "Bearer test-dev-token",
        "x-pack-digest": digest,
        "x-pack-signature": signature,
        "x-pack-public-key": encodePublicKeyHeader(keyPair.publicKey),
      },
      body: form,
    });
    expect(pubRes.status).toBe(201);

    // Call playground endpoint
    const playRes = await app.request("/api/v1/agents/dev/runtime-calc/1.0.0/playground", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        input: { x: 15, y: 27 },
        timeoutMs: 3000,
      }),
    });

    expect(playRes.status).toBe(200);
    const playBody = (await playRes.json()) as {
      ok: boolean;
      output: { sum: number };
      logs: string[];
      sandboxed: boolean;
      executionTimeMs: number;
    };

    expect(playBody.ok).toBe(true);
    expect(playBody.sandboxed).toBe(true);
    expect(playBody.output).toEqual({ sum: 42 });
    expect(playBody.logs.some((l) => l.includes("Calculated sum in sandbox"))).toBe(true);
  });

  it("returns 404 for nonexistent pack or version", async () => {
    const dataDir = await temporaryDirectory("agentshare-reg-play-404-");
    const app = createApp({ dataDir });

    const res = await app.request("/api/v1/agents/dev/nonexistent/1.0.0/playground", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "test" }),
    });

    expect(res.status).toBe(404);
  });
});
