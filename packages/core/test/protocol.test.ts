import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  canonicalPacketSigningInput,
  ClientToServerFrameSchema,
  DEFAULT_MAX_AGENT_HOPS,
  DmMessageSchema,
  DmPayloadSchema,
  extractMentions,
  FriendRecordSchema,
  HANDLE_PATTERN,
  IceServerConfigSchema,
  InboxItemSchema,
  NodePolicyConfigSchema,
  NodePresenceSchema,
  P2pPacketSchema,
  PairCodeRecordSchema,
  PROTOCOL_VERSION,
  RoomMessageSchema,
  RoomSummarySchema,
  ServerToClientFrameSchema,
  UserProfileSchema,
  type P2pPacket,
} from "../src/protocol.js";

describe("protocol constants & browser safety", () => {
  it("exports expected protocol constants", () => {
    expect(PROTOCOL_VERSION).toBe(2);
    expect(DEFAULT_MAX_AGENT_HOPS).toBe(5);
    expect(HANDLE_PATTERN.test("alice")).toBe(true);
    expect(HANDLE_PATTERN.test("bot-1_ok")).toBe(true);
    expect(HANDLE_PATTERN.test("a")).toBe(false);
    expect(HANDLE_PATTERN.test("Upper")).toBe(false);
    expect(HANDLE_PATTERN.test("-bad")).toBe(false);
    expect(HANDLE_PATTERN.test("a".repeat(33))).toBe(false);
  });

  it("protocol.ts stays 100% browser-safe with zero node: imports", () => {
    const source = readFileSync(
      new URL("../src/protocol.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/from\s+["']node:/);
    expect(source).not.toMatch(/require\(\s*["']node:/);
  });
});

describe("extractMentions", () => {
  it("extracts valid mentions, lowercases, and deduplicates in order", () => {
    expect(extractMentions("@alice")).toEqual(["alice"]);
    expect(extractMentions("hi @bot-1 and (@helper) please check @BOT-1")).toEqual([
      "bot-1",
      "helper",
    ]);
    expect(extractMentions("hello @code_review, @qa-bot! @Alice.")).toEqual([
      "code_review",
      "qa-bot",
      "alice",
    ]);
    expect(extractMentions("请问@coder帮我看看")).toEqual(["coder"]);
  });

  it("ignores emails, identifiers, double-at, short handles, and overlong handles", () => {
    expect(extractMentions("contact foo@bar.com for info")).toEqual([]);
    expect(extractMentions("a.b@bar and user@host and a.@bar")).toEqual([]);
    expect(extractMentions("@@alice is not a mention")).toEqual([]);
    expect(extractMentions("single char @a is too short")).toEqual([]);
    expect(extractMentions(`@${"a".repeat(33)} is too long`)).toEqual([]);
    expect(
      extractMentions("email foo@bar.com and ping @real_agent"),
    ).toEqual(["real_agent"]);
  });
});

describe("canonicalPacketSigningInput", () => {
  it("produces identical canonical output regardless of property order", () => {
    const base: Omit<P2pPacket, "signature"> = {
      version: 2,
      id: "pkt-1",
      fromNodeId: "node-a",
      fromHandle: "alice",
      toNodeId: "node-b",
      timestamp: 1_700_000_000_000,
      nonce: "abc123",
      envelope: {
        alg: "aes-256-gcm",
        iv: "iv-val",
        tag: "tag-val",
        ciphertext: "ct-val",
      },
    };

    const reordered: Omit<P2pPacket, "signature"> = {
      envelope: {
        ciphertext: "ct-val",
        tag: "tag-val",
        iv: "iv-val",
        alg: "aes-256-gcm",
      },
      nonce: "abc123",
      timestamp: 1_700_000_000_000,
      toNodeId: "node-b",
      fromHandle: "alice",
      fromNodeId: "node-a",
      id: "pkt-1",
      version: 2,
    };

    expect(canonicalPacketSigningInput(base)).toBe(
      canonicalPacketSigningInput(reordered),
    );
  });
});

describe("Zod schemas", () => {
  const sampleNode = {
    nodeId: "node-1",
    ownerUserId: "usr-1",
    ownerUsername: "alice",
    handle: "coder",
    displayName: "Coder Bot",
    kind: "mcp" as const,
    description: "Code review helper",
    capabilities: ["code-review", "test"],
    signPublicKey: "sign-pub",
    kxPublicKey: "kx-pub",
    directUrl: "https://coder.example:9001",
    online: true,
    lastSeenAt: 1_700_000_000_000,
  };

  const samplePacket = {
    version: 2 as const,
    id: "pkt-1",
    fromNodeId: "node-1",
    fromHandle: "coder",
    toNodeId: "node-2",
    timestamp: 1_700_000_000_000,
    nonce: "nonce-1",
    envelope: {
      alg: "aes-256-gcm" as const,
      iv: "iv",
      tag: "tag",
      ciphertext: "ct",
    },
    signature: "sig",
  };

  const sampleRoomMessage = {
    id: "msg-1",
    roomId: "room-1",
    seq: 1,
    senderType: "agent" as const,
    senderUserId: "usr-1",
    senderNodeId: "node-1",
    senderHandle: "coder",
    content: "hello @qa",
    mentions: ["qa"],
    hopCount: 1,
    hopChainId: "chain-1",
    loopBroken: false,
    createdAt: 1_700_000_000_000,
  };

  const sampleInboxItem = {
    id: "inb-1",
    kind: "room_mention" as const,
    fromHandle: "coder",
    fromNodeId: "node-1",
    roomId: "room-1",
    roomName: "general",
    messageId: "msg-1",
    preview: "hello @qa",
    transport: "direct" as const,
    createdAt: 1_700_000_000_000,
    read: false,
  };

  it("validates entity schemas", () => {
    expect(
      UserProfileSchema.parse({
        id: "usr-1",
        username: "alice",
        displayName: "Alice",
        role: "admin",
        createdAt: 1_700_000_000_000,
      }).role,
    ).toBe("admin");

    expect(NodePresenceSchema.parse(sampleNode).handle).toBe("coder");

    expect(
      FriendRecordSchema.parse({
        id: "fr-1",
        userId: "usr-1",
        friendUserId: "usr-2",
        friendUsername: "bob",
        friendDisplayName: "Bob",
        status: "accepted",
        direction: "outgoing",
        createdAt: 1_700_000_000_000,
      }).status,
    ).toBe("accepted");

    expect(
      PairCodeRecordSchema.parse({
        code: "PAIR-1234",
        creatorUserId: "usr-1",
        creatorNodeId: null,
        expiresAt: 1_700_000_060_000,
        maxUses: 1,
        usedCount: 0,
      }).code,
    ).toBe("PAIR-1234");

    expect(
      RoomSummarySchema.parse({
        id: "room-1",
        slug: "general",
        name: "General",
        topic: "Main lounge",
        createdBy: "usr-1",
        maxAgentHops: 5,
        createdAt: 1_700_000_000_000,
      }).slug,
    ).toBe("general");

    expect(RoomMessageSchema.parse(sampleRoomMessage).seq).toBe(1);
    expect(InboxItemSchema.parse(sampleInboxItem).kind).toBe("room_mention");
    expect(P2pPacketSchema.parse(samplePacket).version).toBe(2);
    expect(
      DmPayloadSchema.parse({
        kind: "task_request",
        text: "run tests",
        taskId: "t-1",
        metadata: { repo: "agentshare" },
      }).taskId,
    ).toBe("t-1");
    expect(
      DmMessageSchema.parse({
        id: "dm-1",
        peerNodeId: "node-2",
        peerHandle: "qa",
        direction: "out",
        content: "hi",
        transport: "relay",
        encrypted: true,
        status: "delivered",
        createdAt: 1_700_000_000_000,
      }).encrypted,
    ).toBe(true);
    expect(
      NodePolicyConfigSchema.parse({
        defaultAllow: false,
        defaultMode: "manual_approval",
        defaultMaxRequestsPerHour: 30,
        allowedDir: "/tmp/workspace",
        rules: [
          {
            subject: "bob",
            allow: true,
            mode: "read_only_scoped",
            maxRequestsPerHour: 60,
          },
        ],
      }).rules,
    ).toHaveLength(1);
  });

  it("validates ClientToServerFrame and ServerToClientFrame discriminated unions", () => {
    const clientFrames = [
      { type: "ping" },
      {
        type: "node.register",
        nodeId: "node-1",
        handle: "coder",
        displayName: "Coder",
        kind: "cli",
        description: "CLI node",
        capabilities: ["shell"],
        signPublicKey: "pub",
        kxPublicKey: "kx",
        directUrl: null,
      },
      { type: "room.subscribe", roomId: "room-1" },
      { type: "room.send", roomId: "room-1", content: "hi", resetLoop: true },
      {
        type: "signal.offer",
        toNodeId: "node-2",
        signalType: "webrtc_sdp",
        payload: { sdp: "v=0" },
      },
      {
        type: "signal.answer",
        toNodeId: "node-1",
        signalType: "webrtc_ice",
        payload: { candidate: "cand" },
      },
      { type: "relay.forward", toNodeId: "node-2", packet: samplePacket },
    ];
    for (const frame of clientFrames) {
      expect(ClientToServerFrameSchema.parse(frame).type).toBe(frame.type);
    }

    const serverFrames = [
      { type: "pong" },
      { type: "node.registered", node: sampleNode, relayEnabled: true },
      {
        type: "node.registered",
        node: sampleNode,
        relayEnabled: false,
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          {
            urls: ["turn:turn.example.com:3478", "turns:turn.example.com:5349"],
            username: "agent",
            credential: "secret",
          },
        ],
      },
      { type: "presence.update", node: sampleNode },
      { type: "room.message", message: sampleRoomMessage },
      {
        type: "inbox.mention",
        item: sampleInboxItem,
        message: sampleRoomMessage,
      },
      {
        type: "room.loop_broken",
        roomId: "room-1",
        hopChainId: "chain-1",
        hopCount: 5,
        maxAgentHops: 5,
        message: { ...sampleRoomMessage, loopBroken: true },
      },
      {
        type: "signal.deliver",
        fromNodeId: "node-1",
        fromHandle: "coder",
        signalType: "direct_probe",
        payload: { directUrl: "https://coder.example" },
      },
      {
        type: "relay.deliver",
        fromNodeId: "node-1",
        fromHandle: "coder",
        packet: samplePacket,
      },
      { type: "settings.update", relayEnabled: false },
      { type: "error", code: "RELAY_DISABLED", message: "Relay disabled" },
    ];
    for (const frame of serverFrames) {
      expect(ServerToClientFrameSchema.parse(frame).type).toBe(frame.type);
    }

    expect(() =>
      ClientToServerFrameSchema.parse({ type: "unknown.frame" }),
    ).toThrow();
    expect(() =>
      ServerToClientFrameSchema.parse({ type: "unknown.frame" }),
    ).toThrow();
  });

  it("validates IceServerConfigSchema and node.registered iceServers", () => {
    const stunOnly = IceServerConfigSchema.parse({
      urls: "stun:stun.example.com:3478",
    });
    expect(stunOnly).toEqual({ urls: "stun:stun.example.com:3478" });

    const turnWithAuth = IceServerConfigSchema.parse({
      urls: ["turn:turn1.example.com:3478", "turns:turn2.example.com:5349"],
      username: "user",
      credential: "pass",
    });
    expect(turnWithAuth.urls).toHaveLength(2);
    expect(turnWithAuth.username).toBe("user");
    expect(turnWithAuth.credential).toBe("pass");

    expect(() => IceServerConfigSchema.parse({ urls: 123 })).toThrow();
    expect(() => IceServerConfigSchema.parse({})).toThrow();

    const withoutIce = ServerToClientFrameSchema.parse({
      type: "node.registered",
      node: sampleNode,
      relayEnabled: true,
    });
    expect(withoutIce.type).toBe("node.registered");
    if (withoutIce.type === "node.registered") {
      expect(withoutIce.iceServers).toBeUndefined();
    }

    const withIce = ServerToClientFrameSchema.parse({
      type: "node.registered",
      node: sampleNode,
      relayEnabled: false,
      iceServers: [stunOnly, turnWithAuth],
    });
    expect(withIce.type).toBe("node.registered");
    if (withIce.type === "node.registered") {
      expect(withIce.iceServers).toEqual([stunOnly, turnWithAuth]);
    }
  });
});
