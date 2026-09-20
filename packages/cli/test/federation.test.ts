import { describe, expect, it, vi } from "vitest";
import {
  federationAddCommand,
  federationListCommand,
  federationRemoveCommand,
  searchCommand,
} from "../src/commands.js";

describe("CLI Federation Commands", () => {
  it("adds, lists, removes federation peers and performs federated search via client mocks", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    // Mock global fetch to respond to federation endpoints
    const originalFetch = globalThis.fetch;
    const peersDb = [
      {
        id: "peer-1",
        name: "Remote Cluster 1",
        url: "https://r1.example.com",
        status: "active",
        created_at: "2026-01-01T00:00:00Z",
        last_synced_at: null,
      },
    ];

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = String(input);

      if (urlStr.endsWith("/api/v1/federation/peers") && init?.method === "POST") {
        const body = JSON.parse(String(init.body || "{}"));
        const newPeer = {
          id: "peer-2",
          name: body.name ?? "r2",
          url: body.url,
          status: "active",
          created_at: new Date().toISOString(),
          last_synced_at: null,
        };
        peersDb.push(newPeer);
        return new Response(JSON.stringify({ ok: true, peer: newPeer }), { status: 201 });
      }

      if (urlStr.endsWith("/api/v1/federation/peers") && (!init?.method || init.method === "GET")) {
        return new Response(JSON.stringify({ peers: peersDb }), { status: 200 });
      }

      if (urlStr.includes("/api/v1/federation/peers/peer-2") && init?.method === "DELETE") {
        const idx = peersDb.findIndex((p) => p.id === "peer-2");
        if (idx >= 0) peersDb.splice(idx, 1);
        return new Response(JSON.stringify({ ok: true, removed: true }), { status: 200 });
      }

      if (urlStr.includes("/api/v1/federation/search")) {
        return new Response(
          JSON.stringify({
            query: "code",
            total: 2,
            localCount: 1,
            federatedCount: 1,
            items: [
              {
                owner: "localowner",
                name: "local-code-pack",
                version: "1.0.0",
                title: "Local Code Pack",
                description: "Pack in local cluster",
                mode: "offline",
                tags: ["code"],
                downloads: 100,
                stars: 12,
                origin: "local",
              },
              {
                owner: "remoteowner",
                name: "remote-code-pack",
                version: "2.0.0",
                title: "Remote Code Pack",
                description: "Pack in remote cluster",
                mode: "offline",
                tags: ["code"],
                downloads: 250,
                stars: 45,
                origin: "federated",
                peer: { id: "peer-1", name: "Remote Cluster 1", url: "https://r1.example.com" },
              },
            ],
          }),
          { status: 200 },
        );
      }

      return new Response("Not found", { status: 404 });
    };

    try {
      // 1. List
      await federationListCommand({ registry: "http://localhost:8787" });
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Connected Federation Peers"));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Remote Cluster 1"));

      // 2. Add
      await federationAddCommand("https://r2.example.com", {
        name: "Remote Cluster 2",
        registry: "http://localhost:8787",
      });
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Added federation peer Remote Cluster 2"));

      // 3. Remove
      await federationRemoveCommand("peer-2", { registry: "http://localhost:8787" });
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Deregistered federation peer: peer-2"));

      // 4. Federated Search
      await searchCommand("code", { registry: "http://localhost:8787", federated: true });
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Federated Search Results"));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("[LOCAL] localowner/local-code-pack"));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("[FEDERATED: Remote Cluster 1] remoteowner/remote-code-pack"));
    } finally {
      globalThis.fetch = originalFetch;
      logSpy.mockRestore();
    }
  });
});
