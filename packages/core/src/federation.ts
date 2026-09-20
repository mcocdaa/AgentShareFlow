export interface FederationPeer {
  id: string;
  name: string;
  url: string;
  status: "active" | "unreachable" | "pending";
  createdAt: string;
  lastSyncedAt?: string | null;
}

export interface FederationManifest {
  spec: "agent-federation/v0";
  name: string;
  version: string;
  url: string;
  capabilities: Array<"search" | "download" | "a2a" | "policy">;
  peerCount: number;
}

export interface FederatedSearchResultItem {
  owner: string;
  name: string;
  version: string;
  title: string;
  description: string;
  mode: string;
  tags: string[];
  downloads: number;
  stars: number;
  origin: "local" | "federated";
  peer?: {
    id: string;
    name: string;
    url: string;
  };
}

export function federationWellKnownUrl(registryUrl: string): string {
  const base = registryUrl.endsWith("/") ? registryUrl : `${registryUrl}/`;
  return new URL(".well-known/agent-federation.json", base).toString();
}

/**
 * Fetches the federation descriptor from a target registry node.
 */
export async function fetchFederationManifest(
  registryUrl: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 3000,
): Promise<FederationManifest> {
  const url = federationWellKnownUrl(registryUrl);
  const res = await fetchImpl(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch federation manifest from ${url}: HTTP ${res.status}`);
  }
  const data = (await res.json()) as Partial<FederationManifest>;
  if (data.spec !== "agent-federation/v0" || !data.name || !data.url) {
    throw new Error(`Invalid federation manifest returned by ${url}`);
  }
  return data as FederationManifest;
}

/**
 * Queries multiple peer registries in parallel and merges the results with local packs.
 */
export async function queryFederatedPeers(
  peers: FederationPeer[],
  query: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 3000,
): Promise<FederatedSearchResultItem[]> {
  const results: FederatedSearchResultItem[] = [];

  const promises = peers
    .filter((p) => p.status !== "unreachable")
    .map(async (peer) => {
      try {
        const base = peer.url.endsWith("/") ? peer.url : `${peer.url}/`;
        const searchUrl = new URL(`api/v1/search?q=${encodeURIComponent(query)}`, base).toString();
        const res = await fetchImpl(searchUrl, {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) return;

        const body = (await res.json()) as { items?: Array<Record<string, unknown>> };
        if (Array.isArray(body.items)) {
          for (const item of body.items) {
            results.push({
              owner: String(item.owner || "unknown"),
              name: String(item.name || "pack"),
              version: String(item.version || "0.0.0"),
              title: String(item.title || item.name || "Untitled Pack"),
              description: String(item.description || ""),
              mode: String(item.mode || "offline"),
              tags: Array.isArray(item.tags) ? item.tags.map(String) : [],
              downloads: Number(item.downloads || 0),
              stars: Number(item.stars || 0),
              origin: "federated",
              peer: {
                id: peer.id,
                name: peer.name,
                url: peer.url,
              },
            });
          }
        }
      } catch {
        // Individual peer failure does not abort overall federated search
      }
    });

  await Promise.allSettled(promises);
  return results;
}
