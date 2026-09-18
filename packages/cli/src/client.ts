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

export interface PackDetail extends PackSummary {
  digest: string;
  size: number;
  downloadUrl: string;
  manifest: AgentManifest;
  versions: string[];
  starred?: boolean;
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
  ): Promise<PublishResult> {
    const form = new FormData();
    form.set("manifest", JSON.stringify(manifest));
    form.set(
      "tarball",
      new Blob([new Uint8Array(tarball)], { type: "application/gzip" }),
      `${manifest.name}-${manifest.version}.tgz`,
    );
    const res = await fetch(this.resolve("api/v1/agents"), {
      method: "POST",
      headers: this.headers({ "x-pack-digest": digest }),
      body: form,
    });
    return this.toJson(res);
  }

  async downloadBytes(owner: string, name: string, version: string): Promise<Uint8Array> {
    const res = await fetch(
      this.resolve(
        `api/v1/agents/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${encodeURIComponent(version)}/download`,
      ),
    );
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `HTTP ${res.status} ${res.statusText}`);
    }
    return new Uint8Array(await res.arrayBuffer());
  }
}
