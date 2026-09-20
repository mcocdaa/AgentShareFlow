import type { AgentManifest } from "@agentshare/core";

export interface PackSummary {
  owner: string;
  name: string;
  version: string;
  title: string;
  description: string;
  mode: string;
  tags: string[];
  downloads: number;
  stars: number;
  createdAt: string;
}

export interface PackSignature {
  algorithm: string;
  publicKey: string;
  fingerprint: string;
  value: string;
}

export interface PackDetail extends PackSummary {
  digest: string;
  size: number;
  downloadUrl: string;
  manifest: AgentManifest;
  versions: string[];
  starred?: boolean;
  signature?: PackSignature;
}

export interface PublishResult {
  ok: boolean;
  ref: string;
  digest: string;
  size: number;
}

export class RegistryClient {
  constructor(
    private readonly registry: string,
    private readonly token?: string,
  ) {}

  private resolve(pathname: string): string {
    const base = this.registry.endsWith("/") ? this.registry : `${this.registry}/`;
    return new URL(pathname, base).toString();
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return this.token ? { authorization: `Bearer ${this.token}`, ...extra } : extra;
  }

  private async toJson<T>(res: Response): Promise<T> {
    const body = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status} ${res.statusText}`);
    return body;
  }

  async search(query: string, mode?: string): Promise<{ items: PackSummary[] }> {
    const params = new URLSearchParams({ q: query });
    if (mode) params.set("mode", mode);
    const res = await fetch(this.resolve(`api/v1/search?${params.toString()}`));
    return this.toJson(res);
  }

  async info(owner: string, name: string, version?: string): Promise<PackDetail> {
    const suffix = version ? `/${encodeURIComponent(version)}` : "";
    const res = await fetch(
      this.resolve(`api/v1/agents/${encodeURIComponent(owner)}/${encodeURIComponent(name)}${suffix}`),
      { headers: this.headers() },
    );
    return this.toJson(res);
  }

  async setStar(
    owner: string,
    name: string,
    starred: boolean,
  ): Promise<{ starred: boolean; stars: number }> {
    const res = await fetch(
      this.resolve(`api/v1/agents/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/star`),
      { method: starred ? "POST" : "DELETE", headers: this.headers() },
    );
    return this.toJson(res);
  }

  async publish(
    manifest: AgentManifest,
    tarball: Uint8Array,
    digest: string,
    signing: { publicKeyHeader: string; signature: string } | undefined = undefined,
    options: { owner?: string; visibility?: string } = {},
  ): Promise<PublishResult> {
    const form = new FormData();
    form.set("manifest", JSON.stringify(manifest));
    form.set(
      "tarball",
      new Blob([new Uint8Array(tarball)], { type: "application/gzip" }),
      `${manifest.name}-${manifest.version}.tgz`,
    );
    const extraHeaders: Record<string, string> = {
      "x-pack-digest": digest,
      ...(signing === undefined
        ? {}
        : { "x-pack-public-key": signing.publicKeyHeader, "x-pack-signature": signing.signature }),
      ...(options.owner ? { "x-pack-owner": options.owner } : {}),
      ...(options.visibility ? { "x-pack-visibility": options.visibility } : {}),
    };
    const res = await fetch(this.resolve("api/v1/agents"), {
      method: "POST",
      headers: this.headers(extraHeaders),
      body: form,
    });
    return this.toJson(res);
  }

  async downloadBytes(owner: string, name: string, version: string): Promise<Uint8Array> {
    const res = await fetch(
      this.resolve(
        `api/v1/agents/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${encodeURIComponent(version)}/download`,
      ),
      { headers: this.headers() },
    );
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `HTTP ${res.status} ${res.statusText}`);
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  async createOrg(
    name: string,
    displayName?: string,
    description?: string,
  ): Promise<{ org: { name: string; display_name: string; description: string }; role: string }> {
    const res = await fetch(this.resolve("api/v1/orgs"), {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify({ name, displayName, description }),
    });
    return this.toJson(res);
  }

  async listOrgs(): Promise<{
    organizations: Array<{
      org: { name: string; display_name: string; description: string; created_at: string };
      role: string;
    }>;
  }> {
    const res = await fetch(this.resolve("api/v1/orgs"), { headers: this.headers() });
    return this.toJson(res);
  }

  async getOrg(name: string): Promise<{
    org: { name: string; display_name: string; description: string; created_at: string };
    role: string | null;
    members?: Array<{ org_name: string; member_identity: string; role: string; created_at: string }>;
  }> {
    const res = await fetch(this.resolve(`api/v1/orgs/${encodeURIComponent(name)}`), {
      headers: this.headers(),
    });
    return this.toJson(res);
  }

  async addOrgMember(
    orgName: string,
    memberIdentity: string,
    role = "member",
  ): Promise<{ ok: boolean; org_name: string; member_identity: string; role: string }> {
    const res = await fetch(this.resolve(`api/v1/orgs/${encodeURIComponent(orgName)}/members`), {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify({ memberIdentity, role }),
    });
    return this.toJson(res);
  }

  async removeOrgMember(orgName: string, memberIdentity: string): Promise<{ ok: boolean }> {
    const res = await fetch(
      this.resolve(
        `api/v1/orgs/${encodeURIComponent(orgName)}/members/${encodeURIComponent(memberIdentity)}`,
      ),
      { method: "DELETE", headers: this.headers() },
    );
    return this.toJson(res);
  }

  async listPeers(): Promise<{
    peers: Array<{
      id: string;
      name: string;
      url: string;
      status: string;
      created_at: string;
      last_synced_at: string | null;
    }>;
  }> {
    const res = await fetch(this.resolve("api/v1/federation/peers"), { headers: this.headers() });
    return this.toJson(res);
  }

  async addPeer(
    url: string,
    name?: string,
  ): Promise<{ ok: boolean; peer: { id: string; name: string; url: string; status: string } }> {
    const res = await fetch(this.resolve("api/v1/federation/peers"), {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify({ url, name }),
    });
    return this.toJson(res);
  }

  async removePeer(id: string): Promise<{ ok: boolean; removed: boolean }> {
    const res = await fetch(this.resolve(`api/v1/federation/peers/${encodeURIComponent(id)}`), {
      method: "DELETE",
      headers: this.headers(),
    });
    return this.toJson(res);
  }

  async federatedSearch(query: string, mode?: string): Promise<{
    query: string;
    total: number;
    localCount: number;
    federatedCount: number;
    items: Array<PackSummary & { origin: "local" | "federated"; peer?: { id: string; name: string; url: string } }>;
  }> {
    const params = new URLSearchParams({ q: query });
    if (mode) params.set("mode", mode);
    const res = await fetch(this.resolve(`api/v1/federation/search?${params.toString()}`), {
      headers: this.headers(),
    });
    return this.toJson(res);
  }
}

