import { describe, expect, it, vi } from "vitest";
import {
  ShareClient,
  TunnelClient,
  createSseParser,
  isTunnelFrame,
  parseHandoff,
} from "../src/index.js";

describe("createSseParser", () => {
  it("parses events across chunk boundaries", () => {
    const events: Array<{ event?: string; data: string }> = [];
    const parse = createSseParser((event) => events.push(event));
    parse('event: message\ndata: {"a":');
    parse("1}\n\ndata: plain\n\n");
    expect(events).toEqual([
      { event: "message", data: '{"a":1}' },
      { event: undefined, data: "plain" },
    ]);
  });

  it("joins multi-line data", () => {
    const events: Array<{ event?: string; data: string }> = [];
    const parse = createSseParser((event) => events.push(event));
    parse("data: one\ndata: two\n\n");
    expect(events[0]?.data).toBe("one\ntwo");
  });
});

describe("isTunnelFrame", () => {
  it("accepts valid frames and rejects malformed ones", () => {
    expect(
      isTunnelFrame({ type: "visitor_message", shareId: "s", sessionId: "v", content: "hi" }),
    ).toBe(true);
    expect(isTunnelFrame({ type: "agent_done", shareId: "s", sessionId: "v", content: "" })).toBe(
      true,
    );
    expect(isTunnelFrame({ type: "ping" })).toBe(true);
    expect(isTunnelFrame({ type: "visitor_message", shareId: "s" })).toBe(false);
    expect(isTunnelFrame({ type: "nope" })).toBe(false);
    expect(isTunnelFrame(null)).toBe(false);
  });
});

function sseResponse(lines: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

describe("TunnelClient", () => {
  it("connects, parses frames, and posts frames", async () => {
    const frames: string[] = [];
    const sent: Array<{ url: string; body: string }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/events")) {
        return sseResponse([
          'data: {"type":"ping"}\n\n',
          'data: {"type":"visitor_message","shareId":"s1","sessionId":"v1","content":"hello"}\n\n',
        ]);
      }
      sent.push({ url, body: String(init?.body ?? "") });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const statuses: string[] = [];
    const client = new TunnelClient({
      registry: "http://relay.test",
      shareId: "s1",
      token: "t1",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retryDelayMs: 5,
      onStatus: (status) => statuses.push(status),
      onFrame: (frame) => frames.push(frame.type),
    });

    client.start();
    await vi.waitFor(() => expect(frames).toContain("visitor_message"), { timeout: 2000 });
    await client.stop();

    expect(statuses[0]).toBe("connecting");
    expect(statuses).toContain("online");
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://relay.test/api/v1/tunnel/s1/events",
      expect.objectContaining({ headers: { authorization: "Bearer t1" } }),
    );

    await client.send({ type: "agent_done", shareId: "s1", sessionId: "v1", content: "done" });
    expect(sent[0]?.url).toBe("http://relay.test/api/v1/tunnel/s1/frames");
    expect(JSON.parse(sent[0]?.body ?? "{}")).toMatchObject({ type: "agent_done", shareId: "s1" });
  });
});

describe("ShareClient", () => {
  it("creates shares with bearer auth and builds share urls", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ id: "abc", owner: "o", title: "T", status: "online", createdAt: "now" }));
    });
    const client = new ShareClient({
      registry: "http://relay.test/",
      token: "tok",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const share = await client.createShare({ title: "T" });
    expect(share.id).toBe("abc");
    expect(calls[0]?.url).toBe("http://relay.test/api/v1/shares");
    expect((calls[0]?.init?.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(client.shareUrl("abc")).toBe("http://relay.test/#/share/abc");
  });

  it("sends an attached handoff with the create request", async () => {
    let body: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ id: "abc", owner: "o", title: "T", status: "online", createdAt: "now" }));
    });
    const client = new ShareClient({
      registry: "http://relay.test",
      token: "tok",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const handoff = parseHandoff({ spec: "handoff/v0", id: "h1", title: "H", goal: "G" });
    await client.createShare({ title: "T", handoff });
    expect(body?.["title"]).toBe("T");
    expect((body?.["handoff"] as { id: string }).id).toBe("h1");
    expect((body?.["handoff"] as { context: { constraints: string[] } }).context.constraints).toEqual([]);
  });
});
