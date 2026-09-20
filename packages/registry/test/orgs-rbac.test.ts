import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createPackTarball } from "@agentshare/core";

const tempDirs: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function buildTestPack(name: string, version: string) {
  const packDir = await temporaryDirectory("agentshare-pack-");
  const manifest = {
    spec: "agent-pack/v0",
    name,
    version,
    title: "RBAC Test Pack",
    description: "Testing orgs and permissions",
    mode: "offline",
    skills: ["."],
  };
  await fs.writeFile(path.join(packDir, "agent.json"), JSON.stringify(manifest), "utf8");
  await fs.writeFile(path.join(packDir, "SKILL.md"), "# Test Skill\n", "utf8");
  const tarball = path.join(packDir, "pack.tgz");
  await createPackTarball(packDir, tarball);
  const bytes = await fs.readFile(tarball);
  return { manifest, bytes };
}

describe("organizations and enterprise RBAC", () => {
  it("creates org, manages members, and enforces private pack visibility", async () => {
    const dataDir = await temporaryDirectory("agentshare-data-");
    process.env.AGENTSHARE_TOKENS = "tok_alice:alice,tok_bob:bob,tok_charlie:charlie";

    try {
      const app = createApp({ dataDir });
      const authAlice = { authorization: "Bearer tok_alice" };
      const authBob = { authorization: "Bearer tok_bob" };
      const authCharlie = { authorization: "Bearer tok_charlie" };

      // 1. Alice creates org "acme-corp"
      const createRes = await app.request("/api/v1/orgs", {
        method: "POST",
        headers: { ...authAlice, "content-type": "application/json" },
        body: JSON.stringify({
          name: "acme-corp",
          displayName: "Acme Corporation",
          description: "Enterprise workspace",
        }),
      });
      expect(createRes.status).toBe(201);
      const createBody = (await createRes.json()) as { org: { name: string }; role: string };
      expect(createBody.org.name).toBe("acme-corp");
      expect(createBody.role).toBe("owner");

      // 2. Alice adds Bob as "member"
      const addBobRes = await app.request("/api/v1/orgs/acme-corp/members", {
        method: "POST",
        headers: { ...authAlice, "content-type": "application/json" },
        body: JSON.stringify({
          memberIdentity: "bob",
          role: "member",
        }),
      });
      expect(addBobRes.status).toBe(200);

      // 3. Bob can see "acme-corp" in his orgs list
      const bobOrgsRes = await app.request("/api/v1/orgs", { headers: authBob });
      const bobOrgs = (await bobOrgsRes.json()) as { organizations: Array<{ org: { name: string } }> };
      expect(bobOrgs.organizations.some((o) => o.org.name === "acme-corp")).toBe(true);

      // 4. Bob publishes a private pack to "acme-corp" namespace
      const packed = await buildTestPack("internal-sec", "1.0.0");
      const form = new FormData();
      form.set("manifest", JSON.stringify(packed.manifest));
      form.set("tarball", new Blob([packed.bytes], { type: "application/gzip" }), "pack.tgz");

      const pubRes = await app.request("/api/v1/agents", {
        method: "POST",
        headers: {
          ...authBob,
          "x-pack-owner": "acme-corp",
          "x-pack-visibility": "private",
        },
        body: form,
      });
      expect(pubRes.status).toBe(201);

      // 5. Alice (org owner) and Bob (org member) can read and download private pack
      const aliceGet = await app.request("/api/v1/agents/acme-corp/internal-sec/1.0.0", {
        headers: authAlice,
      });
      expect(aliceGet.status).toBe(200);
      const aliceBody = (await aliceGet.json()) as { visibility: string };
      expect(aliceBody.visibility).toBe("private");

      const bobDownload = await app.request("/api/v1/agents/acme-corp/internal-sec/1.0.0/download", {
        headers: authBob,
      });
      expect(bobDownload.status).toBe(200);

      // 6. Charlie (outsider, not in acme-corp) cannot see or download private pack (404)
      const charlieGet = await app.request("/api/v1/agents/acme-corp/internal-sec/1.0.0", {
        headers: authCharlie,
      });
      expect(charlieGet.status).toBe(404);

      const charlieDownload = await app.request("/api/v1/agents/acme-corp/internal-sec/1.0.0/download", {
        headers: authCharlie,
      });
      expect(charlieDownload.status).toBe(404);

      // 7. Charlie cannot publish to acme-corp (403 forbidden)
      const charliePubForm = new FormData();
      charliePubForm.set("manifest", JSON.stringify(packed.manifest));
      charliePubForm.set("tarball", new Blob([packed.bytes], { type: "application/gzip" }), "pack.tgz");
      const charliePub = await app.request("/api/v1/agents", {
        method: "POST",
        headers: {
          ...authCharlie,
          "x-pack-owner": "acme-corp",
        },
        body: charliePubForm,
      });
      expect(charliePub.status).toBe(403);
    } finally {
      delete process.env.AGENTSHARE_TOKENS;
    }
  });
});
