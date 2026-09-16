export type ShareStatus = "online" | "offline" | "revoked";

export interface ShareSummary {
  id: string;
  owner: string;
  title: string;
  status: ShareStatus;
  project?: string;
  createdAt: string;
  lastSeenAt?: string;
}

export interface ShareMessageRecord {
  id: number;
  sessionId: string;
  role: "visitor" | "agent" | "system";
  content: string;
  createdAt: string;
}

export type TunnelFrame =
  | {
      type: "visitor_message";
      shareId: string;
      sessionId: string;
      messageId?: number;
      content: string;
      visitorName?: string;
    }
  | { type: "agent_chunk"; shareId: string; sessionId: string; content: string }
  | { type: "agent_done"; shareId: string; sessionId: string; content: string }
  | { type: "agent_error"; shareId: string; sessionId: string; message: string }
  | { type: "fork_created"; shareId: string; sessionId: string; dshSessionId: string }
  | { type: "ping"; at?: string };

export function isTunnelFrame(value: unknown): value is TunnelFrame {
  if (typeof value !== "object" || value === null) return false;
  const frame = value as Record<string, unknown>;
  switch (frame["type"]) {
    case "visitor_message":
      return (
        typeof frame["shareId"] === "string" &&
        typeof frame["sessionId"] === "string" &&
        typeof frame["content"] === "string"
      );
    case "agent_chunk":
    case "agent_done":
      return (
        typeof frame["shareId"] === "string" &&
        typeof frame["sessionId"] === "string" &&
        typeof frame["content"] === "string"
      );
    case "agent_error":
      return (
        typeof frame["shareId"] === "string" &&
        typeof frame["sessionId"] === "string" &&
        typeof frame["message"] === "string"
      );
    case "fork_created":
      return (
        typeof frame["shareId"] === "string" &&
        typeof frame["sessionId"] === "string" &&
        typeof frame["dshSessionId"] === "string"
      );
    case "ping":
      return true;
    default:
      return false;
  }
}

export interface SseEvent {
  event?: string;
  data: string;
}

export function createSseParser(onEvent: (event: SseEvent) => void): (chunk: string) => void {
  let buffer = "";
  return (chunk: string) => {
    buffer += chunk;
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      let event: string | undefined;
      const dataLines: string[] = [];
      for (const line of raw.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
      }
      if (dataLines.length > 0) onEvent({ event, data: dataLines.join("\n") });
      boundary = buffer.indexOf("\n\n");
    }
  };
}

function joinUrl(base: string, pathname: string): string {
  const normalized = base.endsWith("/") ? base : `${base}/`;
  return new URL(pathname.replace(/^\//, ""), normalized).toString();
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface TunnelClientOptions {
  registry: string;
  shareId: string;
  token: string;
  onFrame: (frame: TunnelFrame) => void | Promise<void>;
  onStatus?: (status: "connecting" | "online" | "offline") => void;
  fetchImpl?: typeof fetch;
  retryDelayMs?: number;
}

export class TunnelClient {
  private readonly fetchImpl: typeof fetch;
  private stopped = true;
  private controller: AbortController | undefined;

  constructor(private readonly options: TunnelClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.options.token}` };
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.loop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.controller?.abort();
  }

  async send(frame: TunnelFrame): Promise<void> {
    const res = await this.fetchImpl(
      joinUrl(this.options.registry, `/api/v1/tunnel/${this.options.shareId}/frames`),
      {
        method: "POST",
        headers: { ...this.headers(), "content-type": "application/json" },
        body: JSON.stringify(frame),
      },
    );
    if (!res.ok) throw new Error(`tunnel frame rejected: HTTP ${res.status}`);
  }

  private async loop(): Promise<void> {
    let failures = 0;
    while (!this.stopped) {
      this.options.onStatus?.("connecting");
      this.controller = new AbortController();
      try {
        const res = await this.fetchImpl(
          joinUrl(this.options.registry, `/api/v1/tunnel/${this.options.shareId}/events`),
          { headers: this.headers(), signal: this.controller.signal },
        );
        if (!res.ok || !res.body) throw new Error(`tunnel connect failed: HTTP ${res.status}`);
        this.options.onStatus?.("online");
        failures = 0;
        const parse = createSseParser(({ data }) => {
          let value: unknown;
          try {
            value = JSON.parse(data);
          } catch {
            return;
          }
          if (isTunnelFrame(value)) void this.options.onFrame(value);
        });
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          parse(decoder.decode(value, { stream: true }));
        }
      } catch {
        if (this.stopped) break;
      }
      this.options.onStatus?.("offline");
      if (this.stopped) break;
      failures += 1;
      const delay = Math.min(30_000, this.options.retryDelayMs ?? 1_000 * 2 ** Math.min(failures, 5));
      await sleep(delay);
    }
  }
}

export interface ShareClientOptions {
  registry: string;
  token?: string;
  fetchImpl?: typeof fetch;
}

export class ShareClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: ShareClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return this.options.token
      ? { authorization: `Bearer ${this.options.token}`, ...extra }
      : extra;
  }

  private async json<T>(res: Response): Promise<T> {
    const body = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status} ${res.statusText}`);
    return body;
  }

  async createShare(input: { title: string; project?: string }): Promise<ShareSummary> {
    const res = await this.fetchImpl(joinUrl(this.options.registry, "/api/v1/shares"), {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify(input),
    });
    return this.json<ShareSummary>(res);
  }

  async listShares(): Promise<{ items: ShareSummary[] }> {
    const res = await this.fetchImpl(joinUrl(this.options.registry, "/api/v1/shares"), {
      headers: this.headers(),
    });
    return this.json(res);
  }

  async getShare(id: string): Promise<ShareSummary> {
    const res = await this.fetchImpl(
      joinUrl(this.options.registry, `/api/v1/shares/${encodeURIComponent(id)}`),
    );
    return this.json<ShareSummary>(res);
  }

  async revokeShare(id: string): Promise<ShareSummary> {
    const res = await this.fetchImpl(
      joinUrl(this.options.registry, `/api/v1/shares/${encodeURIComponent(id)}/revoke`),
      { method: "POST", headers: this.headers() },
    );
    return this.json<ShareSummary>(res);
  }

  shareUrl(id: string): string {
    return `${this.options.registry.replace(/\/$/, "")}/#/share/${id}`;
  }
}
