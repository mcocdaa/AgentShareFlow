import { Hono } from "hono";
import {
  type FederationManifest,
  type FederatedSearchResultItem,
  fetchFederationManifest,
  queryFederatedPeers,
} from "@agentshare/core";
import type { RegistryDb } from "./db.js";
import { resolveOwner } from "./identity.js";
import type { OidcConfig } from "./oidc.js";

export interface FederationRoutesOptions {
  db: RegistryDb;
  publicUrl?: string;
  oidc?: OidcConfig;
  fetchImpl?: typeof fetch;
}

export function federationRoutes({
  db,
  publicUrl = "http://localhost:8787",
  oidc,
  fetchImpl = fetch,
}: FederationRoutesOptions): Hono {
  const app = new Hono();

  // 1. Standard A2A/Federation discovery well-known endpoint
  app.get("/.well-known/agent-federation.json", (c) => {
    const manifest: FederationManifest = {
      spec: "agent-federation/v0",
      name: "agentshare-registry",
      version: "0.1.0",
      url: publicUrl.replace(/\/+$/, ""),
      capabilities: ["search", "download", "a2a", "policy"],
      peerCount: db.listPeers().length,
    };
    return c.json(manifest);
  });

  // 2. List connected peer registries
  app.get("/api/v1/federation/peers", (c) => {
    const peers = db.listPeers();
    return c.json({ peers });
  });

  // 3. Register a new peer registry
  app.post("/api/v1/federation/peers", async (c) => {
    const who = await resolveOwner(c, oidc);
    if (!who) {
      return c.json({ error: "unauthorized: authentication required to register federation peer" }, 401);
    }

    let body: { name?: string; url?: string } = {};
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json body" }, 400);
    }

    if (!body.url || typeof body.url !== "string") {
      return c.json({ error: "url is required" }, 400);
    }

    try {
      new URL(body.url);
    } catch {
      return c.json({ error: "invalid peer url" }, 400);
    }

    const peerName = body.name?.trim() || new URL(body.url).hostname;

    // Optional verification of the remote peer's well-known manifest
    let status: "active" | "unreachable" = "active";
    try {
      await fetchFederationManifest(body.url, fetchImpl, 2500);
    } catch {
      // Remote peer may still be accepted in pending/active state
    }

    const peer = db.addPeer({
      name: peerName,
      url: body.url,
      status,
    });

    return c.json({ ok: true, peer }, 201);
  });

  // 4. Deregister a peer registry
  app.delete("/api/v1/federation/peers/:id", async (c) => {
    const who = await resolveOwner(c, oidc);
    if (!who) {
      return c.json({ error: "unauthorized" }, 401);
    }

    const { id } = c.req.param();
    const removed = db.removePeer(id);
    if (!removed) {
      return c.json({ error: "peer not found" }, 404);
    }
    return c.json({ ok: true, removed: true });
  });

  // 5. Federated Search across local DB + all active peer registries
  app.get("/api/v1/federation/search", async (c) => {
    const q = c.req.query("q") ?? "";
    const mode = c.req.query("mode");
    const who = await resolveOwner(c, oidc);

    // Query local database
    const localRows = db.search(q, mode);
    const localItems: FederatedSearchResultItem[] = [];

    for (const row of localRows) {
      if (!db.canUserReadPack(who, row.owner, row.visibility)) continue;
      const stars = db.countStars(row.owner, row.name);
      localItems.push({
        owner: row.owner,
        name: row.name,
        version: row.version,
        title: row.title,
        description: row.description,
        mode: row.mode,
        tags: JSON.parse(row.tags) as string[],
        downloads: row.downloads,
        stars,
        origin: "local",
      });
    }

    // Query active federation peers
    const peers = db.listPeers().map((p) => ({
      id: p.id,
      name: p.name,
      url: p.url,
      status: p.status,
      createdAt: p.created_at,
      lastSyncedAt: p.last_synced_at,
    }));
    const remoteItems = await queryFederatedPeers(peers, q, fetchImpl, 2500);

    // Combine and sort by stars desc, then downloads desc
    const combined = [...localItems, ...remoteItems].sort((a, b) => {
      if (b.stars !== a.stars) return b.stars - a.stars;
      return b.downloads - a.downloads;
    });

    return c.json({
      query: q,
      total: combined.length,
      localCount: localItems.length,
      federatedCount: remoteItems.length,
      items: combined,
    });
  });

  // 6. Transparent Federated Proxy Download
  app.get("/api/v1/federation/download/:peerId/:owner/:name/:version", async (c) => {
    const { peerId, owner, name, version } = c.req.param();
    const peer = db.getPeer(peerId);
    if (!peer) {
      return c.json({ error: "peer registry not found" }, 404);
    }

    const base = peer.url.endsWith("/") ? peer.url : `${peer.url}/`;
    const remoteDownloadUrl = new URL(
      `api/v1/agents/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${encodeURIComponent(version)}/download`,
      base,
    ).toString();

    try {
      const res = await fetchImpl(remoteDownloadUrl);
      if (!res.ok) {
        return c.json({ error: `remote peer returned HTTP ${res.status}` }, res.status as any);
      }

      const bytes = new Uint8Array(await res.arrayBuffer());
      return new Response(Buffer.from(bytes), {
        headers: {
          "content-type": "application/gzip",
          "content-disposition": `attachment; filename="${name}-${version}.tgz"`,
          "x-federation-peer": peer.name,
        },
      });
    } catch (err) {
      return c.json({ error: `failed to proxy download from peer: ${String(err)}` }, 502);
    }
  });

  return app;
}
