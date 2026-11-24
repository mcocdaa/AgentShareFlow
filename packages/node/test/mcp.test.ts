import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { McpServer, type JsonRpcResponse, type McpBackend } from "../src/mcp.js";

function createMockBackend(): McpBackend {
  return {
    listContacts: vi.fn(async () => ({
      friends: [
        {
          id: "f1",
          userId: "u1",
          friendUserId: "u2",
          friendUsername: "bob",
          friendDisplayName: "Bob",
          status: "accepted" as const,
          direction: "outgoing" as const,
          createdAt: 1_000,
        },
      ],
      nodes: [
        {
          nodeId: "node-bob",
          ownerUserId: "u2",
          ownerUsername: "bob",
          handle: "bob-bot",
          displayName: "Bob Bot",
          kind: "http" as const,
          description: "Test bot",
          capabilities: ["chat"],
          signPublicKey: "sig",
          kxPublicKey: "kx",
          directUrl: "http://127.0.0.1:9001",
          online: true,
          lastSeenAt: 2_000,
        },
      ],
    })),
    checkInbox: vi.fn(async () => ({
      items: [
        {
          id: "in-1",
          kind: "room_mention" as const,
          fromHandle: "alice",
          fromNodeId: null,
          roomId: "room-1",
          roomName: "general",
          messageId: "msg-1",
          preview: "@mcp-b check this",
          createdAt: 3_000,
          read: false,
        },
      ],
    })),
    waitForMention: vi.fn(async () => ({
      items: [
        {
          id: "in-2",
          kind: "dm" as const,
          fromHandle: "bob-bot",
          fromNodeId: "node-bob",
          roomId: null,
          roomName: null,
          messageId: "dm-1",
          preview: "hello over p2p",
          transport: "direct" as const,
          createdAt: 4_000,
          read: false,
        },
      ],
      timedOut: false,
    })),
    readRoom: vi.fn(async ({ room }) => ({
      room,
      messages: [
        {
          id: "m1",
          roomId: "room-1",
          seq: 1,
          senderType: "human" as const,
          senderUserId: "u1",
          senderNodeId: null,
          senderHandle: "alice",
          content: "hello room",
          mentions: [],
          hopCount: 0,
          hopChainId: "hc-1",
          loopBroken: false,
          createdAt: 5_000,
        },
      ],
    })),
    sendRoomMessage: vi.fn(async ({ room, content }) => ({
      message: {
        id: "m2",
        roomId: room,
        seq: 2,
        senderType: "agent" as const,
        senderUserId: "u1",
        senderNodeId: "node-me",
        senderHandle: "mcp-b",
        content,
        mentions: [],
        hopCount: 0,
        hopChainId: "hc-2",
        loopBroken: false,
        createdAt: 6_000,
      },
    })),
    readDm: vi.fn(async ({ peer }) => ({
      peer,
      messages: [
        {
          id: "dm-1",
          peerNodeId: "node-bob",
          peerHandle: "bob-bot",
          direction: "in" as const,
          content: "secret",
          transport: "direct" as const,
          encrypted: true,
          status: "delivered" as const,
          createdAt: 7_000,
        },
      ],
    })),
    sendDm: vi.fn(async ({ peer, content, forceRelay }) => ({
      message: {
        id: "dm-2",
        peerNodeId: "node-bob",
        peerHandle: peer,
        direction: "out" as const,
        content,
        transport: forceRelay ? ("relay" as const) : ("direct" as const),
        encrypted: true,
        status: "delivered" as const,
        createdAt: 8_000,
      },
      transport: forceRelay ? ("relay" as const) : ("direct" as const),
    })),
  };
}

function createHarness(backend: McpBackend) {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines: string[] = [];
  let rawOut = "";
  let partial = "";

  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    rawOut += chunk;
    partial += chunk;
    let idx = partial.indexOf("\n");
    while (idx !== -1) {
      const line = partial.slice(0, idx).trim();
      partial = partial.slice(idx + 1);
      if (line) lines.push(line);
      idx = partial.indexOf("\n");
    }
  });

  const server = new McpServer({ backend, input, output });
  server.start();

  const send = (payload: unknown) => {
    input.write(`${JSON.stringify(payload)}\n`);
  };

  const nextResponse = async (expectedCount: number): Promise<JsonRpcResponse> => {
    const deadline = Date.now() + 2_000;
    while (lines.length < expectedCount && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const line = lines[expectedCount - 1];
    if (!line) {
      throw new Error(`Timed out waiting for response #${expectedCount}`);
    }
    return JSON.parse(line) as JsonRpcResponse;
  };

  return {
    server,
    input,
    output,
    send,
    nextResponse,
    getRawOutput: () => rawOut,
    getResponseCount: () => lines.length,
  };
}

