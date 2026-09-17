import { describe, expect, it, vi } from "vitest";
import { agentCardUrl, extractA2AText, fetchAgentCard, sendA2AMessage } from "../src/index.js";

const card = {
  name: "mock agent",
  description: "answers things",
  url: "http://agent.test/rpc",
  version: "1.0.0",
  skills: [{ id: "chat", name: "Chat" }],
};

describe("agentCardUrl", () => {
  it("derives the well-known path from a base url", () => {
    expect(agentCardUrl("http://agent.test")).toBe("http://agent.test/.well-known/agent-card.json");
    expect(agentCardUrl("http://agent.test/base/")).toBe(
      "http://agent.test/.well-known/agent-card.json",
    );
    expect(agentCardUrl("http://agent.test/custom/card.json")).toBe(
      "http://agent.test/custom/card.json",
    );
  });
});

describe("fetchAgentCard", () => {
  it("fetches and validates a card", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(card), { status: 200 }));
    const result = await fetchAgentCard("http://agent.test", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.name).toBe("mock agent");
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      "http://agent.test/.well-known/agent-card.json",
    );
  });

  it("rejects invalid cards and http errors", async () => {
    const bad = vi.fn(async () => new Response(JSON.stringify({ name: "x" }), { status: 200 }));
    await expect(
      fetchAgentCard("http://agent.test", { fetchImpl: bad as unknown as typeof fetch }),
    ).rejects.toThrow(/invalid agent card/);
    const notFound = vi.fn(async () => new Response("nope", { status: 404 }));
    await expect(
      fetchAgentCard("http://agent.test", { fetchImpl: notFound as unknown as typeof fetch }),
    ).rejects.toThrow(/HTTP 404/);
  });
});

describe("extractA2AText", () => {
  it("collects task artifacts, agent history, and status messages", () => {
    expect(
      extractA2AText({
        task: {
          artifacts: [{ parts: [{ text: "artifact" }] }],
          history: [
            { role: "user", parts: [{ text: "ignored" }] },
            { role: "agent", parts: [{ text: "history" }] },
          ],
          status: { state: "TASK_STATE_COMPLETED", message: { parts: [{ text: "status" }] } },
        },
      }),
    ).toEqual(["artifact", "history", "status"]);
  });

  it("collects message results", () => {
    expect(extractA2AText({ message: { role: "agent", parts: [{ text: "hello" }] } })).toEqual([
      "hello",
    ]);
  });
});

describe("sendA2AMessage", () => {
  it("sends SendMessage and returns task text with context", async () => {
    let body: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (_input: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "1",
          result: {
            task: {
              id: "task-1",
              contextId: "ctx-1",
              status: { state: "TASK_STATE_COMPLETED" },
              artifacts: [{ parts: [{ text: "pong" }] }],
            },
          },
        }),
        { status: 200 },
      );
    });

    const result = await sendA2AMessage("http://agent.test/rpc", "ping", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toMatchObject({ text: "pong", contextId: "ctx-1", taskId: "task-1" });
    expect(body?.["method"]).toBe("SendMessage");
    const params = body?.["params"] as { message: { parts: Array<{ text: string }> } };
    expect(params.message.parts[0]?.text).toBe("ping");
  });

  it("falls back to message/send when SendMessage is unknown", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async (_input: unknown, init?: RequestInit) => {
      calls += 1;
      const request = JSON.parse(String(init?.body)) as { method: string };
      if (request.method === "SendMessage") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32601 } }), {
          status: 200,
        });
      }
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          result: { message: { role: "agent", parts: [{ text: "legacy ok" }] } },
        }),
        { status: 200 },
      );
    });

    const result = await sendA2AMessage("http://agent.test/rpc", "ping", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.text).toBe("legacy ok");
    expect(calls).toBe(2);
  });

  it("throws on json-rpc errors", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "boom" } }),
        { status: 200 },
      ),
    );
    await expect(
      sendA2AMessage("http://agent.test/rpc", "ping", {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/boom/);
  });
});
