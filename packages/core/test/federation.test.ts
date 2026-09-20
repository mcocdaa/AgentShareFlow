import { describe, expect, it } from "vitest";
import {
  type FederationPeer,
  federationWellKnownUrl,
  fetchFederationManifest,
  queryFederatedPeers,
} from "../src/federation.js";

describe("Federation Core", () => {
  it("computes the standard well-known federation URL", () => {
    expect(federationWellKnownUrl("http://localhost:8787")).toBe(
      "http://localhost:8787/.well-known/agent-federation.json",
    );
    expect(federationWellKnownUrl("https://registry.example.com/prefix/")).toBe(
      "https://registry.example.com/prefix/.well-known/agent-federation.json",
    );
  });

  it("fetches federation manifest from well-known endpoint", async () => {
    const mockFetch = async (url: string | URL | Request) => {
      expect(String(url)).toBe("https://reg2.example.com/.well-known/agent-federation.json");
      return new Response(
        JSON.stringify({
          spec: "agent-federation/v0",
          name: "peer-registry-2",
          version: "0.1.0",
          url: "https://reg2.example.com",
          capabilities: ["search", "download"],
          peerCount: 3,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const manifest = await fetchFederationManifest("https://reg2.example.com", mockFetch as any);
    expect(manifest.spec).toBe("agent-federation/v0");
    expect(manifest.name).toBe("peer-registry-2");
    expect(manifest.capabilities).toContain("search");
    expect(manifest.peerCount).toBe(3);
  });

  it("queries federated peer registries and merges results", async () => {
    const peers: FederationPeer[] = [
      {
        id: "peer-us-east",
        name: "US East Registry",
        url: "https://useast.registry.io",
        status: "active",
        createdAt: "2026-01-01T00:00:00Z",
      },
    ];

    const mockFetch = async (url: string | URL | Request) => {
      if (String(url).includes("useast.registry.io/api/v1/search?q=sec")) {
        return new Response(
          JSON.stringify({
            items: [
              {
                owner: "secops",
                name: "vuln-scanner",
                version: "2.1.0",
                title: "Vulnerability Scanner",
                description: "Scans for known CVEs",
                mode: "offline",
                tags: ["security"],
                downloads: 4200,
                stars: 95,
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("Not found", { status: 404 });
    };

    const federatedItems = await queryFederatedPeers(peers, "sec", mockFetch as any);
    expect(federatedItems.length).toBe(1);
    expect(federatedItems[0].name).toBe("vuln-scanner");
    expect(federatedItems[0].origin).toBe("federated");
    expect(federatedItems[0].peer?.id).toBe("peer-us-east");
  });
});