describe("McpServer JSON-RPC 2.0", () => {
  it("handles initialize and tools/list returning all 7 tools", async () => {
    const backend = createMockBackend();
    const h = createHarness(backend);

    h.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05" },
    });
    const initRes = await h.nextResponse(1);
    expect(initRes.id).toBe(1);
    expect(initRes.error).toBeUndefined();
    expect(initRes.result).toMatchObject({
      protocolVersion: "2024-11-05",
      serverInfo: { name: "agentshare", version: "2.1.0" },
    });

    h.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const listRes = await h.nextResponse(2);
    const tools = (listRes.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.map((t) => t.name)).toEqual([
      "list_contacts",
      "check_inbox",
      "wait_for_mention",
      "read_room",
      "send_room_message",
      "read_dm",
      "send_dm",
    ]);

    h.server.stop();
  });

  it("never replies to notifications (known or unknown)", async () => {
    const backend = createMockBackend();
    const h = createHarness(backend);

    h.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    h.send({ jsonrpc: "2.0", method: "notifications/unknown_event", params: { foo: 1 } });
    h.send({ jsonrpc: "2.0", method: "custom/no_id_event" });

    await new Promise((r) => setTimeout(r, 50));
    expect(h.getRawOutput()).toBe("");
    expect(h.getResponseCount()).toBe(0);

    // Follow up with a real request (id: 0 is a valid JSON-RPC id!) to prove stream is still healthy.
    h.send({ jsonrpc: "2.0", id: 0, method: "ping" });
    const pingRes = await h.nextResponse(1);
    expect(pingRes).toEqual({ jsonrpc: "2.0", id: 0, result: {} });

    h.server.stop();
  });

  it("executes tools/call for all 7 tools and forwards arguments cleanly", async () => {
    const backend = createMockBackend();
    const h = createHarness(backend);

    const calls: Array<{ name: string; args: Record<string, unknown> }> = [
      { name: "list_contacts", args: { onlineOnly: true } },
      { name: "check_inbox", args: { unreadOnly: true, markRead: true } },
      { name: "wait_for_mention", args: { timeoutSec: 5 } },
      { name: "read_room", args: { room: "general", sinceSeq: 0, limit: 20, markRead: true } },
      { name: "send_room_message", args: { room: "general", content: "hi @bob-bot" } },
      { name: "read_dm", args: { peer: "bob-bot", limit: 10 } },
      { name: "send_dm", args: { peer: "bob-bot", content: "private hi", forceRelay: true } },
    ];

    for (let i = 0; i < calls.length; i += 1) {
      const call = calls[i]!;
      h.send({
        jsonrpc: "2.0",
        id: i + 10,
        method: "tools/call",
        params: { name: call.name, arguments: call.args },
      });
      const res = await h.nextResponse(i + 1);
      expect(res.id).toBe(i + 10);
      expect(res.error).toBeUndefined();
      const result = res.result as {
        isError?: boolean;
        content: Array<{ type: string; text: string }>;
      };
      expect(result.isError).toBeUndefined();
      expect(result.content[0]?.type).toBe("text");
      expect(() => JSON.parse(result.content[0]!.text)).not.toThrow();
    }

    expect(backend.listContacts).toHaveBeenCalledWith({ onlineOnly: true });
    expect(backend.checkInbox).toHaveBeenCalledWith({ unreadOnly: true, markRead: true });
    expect(backend.waitForMention).toHaveBeenCalledWith({ timeoutSec: 5 });
    expect(backend.readRoom).toHaveBeenCalledWith({
      room: "general",
      sinceSeq: 0,
      limit: 20,
      markRead: true,
    });
    expect(backend.sendRoomMessage).toHaveBeenCalledWith({
      room: "general",
      content: "hi @bob-bot",
      hopChainId: undefined,
      resetLoop: undefined,
    });
    expect(backend.readDm).toHaveBeenCalledWith({ peer: "bob-bot", limit: 10 });
    expect(backend.sendDm).toHaveBeenCalledWith({
      peer: "bob-bot",
      content: "private hi",
      forceRelay: true,
    });

    h.server.stop();
  });
});
