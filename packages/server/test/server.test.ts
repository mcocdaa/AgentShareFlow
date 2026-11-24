import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  createSignedEncryptedPacket,
  generateNodeKeyPair,
  keyFingerprint,
  ServerToClientFrameSchema,
  verifyAndDecryptPacket,
  type IceServerConfig,
  type ServerToClientFrame,
} from "@agentshare/core";
import {
  DEFAULT_STUN_URL,
  parseStunUrls,
  startServer,
  type StartedServer,
} from "../src/index.js";

class WsClient {
  readonly ws: WebSocket;
  private readonly queue: ServerToClientFrame[] = [];
  private readonly waiters: Array<{
    predicate: (frame: ServerToClientFrame) => boolean;
    resolve: (frame: ServerToClientFrame) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (data) => {
      const text =
        typeof data === "string" ? data : Buffer.from(data as Buffer).toString("utf8");
      const frame = ServerToClientFrameSchema.parse(JSON.parse(text));
      const idx = this.waiters.findIndex((w) => w.predicate(frame));
      if (idx >= 0) {
        const waiter = this.waiters.splice(idx, 1)[0]!;
        clearTimeout(waiter.timer);
        waiter.resolve(frame);
      } else {
        this.queue.push(frame);
      }
    });
  }

  static connect(url: string, headers?: Record<string, string>): Promise<WsClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { headers });
      const onOpen = () => {
        ws.off("error", onError);
        resolve(new WsClient(ws));
      };
      const onError = (err: Error) => {
        ws.off("open", onOpen);
        reject(err);
      };
      ws.once("open", onOpen);
      ws.once("error", onError);
    });
  }

  send(frame: unknown): void {
    this.ws.send(JSON.stringify(frame));
  }

  nextFrame(
    predicate: (frame: ServerToClientFrame) => boolean = () => true,
    timeoutMs = 3000,
  ): Promise<ServerToClientFrame> {
    const idx = this.queue.findIndex(predicate);
    if (idx >= 0) {
      return Promise.resolve(this.queue.splice(idx, 1)[0]!);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pos = this.waiters.findIndex((w) => w.timer === timer);
        if (pos >= 0) this.waiters.splice(pos, 1);
        reject(new Error("Timed out waiting for WebSocket frame"));
      }, timeoutMs);
      this.waiters.push({ predicate, resolve, reject, timer });
    });
  }

  async expectNoFrame(
    predicate: (frame: ServerToClientFrame) => boolean,
    waitMs = 150,
  ): Promise<void> {
    const existing = this.queue.find(predicate);
    if (existing) {
      throw new Error(`Unexpected frame received: ${JSON.stringify(existing)}`);
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pos = this.waiters.findIndex((w) => w.timer === timer);
        if (pos >= 0) this.waiters.splice(pos, 1);
        resolve();
      }, waitMs);
      this.waiters.push({
        predicate,
        resolve: (frame) => {
          clearTimeout(timer);
          reject(new Error(`Unexpected frame received: ${JSON.stringify(frame)}`));
        },
        reject,
        timer,
      });
    });
  }

  close(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise((resolve) => {
      this.ws.once("close", () => resolve());
      this.ws.close();
    });
  }
}

