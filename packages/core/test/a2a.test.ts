import { describe, expect, it } from "vitest";
import { extractA2aResult, sendHttpOrA2aMessage } from "../src/a2a.js";

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

describe("extractA2aResult", () => {
  it("parses A2A v0.2/v0.3 top-level Message", () => {
    const res = extractA2aResult({
      kind: "message",
      messageId: "m-1",
      role: "agent",
      taskId: "t-1",
      parts: [{ kind: "text", text: "Hello from top-level message" }],
    });
    expect(res).toEqual({
      reply: "Hello from top-level message",
      taskId: "t-1",
    });
  });

  it("parses A2A v0.2/v0.3 top-level Task (artifacts, status, agent history, deduped)", () => {
    const res = extractA2aResult({
      kind: "task",
      id: "task-99",
      status: {
        state: "completed",
        message: {
          role: "agent",
          parts: [{ kind: "text", text: "All checks passed." }],
        },
      },
      artifacts: [
        {
          parts: [{ kind: "text", text: "Build green" }],
        },
      ],
      history: [
        { role: "user", parts: [{ kind: "text", text: "Do not echo user" }] },
        { role: "agent", parts: [{ kind: "text", text: "Build green" }] },
      ],
    });
    expect(res).toEqual({
      reply: "Build green\nAll checks passed.",
      taskId: "task-99",
    });
  });

  it("parses wrapped result.message and result.task", () => {
    expect(
      extractA2aResult({
        message: {
          role: "agent",
          taskId: "t-msg",
          parts: [{ text: "Wrapped message" }],
        },
      }),
    ).toEqual({ reply: "Wrapped message", taskId: "t-msg" });

    expect(
      extractA2aResult({
        task: {
          id: "t-wrap",
          artifacts: [{ parts: [{ text: "Wrapped task" }] }],
        },
      }),
    ).toEqual({ reply: "Wrapped task", taskId: "t-wrap" });
  });
});

describe("sendHttpOrA2aMessage", () => {
  it("sends HTTP mode request preserving subpath and custom headers", async () => {
    let seenUrl = "";
    let seenHeaders: Record<string, string> = {};
    let seenBody: unknown;

    const result = await sendHttpOrA2aMessage({
      url: "https://agent.example/custom/subpath/chat",
      mode: "http",
      message: "Check deployment",
      from: "alice",
      roomId: "room-ops",
      context: [{ sender: "bob", content: "v2.0 deployed" }],
      headers: { authorization: "Bearer secret-token" },
      lookupFn: publicLookup,
      fetchImpl: async (input, init) => {
        seenUrl = String(input);
        seenHeaders = (init?.headers ?? {}) as Record<string, string>;
        seenBody = JSON.parse(String(init?.body));
        expect(init?.redirect).toBe("manual");
        return new Response(
          JSON.stringify({ reply: "Deployment healthy", taskId: "http-1" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    expect(seenUrl).toBe("https://agent.example/custom/subpath/chat");
    expect(seenHeaders["authorization"]).toBe("Bearer secret-token");
    expect(seenBody).toEqual({
      message: "Check deployment",
      from: "alice",
      roomId: "room-ops",
      context: [{ sender: "bob", content: "v2.0 deployed" }],
    });
    expect(result).toEqual({ reply: "Deployment healthy", taskId: "http-1" });
  });

  it("sends A2A JSON-RPC message/send preserving subpath and falls back to SendMessage on -32601", async () => {
    const seenMethods: string[] = [];
    let seenUrl = "";

    const result = await sendHttpOrA2aMessage({
      url: "https://a2a.example/org/bot-1/rpc",
      mode: "a2a",
      message: "Review diff",
      from: "alice",
      roomId: "room-dev",
      lookupFn: publicLookup,
      fetchImpl: async (input, init) => {
        seenUrl = String(input);
        const body = JSON.parse(String(init?.body)) as {
          id: string;
          method: string;
          params: { message: { parts: Array<{ kind: string; text: string }> } };
        };
        seenMethods.push(body.method);
        expect(body.params.message.parts[0]).toEqual({
          kind: "text",
          text: "Review diff",
        });

        if (body.method === "message/send") {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              error: { code: -32601, message: "Method not found" },
            }),
            { status: 200 },
          );
        }

        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              kind: "task",
              id: "a2a-task-7",
              artifacts: [{ parts: [{ kind: "text", text: "LGTM" }] }],
            },
          }),
          { status: 200 },
        );
      },
    });

    expect(seenUrl).toBe("https://a2a.example/org/bot-1/rpc");
    expect(seenMethods).toEqual(["message/send", "SendMessage"]);
    expect(result).toEqual({ reply: "LGTM", taskId: "a2a-task-7" });
  });

  it("enforces SSRF protection and blocks HTTP redirects", async () => {
    await expect(
      sendHttpOrA2aMessage({
        url: "http://127.0.0.1:9999/a2a",
        mode: "a2a",
        message: "hi",
        from: "alice",
        fetchImpl: async () => new Response("ok"),
      }),
    ).rejects.toThrow(/blocked/i);

    await expect(
      sendHttpOrA2aMessage({
        url: "https://agent.example/redirect",
        mode: "http",
        message: "hi",
        from: "alice",
        lookupFn: publicLookup,
        fetchImpl: async () =>
          new Response(null, {
            status: 302,
            headers: { location: "http://169.254.169.254/latest/meta-data/" },
          }),
      }),
    ).rejects.toThrow(/redirect/i);
  });
});
