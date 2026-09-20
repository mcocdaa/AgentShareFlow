import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import {
  createPackTarball,
  generateSigningKeyPair,
  signDigest,
  encodePublicKeyHeader,
} from "@agentshare/core";
import { createHash } from "node:crypto";

describe("Registry Cross-Cluster Federation", () => {
  const tempDirs: string[] = [];
  let peerHttpServer: http.Server;
  let peerPort: number;

  async function temporaryDirectory(prefix: string): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  beforeEach(async () => {
    // Setup a mock remote peer registry HTTP server
    peerHttpServer = http.createServer((req, res) => {
      const url = req.url ?? "/";
      if (url === "/.well-known/agent-federation.json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            spec: "agent-federation/v0",
            name: "remote-peer-node",
            version: "0.1.0",
            url: `http://127.0.0.1:${peerPort}`,
            capabilities: ["search", "download"],
            peerCount: 1,
          }),
        );
      } else if (url.startsWith("/api/v1/search")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            items: [
              {
                owner: "remoteowner",
                name: "remote-helper-pack",
                version: "2.0.0",
                title: "Remote Helper Pack",
                description: "Pack located in remote federation cluster",
                mode: "offline",
                tags: ["remote", "helper"],
                downloads: 888,
                stars: 45,
              },
            ],
          }),
        );
      } else if (url.includes("/download")) {
        const dummyTarball = Buffer.from("dummy-remote-tarball-content");
        res.writeHead(200, {
          "content-type": "application/gzip",
          "content-disposition": 'attachment; filename="remote-helper-pack-2.0.0.tgz"',
        });
        res.end(dummyTarball);
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => {
      peerHttpServer.listen(0, "127.0.0.1", () => {
        const addr = peerHttpServer.address();
        if (typeof addr === "object" && addr) {
          peerPort = addr.port;
        }
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => peerHttpServer.close(() => resolve()));
    await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it("serves well-known discovery manifest and manages peer lifecycle", async () => {
    const dataDir = await temporaryDirectory("agentshare-reg-fed-");
    const app = createApp({
      dataDir,
      publicUrl: "http://myregistry.internal:8787",
    });

    // 1. Well-known discovery
    const wellKnownRes = await app.request("/.well-known/agent-federation.json");
    expect(wellKnownRes.status).toBe(200);
    const manifest = (await wellKnownRes.json()) as {
      spec: string;
      name: string;
      url: string;
      capabilities: string[];
    };
    expect(manifest.spec).toBe("agent-federation/v0");
    expect(manifest.url).toBe("http://myregistry.internal:8787");
    expect(manifest.capabilities).toContain("search");

    // 2. Add peer
    const addRes = await app.request("/api/v1/federation/peers", {
      method: "POST",
      headers: {
        authorization: "Bearer test-dev-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "Partner Cluster",
        url: `http://127.0.0.1:${peerPort}`,
      }),
    });

    expect(addRes.status).toBe(201);
    const addBody = (await addRes.json()) as { ok: boolean; peer: { id: string; name: string; url: string } };
    expect(addBody.ok).toBe(true);
    expect(addBody.peer.name).toBe("Partner Cluster");
    const peerId = addBody.peer.id;

    // 3. List peers
    const listRes = await app.request("/api/v1/federation/peers");
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { peers: Array<{ id: string; name: string }> };
    expect(listBody.peers.some((p) => p.id === peerId)).toBe(true);

    // 4. Delete peer
    const delRes = await app.request(`/api/v1/federation/peers/${peerId}`, {
      method: "DELETE",
      headers: { authorization: "Bearer test-dev-token" },
    });
    expect(delRes.status).toBe(200);

    const listAfterDel = await app.request("/api/v1/federation/peers");
    const listAfterBody = (await listAfterDel.json()) as { peers: Array<{ id: string }> };
    expect(listAfterBody.peers.some((p) => p.id === peerId)).toBe(false);
  });

  it("performs federated search and proxies download from peer", async () => {
    const dataDir = await temporaryDirectory("agentshare-reg-fedsearch-");
    const localPackDir = await temporaryDirectory("agentshare-localpack-");
    const app = createApp({ dataDir });

    // Publish a local pack
    const keyPair = generateSigningKeyPair();
    const manifest = {
      spec: "agent-pack/v0",
      name: "local-search-pack",
      version: "1.0.0",
      title: "Local Search Pack",
      description: "Pack located directly in local registry",
      mode: "offline",
      skills: ["."],
    };
    await fs.writeFile(path.join(localPackDir, "agent.json"), JSON.stringify(manifest));
    await fs.writeFile(path.join(localPackDir, "SKILL.md"), "# Local Search\n");
    const tarballPath = path.join(localPackDir, "pack.tgz");
    await createPackTarball(localPackDir, tarballPath);
    const tarball = await fs.readFile(tarballPath);
    const digest = createHash("sha256").update(tarball).digest("hex");
    const signature = signDigest(keyPair.privateKey, digest);

    const form = new FormData();
    form.set("manifest", JSON.stringify(manifest));
    form.set("tarball", new Blob([tarball], { type: "application/gzip" }), "pack.tgz");

    await app.request("/api/v1/agents", {
      method: "POST",
      headers: {
        authorization: "Bearer test-dev-token",
        "x-pack-digest": digest,
        "x-pack-signature": signature,
        "x-pack-public-key": encodePublicKeyHeader(keyPair.publicKey),
      },
      body: form,
    });

    // Register remote peer
    const addPeerRes = await app.request("/api/v1/federation/peers", {
      method: "POST",
      headers: {
        authorization: "Bearer test-dev-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "Remote Hub",
        url: `http://127.0.0.1:${peerPort}`,
      }),
    });
    const { peer } = (await addPeerRes.json()) as { peer: { id: string } };

    // Query federated search
    const searchRes = await app.request("/api/v1/federation/search?q=pack");
    expect(searchRes.status).toBe(200);
    const searchBody = (await searchRes.json()) as {
      total: number;
      localCount: number;
      federatedCount: number;
      items: Array<{ name: string; origin: string; peer?: { id: string; name: string } }>;
    };

    expect(searchBody.total).toBeGreaterThanOrEqual(2);
    expect(searchBody.localCount).toBe(1);
    expect(searchBody.federatedCount).toBe(1);

    const localItem = searchBody.items.find((i) => i.name === "local-search-pack");
    expect(localItem?.origin).toBe("local");

    const remoteItem = searchBody.items.find((i) => i.name === "remote-helper-pack");
    expect(remoteItem?.origin).toBe("federated");
    expect(remoteItem?.peer?.name).toBe("Remote Hub");

    // Proxy download from remote peer
    const proxyDownloadRes = await app.request(
      `/api/v1/federation/download/${peer.id}/remoteowner/remote-helper-pack/2.0.0`,
    );
    expect(proxyDownloadRes.status).toBe(200);
    const downloadedText = await proxyDownloadRes.text();
    expect(downloadedText).toBe("dummy-remote-tarball-content");
  });
});