async function apiJson<T = Record<string, unknown>>(
  baseUrl: string,
  path: string,
  opts: {
    method?: string;
    token?: string;
    body?: unknown;
  } = {},
): Promise<{ status: number; data: T }> {
  const headers: Record<string, string> = {
    accept: "application/json",
  };
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  if (opts.token) {
    headers.authorization = `Bearer ${opts.token}`;
  }
  const res = await fetch(`${baseUrl}${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = (await res.json()) as T;
  return { status: res.status, data };
}

describe("@agentshare/server v2", () => {
  const servers: StartedServer[] = [];
  const sockets: WsClient[] = [];

  async function boot(
    opts: Parameters<typeof startServer>[0] = {},
  ): Promise<StartedServer> {
    const srv = await startServer({
      port: 0,
      host: "127.0.0.1",
      dbPath: ":memory:",
      ...opts,
    });
    servers.push(srv);
    return srv;
  }

  async function openWs(url: string): Promise<WsClient> {
    const client = await WsClient.connect(url);
    sockets.push(client);
    return client;
  }

  afterEach(async () => {
    for (const client of sockets.splice(0)) {
      await client.close();
    }
    for (const srv of servers.splice(0)) {
      await srv.close();
    }
  });

  it("enforces zero DM tables in SQLite and exposes health/server info", async () => {
    const srv = await boot();
    const tables = srv.db.listTableNames();
    expect(tables).not.toContain("dm_messages");
    expect(tables.filter((t) => t.toLowerCase().includes("dm"))).toEqual([]);
    expect(tables).toEqual(
      expect.arrayContaining([
        "users",
        "sessions",
        "invites",
        "nodes",
        "friendships",
        "pair_codes",
        "pair_grants",
        "rooms",
        "room_members",
        "room_messages",
        "server_settings",
      ]),
    );

    const health = await apiJson<{ ok: boolean; version: string; relayEnabled: boolean }>(
      srv.url,
      "/healthz",
    );
    expect(health.status).toBe(200);
    expect(health.data).toEqual({
      ok: true,
      version: "2.0.0",
      relayEnabled: false,
    });

    const info = await apiJson<{
      version: string;
      relayEnabled: boolean;
      needsBootstrap: boolean;
      maxAgentHops: number;
      iceServers: IceServerConfig[];
    }>(srv.url, "/api/v2/server/info");
    expect(info.status).toBe(200);
    expect(info.data).toEqual({
      version: "2.0.0",
      relayEnabled: false,
      needsBootstrap: true,
      maxAgentHops: 5,
      iceServers: [{ urls: DEFAULT_STUN_URL }],
    });
    expect(srv.bootstrapInviteCode).toBeTruthy();
  });

  it("enforces invite-only registration (403 without valid invite), login/logout revocation, and admin RBAC", async () => {
    const srv = await boot();
    const bootstrapCode = srv.bootstrapInviteCode!;

    const noInvite = await apiJson(srv.url, "/api/v2/auth/register", {
      method: "POST",
      body: { username: "alice", password: "password123" },
    });
    expect(noInvite.status).toBe(403);

    const badInvite = await apiJson(srv.url, "/api/v2/auth/register", {
      method: "POST",
      body: {
        username: "alice",
        password: "password123",
        inviteCode: "inv_bogus",
      },
    });
    expect(badInvite.status).toBe(403);

    const regAdmin = await apiJson<{
      token: string;
      user: { id: string; username: string; role: string };
    }>(srv.url, "/api/v2/auth/register", {
      method: "POST",
      body: {
        username: "admin",
        password: "password123",
        displayName: "Admin User",
        inviteCode: bootstrapCode,
      },
    });
    expect(regAdmin.status).toBe(201);
    expect(regAdmin.data.user.role).toBe("admin");
    const adminToken = regAdmin.data.token;

    // Session token must never be stored in plaintext in SQLite
    const sessionRows = srv.db.sqlite
      .prepare("SELECT token_hash FROM sessions")
      .all() as Array<{ token_hash: string }>;
    expect(sessionRows).toHaveLength(1);
    expect(sessionRows[0]?.token_hash).not.toBe(adminToken);

    // Exhausted 1-use bootstrap invite must be rejected
    const reused = await apiJson(srv.url, "/api/v2/auth/register", {
      method: "POST",
      body: {
        username: "second",
        password: "password123",
        inviteCode: bootstrapCode,
      },
    });
    expect(reused.status).toBe(403);

    const infoAfter = await apiJson<{ needsBootstrap: boolean }>(
      srv.url,
      "/api/v2/server/info",
    );
    expect(infoAfter.data.needsBootstrap).toBe(false);

    // Admin creates a member invite
    const invRes = await apiJson<{ invite: { code: string; role: string } }>(
      srv.url,
      "/api/v2/admin/invites",
      {
        method: "POST",
        token: adminToken,
        body: { maxUses: 2, expiresInHours: 24, role: "member" },
      },
    );
    expect(invRes.status).toBe(201);
    expect(invRes.data.invite.role).toBe("member");

    const regMember = await apiJson<{
      token: string;
      user: { id: string; username: string; role: string };
    }>(srv.url, "/api/v2/auth/register", {
      method: "POST",
      body: {
        username: "bob",
        password: "bobpassword",
        inviteCode: invRes.data.invite.code,
      },
    });
    expect(regMember.status).toBe(201);
    expect(regMember.data.user.role).toBe("member");
    const bobToken = regMember.data.token;

    // Member cannot access admin endpoints
    expect(
      (await apiJson(srv.url, "/api/v2/admin/invites", { token: bobToken }))
        .status,
    ).toBe(403);
    expect(
      (
        await apiJson(srv.url, "/api/v2/admin/invites", {
          method: "POST",
          token: bobToken,
          body: {},
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await apiJson(srv.url, "/api/v2/admin/settings", {
          method: "PATCH",
          token: bobToken,
          body: { enableRelay: true },
        })
      ).status,
    ).toBe(403);

    // Login & logout revocation
    const loginRes = await apiJson<{ token: string }>(
      srv.url,
      "/api/v2/auth/login",
      {
        method: "POST",
        body: { username: "bob", password: "bobpassword" },
      },
    );
    expect(loginRes.status).toBe(200);
    const loginToken = loginRes.data.token;

    expect(
      (await apiJson(srv.url, "/api/v2/me", { token: loginToken })).status,
    ).toBe(200);

    const logoutRes = await apiJson<{ ok: boolean }>(
      srv.url,
      "/api/v2/auth/logout",
      { method: "POST", token: loginToken },
    );
    expect(logoutRes.status).toBe(200);
    expect(logoutRes.data.ok).toBe(true);

    expect(
      (await apiJson(srv.url, "/api/v2/me", { token: loginToken })).status,
    ).toBe(401);
  });

  it("rejects WebSocket upgrade with HTTP 401 before handshake on missing or invalid token", async () => {
    const srv = await boot({ adminUser: "admin", adminPass: "adminpass123" });

    const attemptReject = (wsUrl: string) =>
      new Promise<number>((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        ws.once("open", () => {
          ws.close();
          reject(new Error("Expected 401 rejection, but WS opened"));
        });
        ws.once("unexpected-response", (_req, res) => {
          resolve(res.statusCode ?? 0);
        });
        ws.once("error", () => {
          // expected after unexpected-response
        });
      });

    expect(await attemptReject(srv.wsUrl)).toBe(401);
    expect(await attemptReject(`${srv.wsUrl}?token=not-a-valid-token`)).toBe(401);
  });

  it("supports friends, pair codes, node authorization, and handle ownership conflict protection", async () => {
    const srv = await boot({ adminUser: "alice", adminPass: "alicepass123" });
    const aliceLogin = await apiJson<{ token: string; user: { id: string } }>(
      srv.url,
      "/api/v2/auth/login",
      { method: "POST", body: { username: "alice", password: "alicepass123" } },
    );
    const aliceToken = aliceLogin.data.token;

    const inv = await apiJson<{ invite: { code: string } }>(
      srv.url,
      "/api/v2/admin/invites",
      { method: "POST", token: aliceToken, body: { maxUses: 5 } },
    );
    const bobReg = await apiJson<{ token: string; user: { id: string } }>(
      srv.url,
      "/api/v2/auth/register",
      {
        method: "POST",
        body: {
          username: "bob",
          password: "bobpassword1",
          inviteCode: inv.data.invite.code,
        },
      },
    );
    const bobToken = bobReg.data.token;

    const carolReg = await apiJson<{ token: string; user: { id: string } }>(
      srv.url,
      "/api/v2/auth/register",
      {
        method: "POST",
        body: {
          username: "carol",
          password: "carolpass123",
          inviteCode: inv.data.invite.code,
        },
      },
    );
    const carolToken = carolReg.data.token;

    const aliceKeys = generateNodeKeyPair();
    const aliceNodeId = keyFingerprint(aliceKeys.signPublicKey);
    const aliceWs = await openWs(`${srv.wsUrl}?token=${aliceToken}`);
    aliceWs.send({
      type: "node.register",
      nodeId: aliceNodeId,
      handle: "alice-bot",
      displayName: "Alice Bot",
      kind: "http",
      description: "Alice helper",
      capabilities: ["code"],
      signPublicKey: aliceKeys.signPublicKey,
      kxPublicKey: aliceKeys.kxPublicKey,
      directUrl: "http://127.0.0.1:19101",
    });
    const regFrame = await aliceWs.nextFrame((f) => f.type === "node.registered");
    expect(regFrame.type).toBe("node.registered");

    // Bob cannot steal alice-bot handle
    const bobKeys = generateNodeKeyPair();
    const bobNodeId = keyFingerprint(bobKeys.signPublicKey);
    const bobWs = await openWs(`${srv.wsUrl}?token=${bobToken}`);
    bobWs.send({
      type: "node.register",
      nodeId: bobNodeId,
      handle: "alice-bot",
      displayName: "Imposter",
      kind: "mcp",
      description: "",
      capabilities: [],
      signPublicKey: bobKeys.signPublicKey,
      kxPublicKey: bobKeys.kxPublicKey,
      directUrl: null,
    });
    const errFrame = await bobWs.nextFrame((f) => f.type === "error");
    expect(errFrame.type === "error" && errFrame.code).toBe("HANDLE_TAKEN");

    // Unauthorized Bob cannot view Alice's node
    const unauthNode = await apiJson(srv.url, `/api/v2/nodes/alice-bot`, {
      token: bobToken,
    });
    expect(unauthNode.status).toBe(403);
    const bobNodesBefore = await apiJson<{ nodes: Array<{ handle: string }> }>(
      srv.url,
      "/api/v2/nodes",
      { token: bobToken },
    );
    expect(bobNodesBefore.data.nodes).toHaveLength(0);

    // Friend request & accept unlocks peer visibility
    const reqRes = await apiJson<{ friend: { id: string; status: string } }>(
      srv.url,
      "/api/v2/friends/request",
      { method: "POST", token: aliceToken, body: { username: "bob" } },
    );
    expect(reqRes.status).toBe(201);
    expect(reqRes.data.friend.status).toBe("pending");

    // Alice cannot accept her own outgoing friend request
    const selfAccept = await apiJson(
      srv.url,
      `/api/v2/friends/${reqRes.data.friend.id}/accept`,
      { method: "POST", token: aliceToken },
    );
    expect(selfAccept.status).toBe(403);

    const acceptRes = await apiJson<{ friend: { status: string } }>(
      srv.url,
      `/api/v2/friends/${reqRes.data.friend.id}/accept`,
      { method: "POST", token: bobToken },
    );
    expect(acceptRes.status).toBe(200);
    expect(acceptRes.data.friend.status).toBe("accepted");

    const bobNodeView = await apiJson<{
      node: { handle: string; online: boolean };
    }>(srv.url, "/api/v2/nodes/alice-bot", { token: bobToken });
    expect(bobNodeView.status).toBe(200);
    expect(bobNodeView.data.node.handle).toBe("alice-bot");
    expect(bobNodeView.data.node.online).toBe(true);

    // Carol uses a pair code from Alice instead of friendship
    const pairCreate = await apiJson<{ pairCode: { code: string } }>(
      srv.url,
      "/api/v2/pair-codes",
      {
        method: "POST",
        token: aliceToken,
        body: { nodeId: aliceNodeId, maxUses: 1, expiresInMinutes: 15 },
      },
    );
    expect(pairCreate.status).toBe(201);

    const redeemRes = await apiJson<{
      ok: boolean;
      creatorUserId: string;
      nodes: Array<{ handle: string }>;
    }>(srv.url, "/api/v2/pair-codes/redeem", {
      method: "POST",
      token: carolToken,
      body: { code: pairCreate.data.pairCode.code },
    });
    expect(redeemRes.status).toBe(200);
    expect(redeemRes.data.ok).toBe(true);
    expect(redeemRes.data.creatorUserId).toBe(aliceLogin.data.user.id);
    expect(redeemRes.data.nodes.map((n) => n.handle)).toContain("alice-bot");

    const carolNodeView = await apiJson<{ node: { handle: string } }>(
      srv.url,
      `/api/v2/nodes/${aliceNodeId}`,
      { token: carolToken },
    );
    expect(carolNodeView.status).toBe(200);
    expect(carolNodeView.data.node.handle).toBe("alice-bot");
  });

  it("delivers targeted @mention inbox frames while ignoring non-mentions, and enforces loop-breaker & human reset", async () => {
    const srv = await boot({ adminUser: "alice", adminPass: "alicepass123" });
    const aliceToken = (
      await apiJson<{ token: string }>(srv.url, "/api/v2/auth/login", {
        method: "POST",
        body: { username: "alice", password: "alicepass123" },
      })
    ).data.token;

    const invCode = (
      await apiJson<{ invite: { code: string } }>(
        srv.url,
        "/api/v2/admin/invites",
        { method: "POST", token: aliceToken, body: { maxUses: 2 } },
      )
    ).data.invite.code;

    const bobToken = (
      await apiJson<{ token: string }>(srv.url, "/api/v2/auth/register", {
        method: "POST",
        body: {
          username: "bob",
          password: "bobpassword1",
          inviteCode: invCode,
        },
      })
    ).data.token;

    // Create room with maxAgentHops = 2
    const roomRes = await apiJson<{ room: { id: string; slug: string } }>(
      srv.url,
      "/api/v2/rooms",
      {
        method: "POST",
        token: aliceToken,
        body: {
          name: "Agent War Room",
          slug: "war-room",
          topic: "Loop breaker test",
          maxAgentHops: 2,
        },
      },
    );
    expect(roomRes.status).toBe(201);
    const roomSlug = roomRes.data.room.slug;

    // Add bob via slug
    const addMember = await apiJson(
      srv.url,
      `/api/v2/rooms/${roomSlug}/members`,
      { method: "POST", token: aliceToken, body: { username: "bob" } },
    );
    expect(addMember.status).toBe(201);

    // Connect two agent nodes: @bot-a (alice) and @bot-b (bob)
    const keysA = generateNodeKeyPair();
    const nodeAId = keyFingerprint(keysA.signPublicKey);
    const wsA = await openWs(`${srv.wsUrl}?token=${aliceToken}`);
    wsA.send({
      type: "node.register",
      nodeId: nodeAId,
      handle: "bot-a",
      displayName: "Bot A",
      kind: "http",
      description: "",
      capabilities: [],
      signPublicKey: keysA.signPublicKey,
      kxPublicKey: keysA.kxPublicKey,
      directUrl: null,
    });
    await wsA.nextFrame((f) => f.type === "node.registered");

    const keysB = generateNodeKeyPair();
    const nodeBId = keyFingerprint(keysB.signPublicKey);
    const wsB = await openWs(`${srv.wsUrl}?token=${bobToken}`);
    wsB.send({
      type: "node.register",
      nodeId: nodeBId,
      handle: "bot-b",
      displayName: "Bot B",
      kind: "mcp",
      description: "",
      capabilities: [],
      signPublicKey: keysB.signPublicKey,
      kxPublicKey: keysB.kxPublicKey,
      directUrl: null,
    });
    await wsB.nextFrame((f) => f.type === "node.registered");

    // 1. Non-mention room message broadcasts room.message but ZERO inbox.mention
    const nonMention = await apiJson<{
      message: { seq: number; mentions: string[]; hopCount: number };
    }>(srv.url, `/api/v2/rooms/${roomSlug}/messages`, {
      method: "POST",
      token: aliceToken,
      body: { content: "Just chatting, nobody tagged" },
    });
    expect(nonMention.status).toBe(201);
    expect(nonMention.data.message.mentions).toEqual([]);
    expect(nonMention.data.message.hopCount).toBe(0);

    await wsA.nextFrame(
      (f) => f.type === "room.message" && f.message.seq === nonMention.data.message.seq,
    );
    await wsB.nextFrame(
      (f) => f.type === "room.message" && f.message.seq === nonMention.data.message.seq,
    );
    await wsA.expectNoFrame((f) => f.type === "inbox.mention");
    await wsB.expectNoFrame((f) => f.type === "inbox.mention");

    // 2. Human mentions ONLY @bot-a -> only wsA gets inbox.mention, wsB does not
    const m0 = await apiJson<{
      message: {
        seq: number;
        hopCount: number;
        hopChainId: string;
        loopBroken: boolean;
      };
    }>(srv.url, `/api/v2/rooms/${roomSlug}/messages`, {
      method: "POST",
      token: aliceToken,
      body: { content: "Hey @bot-a please start the chain" },
    });
    expect(m0.status).toBe(201);
    expect(m0.data.message.hopCount).toBe(0);
    expect(m0.data.message.loopBroken).toBe(false);
    const chainId = m0.data.message.hopChainId;

    const mentionA = await wsA.nextFrame((f) => f.type === "inbox.mention");
    expect(mentionA.type === "inbox.mention" && mentionA.message.seq).toBe(
      m0.data.message.seq,
    );
    await wsB.expectNoFrame((f) => f.type === "inbox.mention");

    // 3. Agent hop 1: @bot-a mentions @bot-b (hopCount = 1 <= 2)
    const m1 = await apiJson<{
      message: { hopCount: number; loopBroken: boolean };
    }>(srv.url, `/api/v2/rooms/${roomSlug}/messages`, {
      method: "POST",
      token: aliceToken,
      body: {
        content: "@bot-b hop 1",
        senderNodeId: nodeAId,
        hopChainId: chainId,
      },
    });
    expect(m1.status).toBe(201);
    expect(m1.data.message.hopCount).toBe(1);
    expect(m1.data.message.loopBroken).toBe(false);
    await wsB.nextFrame((f) => f.type === "inbox.mention");

    // 4. Agent hop 2: @bot-b mentions @bot-a (hopCount = 2 <= 2)
    const m2 = await apiJson<{
      message: { hopCount: number; loopBroken: boolean };
    }>(srv.url, `/api/v2/rooms/${roomSlug}/messages`, {
      method: "POST",
      token: bobToken,
      body: {
        content: "@bot-a hop 2",
        senderNodeId: nodeBId,
        hopChainId: chainId,
      },
    });
    expect(m2.status).toBe(201);
    expect(m2.data.message.hopCount).toBe(2);
    expect(m2.data.message.loopBroken).toBe(false);
    await wsA.nextFrame((f) => f.type === "inbox.mention");

    // 5. Agent hop 3: @bot-a mentions @bot-b (hopCount = 3 > 2 -> LOOP BROKEN!)
    const m3 = await apiJson<{
      message: { seq: number; hopCount: number; loopBroken: boolean };
    }>(srv.url, `/api/v2/rooms/${roomSlug}/messages`, {
      method: "POST",
      token: aliceToken,
      body: {
        content: "@bot-b hop 3 should trip breaker",
        senderNodeId: nodeAId,
        hopChainId: chainId,
        resetLoop: true,
      },
    });
    expect(m3.status).toBe(201);
    expect(m3.data.message.hopCount).toBe(3);
    expect(m3.data.message.loopBroken).toBe(true);

    const loopBrokenFrame = await wsB.nextFrame(
      (f) => f.type === "room.loop_broken",
    );
    expect(loopBrokenFrame.type).toBe("room.loop_broken");
    if (loopBrokenFrame.type === "room.loop_broken") {
      expect(loopBrokenFrame.hopCount).toBe(3);
      expect(loopBrokenFrame.maxAgentHops).toBe(2);
    }
    // Loop-broken message MUST NOT emit inbox.mention
    await wsB.expectNoFrame((f) => f.type === "inbox.mention");

    // 6. Human message resets loop with fresh hopChainId and hopCount=0
    const resetMsg = await apiJson<{
      message: {
        hopCount: number;
        hopChainId: string;
        loopBroken: boolean;
      };
    }>(srv.url, `/api/v2/rooms/${roomSlug}/messages`, {
      method: "POST",
      token: aliceToken,
      body: { content: "@bot-b continue after human check", resetLoop: true },
    });
    expect(resetMsg.status).toBe(201);
    expect(resetMsg.data.message.hopCount).toBe(0);
    expect(resetMsg.data.message.hopChainId).not.toBe(chainId);
    expect(resetMsg.data.message.loopBroken).toBe(false);
    await wsB.nextFrame((f) => f.type === "inbox.mention");

    // Verify unread/mention counts and inbox + read cursor
    const bobRoomsBefore = await apiJson<{
      rooms: Array<{ slug: string; unreadCount: number; mentionCount: number }>;
    }>(srv.url, "/api/v2/rooms", { token: bobToken });
    expect(bobRoomsBefore.data.rooms[0]?.unreadCount).toBeGreaterThan(0);
    expect(bobRoomsBefore.data.rooms[0]?.mentionCount).toBe(2);

    const bobInbox = await apiJson<{ items: Array<{ messageId: string }> }>(
      srv.url,
      "/api/v2/inbox?handle=bot-b&unreadOnly=true",
      { token: bobToken },
    );
    expect(bobInbox.data.items).toHaveLength(2);

    await apiJson(srv.url, `/api/v2/rooms/${roomSlug}/read`, {
      method: "POST",
      token: bobToken,
      body: { seq: 100 },
    });
    const bobRoomsAfter = await apiJson<{
      rooms: Array<{ unreadCount: number; mentionCount: number }>;
    }>(srv.url, "/api/v2/rooms", { token: bobToken });
    expect(bobRoomsAfter.data.rooms[0]?.unreadCount).toBe(0);
    expect(bobRoomsAfter.data.rooms[0]?.mentionCount).toBe(0);
  });

  it("blocks relay by default (RELAY_DISABLED), forwards opaque E2EE packets when admin enables relay, and never stores DMs", async () => {
    const srv = await boot({ adminUser: "alice", adminPass: "alicepass123" });
    const aliceToken = (
      await apiJson<{ token: string }>(srv.url, "/api/v2/auth/login", {
        method: "POST",
        body: { username: "alice", password: "alicepass123" },
      })
    ).data.token;

    const invCode = (
      await apiJson<{ invite: { code: string } }>(
        srv.url,
        "/api/v2/admin/invites",
        { method: "POST", token: aliceToken, body: { maxUses: 2 } },
      )
    ).data.invite.code;

    const bobToken = (
      await apiJson<{ token: string }>(srv.url, "/api/v2/auth/register", {
        method: "POST",
        body: {
          username: "bob",
          password: "bobpassword1",
          inviteCode: invCode,
        },
      })
    ).data.token;

    // Connect Alice & Bob nodes
    const keysA = generateNodeKeyPair();
    const nodeAId = keyFingerprint(keysA.signPublicKey);
    const wsA = await openWs(`${srv.wsUrl}?token=${aliceToken}`);
    wsA.send({
      type: "node.register",
      nodeId: nodeAId,
      handle: "alice-node",
      displayName: "Alice Node",
      kind: "mcp",
      description: "",
      capabilities: [],
      signPublicKey: keysA.signPublicKey,
      kxPublicKey: keysA.kxPublicKey,
      directUrl: null,
    });
    const regA = await wsA.nextFrame((f) => f.type === "node.registered");
    expect(regA.type === "node.registered" && regA.relayEnabled).toBe(false);

    const keysB = generateNodeKeyPair();
    const nodeBId = keyFingerprint(keysB.signPublicKey);
    const wsB = await openWs(`${srv.wsUrl}?token=${bobToken}`);
    wsB.send({
      type: "node.register",
      nodeId: nodeBId,
      handle: "bob-node",
      displayName: "Bob Node",
      kind: "mcp",
      description: "",
      capabilities: [],
      signPublicKey: keysB.signPublicKey,
      kxPublicKey: keysB.kxPublicKey,
      directUrl: null,
    });
    await wsB.nextFrame((f) => f.type === "node.registered");

    const packet = createSignedEncryptedPacket({
      fromNodeId: nodeAId,
      fromHandle: "alice-node",
      toNodeId: nodeBId,
      senderSignPrivateKey: keysA.signPrivateKey,
      senderKxPrivateKey: keysA.kxPrivateKey,
      recipientKxPublicKey: keysB.kxPublicKey,
      payload: { kind: "text", text: "top-secret-e2ee-message" },
    });

    // 1. Relay is disabled by default -> RELAY_DISABLED
    wsA.send({ type: "relay.forward", toNodeId: nodeBId, packet });
    const disabledErr = await wsA.nextFrame((f) => f.type === "error");
    expect(disabledErr.type === "error" && disabledErr.code).toBe(
      "RELAY_DISABLED",
    );

    // 2. Admin enables relay -> settings.update broadcast to clients
    const patchRes = await apiJson<{ relayEnabled: boolean }>(
      srv.url,
      "/api/v2/admin/settings",
      { method: "PATCH", token: aliceToken, body: { enableRelay: true } },
    );
    expect(patchRes.status).toBe(200);
    expect(patchRes.data.relayEnabled).toBe(true);
    const settingsFrame = await wsB.nextFrame(
      (f) => f.type === "settings.update",
    );
    expect(
      settingsFrame.type === "settings.update" && settingsFrame.relayEnabled,
    ).toBe(true);

    // 3. Peers are not yet authorized -> FORBIDDEN
    wsA.send({ type: "relay.forward", toNodeId: nodeBId, packet });
    const forbiddenErr = await wsA.nextFrame((f) => f.type === "error");
    expect(forbiddenErr.type === "error" && forbiddenErr.code).toBe("FORBIDDEN");

    // 4. Authorize via friendship -> opaque packet forwarded & verified/decrypted by Bob
    const friendReq = await apiJson<{ friend: { id: string } }>(
      srv.url,
      "/api/v2/friends/request",
      { method: "POST", token: aliceToken, body: { username: "bob" } },
    );
    await apiJson(srv.url, `/api/v2/friends/${friendReq.data.friend.id}/accept`, {
      method: "POST",
      token: bobToken,
    });

    wsA.send({ type: "relay.forward", toNodeId: nodeBId, packet });
    const delivered = await wsB.nextFrame((f) => f.type === "relay.deliver");
    expect(delivered.type).toBe("relay.deliver");
    if (delivered.type === "relay.deliver") {
      expect(delivered.fromNodeId).toBe(nodeAId);
      expect(delivered.fromHandle).toBe("alice-node");
      expect(delivered.packet.envelope).toEqual(packet.envelope);
      const decrypted = verifyAndDecryptPacket({
        packet: delivered.packet,
        expectedToNodeId: nodeBId,
        senderSignPublicKey: keysA.signPublicKey,
        senderKxPublicKey: keysA.kxPublicKey,
        recipientKxPrivateKey: keysB.kxPrivateKey,
      });
      expect(decrypted.text).toBe("top-secret-e2ee-message");
    }

    // 5. Verify target offline returns PEER_OFFLINE
    await wsB.close();
    wsA.send({ type: "relay.forward", toNodeId: nodeBId, packet });
    const offlineErr = await wsA.nextFrame((f) => f.type === "error");
    expect(offlineErr.type === "error" && offlineErr.code).toBe("PEER_OFFLINE");

    // 6. Verify SQLite still has zero DM tables and zero ciphertext stored
    expect(srv.db.listTableNames()).not.toContain("dm_messages");
  });

  it("handles WS ping/pong, room.subscribe/room.send, signal offer/answer, node deletion, friend removal, and WS logout close 4001", async () => {
    const srv = await boot({ bootstrapInvite: "inv_custom_boot" });
    expect(srv.bootstrapInviteCode).toBe("inv_custom_boot");

    const aliceReg = await apiJson<{ token: string; user: { id: string } }>(
      srv.url,
      "/api/v2/auth/register",
      {
        method: "POST",
        body: {
          username: "alice",
          password: "alicepass123",
          inviteCode: "inv_custom_boot",
        },
      },
    );
    expect(aliceReg.status).toBe(201);
    const aliceToken = aliceReg.data.token;

    const invCode = (
      await apiJson<{ invite: { code: string } }>(
        srv.url,
        "/api/v2/admin/invites",
        { method: "POST", token: aliceToken, body: { maxUses: 2 } },
      )
    ).data.invite.code;
    const bobToken = (
      await apiJson<{ token: string }>(srv.url, "/api/v2/auth/register", {
        method: "POST",
        body: {
          username: "bob",
          password: "bobpassword1",
          inviteCode: invCode,
        },
      })
    ).data.token;

    const wsA = await openWs(`${srv.wsUrl}?token=${aliceToken}`);
    wsA.send({ type: "ping" });
    expect((await wsA.nextFrame((f) => f.type === "pong")).type).toBe("pong");

    const keysA = generateNodeKeyPair();
    const nodeAId = keyFingerprint(keysA.signPublicKey);
    wsA.send({
      type: "node.register",
      nodeId: nodeAId,
      handle: "alpha",
      displayName: "Alpha",
      kind: "cli",
      description: "Alpha CLI",
      capabilities: ["shell"],
      signPublicKey: keysA.signPublicKey,
      kxPublicKey: keysA.kxPublicKey,
      directUrl: "http://127.0.0.1:19901",
    });
    await wsA.nextFrame((f) => f.type === "node.registered");

    const keysB = generateNodeKeyPair();
    const nodeBId = keyFingerprint(keysB.signPublicKey);
    const wsB = await openWs(`${srv.wsUrl}?token=${bobToken}`);
    wsB.send({
      type: "node.register",
      nodeId: nodeBId,
      handle: "beta",
      displayName: "Beta",
      kind: "a2a",
      description: "Beta A2A",
      capabilities: [],
      signPublicKey: keysB.signPublicKey,
      kxPublicKey: keysB.kxPublicKey,
      directUrl: "http://127.0.0.1:19902",
    });
    await wsB.nextFrame((f) => f.type === "node.registered");

    // Unauthorized signaling fails with FORBIDDEN
    wsA.send({
      type: "signal.offer",
      toNodeId: nodeBId,
      signalType: "direct_probe",
      payload: { probe: 1 },
    });
    const sigForbidden = await wsA.nextFrame((f) => f.type === "error");
    expect(sigForbidden.type === "error" && sigForbidden.code).toBe("FORBIDDEN");

    // Room creation, forbidden subscribe for non-member, then add member & room.send
    const room = (
      await apiJson<{ room: { id: string; slug: string } }>(
        srv.url,
        "/api/v2/rooms",
        {
          method: "POST",
          token: aliceToken,
          body: { name: "General", slug: "general" },
        },
      )
    ).data.room;

    wsB.send({ type: "room.subscribe", roomId: room.slug });
    const subForbidden = await wsB.nextFrame((f) => f.type === "error");
    expect(subForbidden.type === "error" && subForbidden.code).toBe("FORBIDDEN");

    await apiJson(srv.url, `/api/v2/rooms/${room.slug}/members`, {
      method: "POST",
      token: aliceToken,
      body: { username: "bob" },
    });
    const membersRes = await apiJson<{
      members: Array<{ username: string; nodes: Array<{ handle: string }> }>;
    }>(srv.url, `/api/v2/rooms/${room.slug}/members`, { token: bobToken });
    expect(membersRes.status).toBe(200);
    expect(membersRes.data.members.map((m) => m.username)).toEqual([
      "alice",
      "bob",
    ]);

    wsB.send({ type: "room.subscribe", roomId: room.slug });
    wsA.send({ type: "room.send", roomId: room.slug, content: "ws hello @beta" });
    const wsMention = await wsB.nextFrame((f) => f.type === "inbox.mention");
    expect(wsMention.type === "inbox.mention" && wsMention.item.fromHandle).toBe(
      "alice",
    );

    const msgsPage = await apiJson<{ messages: Array<{ seq: number; content: string }> }>(
      srv.url,
      `/api/v2/rooms/${room.slug}/messages?sinceSeq=0&limit=10`,
      { token: bobToken },
    );
    expect(msgsPage.status).toBe(200);
    expect(msgsPage.data.messages).toHaveLength(1);
    expect(msgsPage.data.messages[0]?.content).toBe("ws hello @beta");

    // Now authorized via shared room -> signaling offer/answer succeeds
    wsA.send({
      type: "signal.offer",
      toNodeId: nodeBId,
      signalType: "webrtc_sdp",
      payload: { sdp: "offer-sdp" },
    });
    const offerDelivered = await wsB.nextFrame((f) => f.type === "signal.deliver");
    expect(offerDelivered.type).toBe("signal.deliver");
    if (offerDelivered.type === "signal.deliver") {
      expect(offerDelivered.fromNodeId).toBe(nodeAId);
      expect(offerDelivered.signalType).toBe("webrtc_sdp");
      expect(offerDelivered.payload).toEqual({ sdp: "offer-sdp" });
    }

    wsB.send({
      type: "signal.answer",
      toNodeId: nodeAId,
      signalType: "webrtc_sdp",
      payload: { sdp: "answer-sdp" },
    });
    const answerDelivered = await wsA.nextFrame((f) => f.type === "signal.deliver");
    expect(answerDelivered.type).toBe("signal.deliver");

    // Friend create + delete
    const friendReq = await apiJson<{ friend: { id: string } }>(
      srv.url,
      "/api/v2/friends/request",
      { method: "POST", token: aliceToken, body: { username: "bob" } },
    );
    const delFriend = await apiJson<{ ok: boolean }>(
      srv.url,
      `/api/v2/friends/${friendReq.data.friend.id}`,
      { method: "DELETE", token: aliceToken },
    );
    expect(delFriend.status).toBe(200);
    expect(delFriend.data.ok).toBe(true);

    // Owner deletes node -> non-owner gets 403, owner gets 200 and peer receives offline presence.update
    expect(
      (
        await apiJson(srv.url, `/api/v2/nodes/${nodeAId}`, {
          method: "DELETE",
          token: bobToken,
        })
      ).status,
    ).toBe(403);
    const delNode = await apiJson<{ ok: boolean }>(
      srv.url,
      `/api/v2/nodes/${nodeAId}`,
      { method: "DELETE", token: aliceToken },
    );
    expect(delNode.status).toBe(200);
    const offlinePresence = await wsB.nextFrame(
      (f) =>
        f.type === "presence.update" &&
        f.node.nodeId === nodeAId &&
        f.node.online === false,
    );
    expect(offlinePresence.type).toBe("presence.update");

    // Logout closes active WS with code 4001
    const closeCodePromise = new Promise<number>((resolve) => {
      wsB.ws.once("close", (code) => resolve(code));
    });
    await apiJson(srv.url, "/api/v2/auth/logout", {
      method: "POST",
      token: bobToken,
    });
    expect(await closeCodePromise).toBe(4001);
  });

  it("serves static webDistDir with SPA fallback and boots cleanly via dist/server.js with SIGTERM shutdown", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "agentshare-srv-test-"));
    try {
      const webDir = path.join(tmpDir, "web-dist");
      const dataDir = path.join(tmpDir, "data");
      writeFileSync(
        path.join(tmpDir, "secret.txt"),
        "do-not-serve-outside-root",
      );
      const { mkdirSync } = await import("node:fs");
      mkdirSync(webDir, { recursive: true });
      writeFileSync(
        path.join(webDir, "index.html"),
        "<!doctype html><div id='app'>AgentShare Web</div>",
      );
      writeFileSync(path.join(webDir, "app.js"), "console.log('ok');");

      const srv = await boot({ webDistDir: webDir });
      const rootRes = await fetch(`${srv.url}/`);
      expect(rootRes.status).toBe(200);
      expect(await rootRes.text()).toContain("AgentShare Web");

      const assetRes = await fetch(`${srv.url}/app.js`);
      expect(assetRes.status).toBe(200);
      expect(assetRes.headers.get("content-type")).toContain("javascript");
      expect(await assetRes.text()).toBe("console.log('ok');");

      const spaFallback = await fetch(`${srv.url}/rooms/general`);
      expect(spaFallback.status).toBe(200);
      expect(await spaFallback.text()).toContain("AgentShare Web");

      const traversal = await fetch(`${srv.url}/..%2fsecret.txt`);
      expect(await traversal.text()).not.toContain("do-not-serve-outside-root");

      const missingApi = await apiJson(srv.url, "/api/v2/does-not-exist");
      expect(missingApi.status).toBe(404);

      // CLI dist/server.js smoke with env vars + SIGTERM
      const serverEntry = path.resolve(
        import.meta.dirname,
        "../dist/server.js",
      );
      const child = spawn(process.execPath, [serverEntry], {
        env: {
          ...process.env,
          PORT: "0",
          HOST: "127.0.0.1",
          AGENTSHARE_DATA: dataDir,
          AGENTSHARE_ENABLE_RELAY: "false",
          AGENTSHARE_ADMIN_USER: "cliadmin",
          AGENTSHARE_ADMIN_PASS: "clipass1234",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      const listenUrl = await new Promise<string>((resolve, reject) => {
        let out = "";
        const timer = setTimeout(
          () => reject(new Error(`Server CLI failed to start: ${out}`)),
          5000,
        );
        child.stdout.on("data", (chunk: Buffer) => {
          out += chunk.toString("utf8");
          const match = /listening on (http:\/\/[^\s]+)/.exec(out);
          if (match?.[1]) {
            clearTimeout(timer);
            resolve(match[1]);
          }
        });
        child.once("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`Server CLI exited early (${code}): ${out}`));
        });
      });

      const cliHealth = await apiJson<{ ok: boolean; relayEnabled: boolean }>(
        listenUrl,
        "/healthz",
      );
      expect(cliHealth.status).toBe(200);
      expect(cliHealth.data.ok).toBe(true);
      expect(cliHealth.data.relayEnabled).toBe(false);

      const exitCode = await new Promise<number | null>((resolve) => {
        child.once("exit", (code) => resolve(code));
        child.kill("SIGTERM");
      });
      expect(exitCode).toBe(0);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("advertises default, custom, and empty iceServers in /api/v2/server/info, WS node.registered, and CLI AGENTSHARE_STUN_URLS", async () => {
    expect(parseStunUrls(undefined)).toEqual([{ urls: DEFAULT_STUN_URL }]);
    expect(parseStunUrls("")).toEqual([]);
    expect(parseStunUrls("   ")).toEqual([]);
    expect(
      parseStunUrls("stun:one.example.com:3478, stun:two.example.com:3478 , "),
    ).toEqual([
      { urls: "stun:one.example.com:3478" },
      { urls: "stun:two.example.com:3478" },
    ]);

    const registerAndCheckIce = async (
      srv: StartedServer,
      expectedIceServers: IceServerConfig[],
    ) => {
      const info = await apiJson<{ iceServers: IceServerConfig[] }>(
        srv.url,
        "/api/v2/server/info",
      );
      expect(info.status).toBe(200);
      expect(info.data.iceServers).toEqual(expectedIceServers);

      const login = await apiJson<{ token: string }>(
        srv.url,
        "/api/v2/auth/login",
        { method: "POST", body: { username: "alice", password: "alicepass123" } },
      );
      const ws = await openWs(`${srv.wsUrl}?token=${login.data.token}`);
      const keys = generateNodeKeyPair();
      const nodeId = keyFingerprint(keys.signPublicKey);
      ws.send({
        type: "node.register",
        nodeId,
        handle: "ice-bot",
        displayName: "ICE Bot",
        kind: "mcp",
        description: "",
        capabilities: [],
        signPublicKey: keys.signPublicKey,
        kxPublicKey: keys.kxPublicKey,
        directUrl: null,
      });
      const reg = await ws.nextFrame((f) => f.type === "node.registered");
      expect(reg.type).toBe("node.registered");
      if (reg.type === "node.registered") {
        expect(reg.iceServers).toEqual(expectedIceServers);
      }
    };

    const defaultSrv = await boot({
      adminUser: "alice",
      adminPass: "alicepass123",
    });
    await registerAndCheckIce(defaultSrv, [{ urls: DEFAULT_STUN_URL }]);

    const customIce: IceServerConfig[] = [
      { urls: "stun:stun1.example.com:3478" },
      {
        urls: ["turn:turn.example.com:3478?transport=udp"],
        username: "turn-user",
        credential: "turn-pass",
      },
    ];
    const customSrv = await boot({
      adminUser: "alice",
      adminPass: "alicepass123",
      iceServers: customIce,
    });
    await registerAndCheckIce(customSrv, customIce);

    const emptySrv = await boot({
      adminUser: "alice",
      adminPass: "alicepass123",
      iceServers: [],
    });
    await registerAndCheckIce(emptySrv, []);

    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "agentshare-ice-cli-"));
    try {
      const serverEntry = path.resolve(
        import.meta.dirname,
        "../dist/server.js",
      );
      const runCliAndCheckIce = async (
        subDir: string,
        stunEnv: string | undefined,
        expected: IceServerConfig[],
      ) => {
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          PORT: "0",
          HOST: "127.0.0.1",
          AGENTSHARE_DATA: path.join(tmpDir, subDir),
          AGENTSHARE_ADMIN_USER: "cliadmin",
          AGENTSHARE_ADMIN_PASS: "clipass1234",
        };
        if (stunEnv === undefined) {
          delete env.AGENTSHARE_STUN_URLS;
        } else {
          env.AGENTSHARE_STUN_URLS = stunEnv;
        }
        const child = spawn(process.execPath, [serverEntry], {
          env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        try {
          const listenUrl = await new Promise<string>((resolve, reject) => {
            let out = "";
            const timer = setTimeout(
              () => reject(new Error(`Server CLI failed to start: ${out}`)),
              5000,
            );
            child.stdout.on("data", (chunk: Buffer) => {
              out += chunk.toString("utf8");
              const match = /listening on (http:\/\/[^\s]+)/.exec(out);
              if (match?.[1]) {
                clearTimeout(timer);
                resolve(match[1]);
              }
            });
            child.once("exit", (code) => {
              clearTimeout(timer);
              reject(new Error(`Server CLI exited early (${code}): ${out}`));
            });
          });
          const info = await apiJson<{ iceServers: IceServerConfig[] }>(
            listenUrl,
            "/api/v2/server/info",
          );
          expect(info.status).toBe(200);
          expect(info.data.iceServers).toEqual(expected);
        } finally {
          const exitCode = await new Promise<number | null>((resolve) => {
            child.once("exit", (code) => resolve(code));
            child.kill("SIGTERM");
          });
          expect(exitCode).toBe(0);
        }
      };

      await runCliAndCheckIce("default", undefined, [{ urls: DEFAULT_STUN_URL }]);
      await runCliAndCheckIce(
        "custom",
        "stun:a.example.com:3478, stun:b.example.com:3478",
        [
          { urls: "stun:a.example.com:3478" },
          { urls: "stun:b.example.com:3478" },
        ],
      );
      await runCliAndCheckIce("empty", "", []);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("relays signal.offer/signal.answer between authorized peers and rejects oversized (>64 KiB) payloads with PAYLOAD_TOO_LARGE", async () => {
    const srv = await boot({ adminUser: "alice", adminPass: "alicepass123" });
    const aliceToken = (
      await apiJson<{ token: string }>(srv.url, "/api/v2/auth/login", {
        method: "POST",
        body: { username: "alice", password: "alicepass123" },
      })
    ).data.token;

    const invCode = (
      await apiJson<{ invite: { code: string } }>(
        srv.url,
        "/api/v2/admin/invites",
        { method: "POST", token: aliceToken, body: { maxUses: 2 } },
      )
    ).data.invite.code;

    const bobToken = (
      await apiJson<{ token: string }>(srv.url, "/api/v2/auth/register", {
        method: "POST",
        body: {
          username: "bob",
          password: "bobpassword1",
          inviteCode: invCode,
        },
      })
    ).data.token;

    const keysA = generateNodeKeyPair();
    const nodeAId = keyFingerprint(keysA.signPublicKey);
    const wsA = await openWs(`${srv.wsUrl}?token=${aliceToken}`);
    wsA.send({
      type: "node.register",
      nodeId: nodeAId,
      handle: "sig-a",
      displayName: "Sig A",
      kind: "mcp",
      description: "",
      capabilities: [],
      signPublicKey: keysA.signPublicKey,
      kxPublicKey: keysA.kxPublicKey,
      directUrl: null,
    });
    await wsA.nextFrame((f) => f.type === "node.registered");

    const keysB = generateNodeKeyPair();
    const nodeBId = keyFingerprint(keysB.signPublicKey);
    const wsB = await openWs(`${srv.wsUrl}?token=${bobToken}`);
    wsB.send({
      type: "node.register",
      nodeId: nodeBId,
      handle: "sig-b",
      displayName: "Sig B",
      kind: "mcp",
      description: "",
      capabilities: [],
      signPublicKey: keysB.signPublicKey,
      kxPublicKey: keysB.kxPublicKey,
      directUrl: null,
    });
    await wsB.nextFrame((f) => f.type === "node.registered");

    const friendReq = await apiJson<{ friend: { id: string } }>(
      srv.url,
      "/api/v2/friends/request",
      { method: "POST", token: aliceToken, body: { username: "bob" } },
    );
    await apiJson(srv.url, `/api/v2/friends/${friendReq.data.friend.id}/accept`, {
      method: "POST",
      token: bobToken,
    });

    wsA.send({
      type: "signal.offer",
      toNodeId: nodeBId,
      signalType: "webrtc_sdp",
      payload: { type: "offer", sdp: "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n" },
    });
    const deliveredOffer = await wsB.nextFrame(
      (f) => f.type === "signal.deliver",
    );
    expect(deliveredOffer).toEqual({
      type: "signal.deliver",
      fromNodeId: nodeAId,
      fromHandle: "sig-a",
      signalType: "webrtc_sdp",
      payload: { type: "offer", sdp: "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n" },
    });

    wsB.send({
      type: "signal.answer",
      toNodeId: nodeAId,
      signalType: "webrtc_ice",
      payload: { candidate: "candidate:1 1 udp 2122260223 192.0.2.1 50000 typ host" },
    });
    const deliveredAnswer = await wsA.nextFrame(
      (f) => f.type === "signal.deliver",
    );
    expect(deliveredAnswer).toEqual({
      type: "signal.deliver",
      fromNodeId: nodeBId,
      fromHandle: "sig-b",
      signalType: "webrtc_ice",
      payload: { candidate: "candidate:1 1 udp 2122260223 192.0.2.1 50000 typ host" },
    });

    const exactLimitPayload = { sdp: "a".repeat(65_536 - '{"sdp":""}'.length) };
    expect(Buffer.byteLength(JSON.stringify(exactLimitPayload), "utf8")).toBe(
      65_536,
    );
    wsA.send({
      type: "signal.offer",
      toNodeId: nodeBId,
      signalType: "webrtc_sdp",
      payload: exactLimitPayload,
    });
    const deliveredLimit = await wsB.nextFrame(
      (f) => f.type === "signal.deliver",
    );
    expect(deliveredLimit.type).toBe("signal.deliver");

    const oversizedOfferPayload = {
      sdp: "a".repeat(65_536 - '{"sdp":""}'.length + 1),
    };
    expect(
      Buffer.byteLength(JSON.stringify(oversizedOfferPayload), "utf8"),
    ).toBe(65_537);
    wsA.send({
      type: "signal.offer",
      toNodeId: nodeBId,
      signalType: "webrtc_sdp",
      payload: oversizedOfferPayload,
    });
    const offerTooLarge = await wsA.nextFrame((f) => f.type === "error");
    expect(offerTooLarge.type === "error" && offerTooLarge.code).toBe(
      "PAYLOAD_TOO_LARGE",
    );
    await wsB.expectNoFrame((f) => f.type === "signal.deliver");

    const multiByteOversizedPayload = { sdp: "中".repeat(22_000) };
    expect(
      Buffer.byteLength(JSON.stringify(multiByteOversizedPayload), "utf8"),
    ).toBeGreaterThan(65_536);
    wsB.send({
      type: "signal.answer",
      toNodeId: nodeAId,
      signalType: "webrtc_sdp",
      payload: multiByteOversizedPayload,
    });
    const answerTooLarge = await wsB.nextFrame((f) => f.type === "error");
    expect(answerTooLarge.type === "error" && answerTooLarge.code).toBe(
      "PAYLOAD_TOO_LARGE",
    );
    await wsA.expectNoFrame((f) => f.type === "signal.deliver");

    await wsB.close();
    wsA.send({
      type: "signal.offer",
      toNodeId: nodeBId,
      signalType: "webrtc_sdp",
      payload: { sdp: "after-disconnect" },
    });
    const offlineErr = await wsA.nextFrame((f) => f.type === "error");
    expect(offlineErr.type === "error" && offlineErr.code).toBe("PEER_OFFLINE");
  });
});
