import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TransportError } from "@agentshare/core";
import { startServer } from "@agentshare/server";
import { HttpAgentAdapter, McpPassiveAdapter } from "../src/adapters.js";
import { AgentNodeDaemon } from "../src/daemon.js";
import { startDemoBotServer, type StartedDemoBotServer } from "../src/demo-bot.js";
import { ServerApiClient } from "../src/server-client.js";

async function waitUntil<T>(
  fn: () => Promise<T | null | undefined | false> | T | null | undefined | false,
  timeoutMs = 5_000,
  intervalMs = 25,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = await fn();
    if (val) return val;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
}

describe("AgentShare v2 E2E: Rooms, Mentions, Direct P2P E2EE, Relay Fallback & Approvals", () => {
  let tmpDir: string;
  let serverDbPath: string;
  let server: Awaited<ReturnType<typeof startServer>>;
  let demoBotA: StartedDemoBotServer;
  let adminApi: ServerApiClient;
  let aliceApi: ServerApiClient;
  let bobApi: ServerApiClient;
  let daemonA: AgentNodeDaemon;
  let daemonB: AgentNodeDaemon;
  let daemonC: AgentNodeDaemon | null = null;
  let daemonGuarded: AgentNodeDaemon | null = null;
  let roomId: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "agentshare-e2e-"));
    serverDbPath = path.join(tmpDir, "server.db");

    server = await startServer({
      port: 0,
      host: "127.0.0.1",
      dbPath: serverDbPath,
      relayEnabled: false,
      adminUser: "admin",
      adminPass: "admin1234",
      maxAgentHops: 3,
    } as Parameters<typeof startServer>[0]);

    adminApi = new ServerApiClient({ serverUrl: server.url });
    const adminLogin = await adminApi.login({
      username: "admin",
      password: "admin1234",
    });
    adminApi.setToken(adminLogin.token);

    const { invite } = await adminApi.createInvite({ maxUses: 10 });

    const aliceClient = new ServerApiClient({ serverUrl: server.url });
    const aliceReg = await aliceClient.register({
      username: "alice",
      password: "password123",
      displayName: "Alice",
      inviteCode: invite.code,
    });
    aliceClient.setToken(aliceReg.token);
    aliceApi = aliceClient;

    const bobClient = new ServerApiClient({ serverUrl: server.url });
    const bobReg = await bobClient.register({
      username: "bob",
      password: "password123",
      displayName: "Bob",
      inviteCode: invite.code,
    });
    bobClient.setToken(bobReg.token);
    bobApi = bobClient;

    const { friend } = await aliceApi.requestFriend("bob");
    await bobApi.acceptFriend(friend.id);

    const { room } = await aliceApi.createRoom({
      name: "Lab",
      slug: "lab",
      topic: "Integration testing room",
      maxAgentHops: 3,
    });
    roomId = room.id;
    await aliceApi.addRoomMember(roomId, "bob");

    demoBotA = await startDemoBotServer({
      host: "127.0.0.1",
      port: 0,
      name: "bot-a",
    });

    daemonA = new AgentNodeDaemon({
      homeDir: path.join(tmpDir, "bot-a"),
      serverUrl: server.url,
      token: aliceReg.token,
      handle: "bot-a",
      displayName: "Bot A",
      adapter: new HttpAgentAdapter({
        mode: "http",
        endpoint: demoBotA.url,
        allowPrivate: true,
      }),
      bindHost: "127.0.0.1",
      port: 0,
      allowPrivate: true,
      iceServers: [],
      webrtcConnectTimeoutMs: 1_000,
    });
    await daemonA.start();
    await daemonA.subscribeRoom(roomId);

    daemonB = new AgentNodeDaemon({
      homeDir: path.join(tmpDir, "mcp-b"),
      serverUrl: server.url,
      token: bobReg.token,
      handle: "mcp-b",
      displayName: "MCP B",
      adapter: new McpPassiveAdapter(),
      bindHost: "127.0.0.1",
      port: 0,
      allowPrivate: true,
      iceServers: [],
    });
    await daemonB.start();
    await daemonB.subscribeRoom(roomId);
  }, 30_000);

  afterAll(async () => {
    await daemonGuarded?.close().catch(() => {});
    await daemonC?.close().catch(() => {});
    await daemonB?.close().catch(() => {});
    await daemonA?.close().catch(() => {});
    await demoBotA?.close().catch(() => {});
    await server?.close().catch(() => {});
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("1. ignores non-mention room messages without waking bots or creating red-dot inbox items", async () => {
    await bobApi.sendRoomMessage(roomId, {
      content: "casual background note: build v2 passed",
    });

    await new Promise((r) => setTimeout(r, 300));

    const { messages } = await aliceApi.listRoomMessages(roomId, { limit: 20 });
    expect(messages).toHaveLength(1);
    expect(daemonB.localStore.listInboxItems({ unreadOnly: true })).toHaveLength(0);
    expect(daemonA.localStore.listInboxItems({ unreadOnly: true })).toHaveLength(0);
  });

  it("2. wakes @bot-a on room @mention with recent room context", async () => {
    await bobApi.sendRoomMessage(roomId, {
      content: "hey @bot-a please confirm our background note",
    });

    const botReply = await waitUntil(async () => {
      const { messages } = await aliceApi.listRoomMessages(roomId, { limit: 20 });
      return messages.find((m) => m.senderHandle === "bot-a");
    });

    expect(botReply.senderType).toBe("agent");
    expect(botReply.content).toContain("build v2 passed");
  });

  it("3. wakes @mcp-b waitForMention immediately when mentioned in room", async () => {
    const waiting = daemonB.waitForMention(5);

    await aliceApi.sendRoomMessage(roomId, {
      content: "@mcp-b please review the latest logs",
    });

    const items = await waiting;
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items.some((i) => i.kind === "room_mention" && i.roomId === roomId)).toBe(true);
    daemonB.localStore.markInboxRead();
  });

  it("4. delivers Direct P2P E2EE DM with relayEnabled=false and stores zero DMs on server", async () => {
    const secretText = "direct-e2ee-secret-payload-991";
    const sendRes = await daemonB.sendDm("bot-a", secretText);
    expect(sendRes.transport).toBe("direct");
    expect(sendRes.message.encrypted).toBe(true);

    const botReceived = await waitUntil(() =>
      daemonA.localStore
        .listDmMessages({ peer: "mcp-b" })
        .find((m) => m.direction === "in" && m.content === secretText),
    );
    expect(botReceived.transport).toBe("direct");
    expect(botReceived.encrypted).toBe(true);

    // Active HTTP adapter on @bot-a replies back over Direct P2P.
    const autoReply = await waitUntil(() =>
      daemonB.localStore
        .listDmMessages({ peer: "bot-a" })
        .find((m) => m.direction === "in" && m.content.includes(secretText)),
    );
    expect(autoReply.transport).toBe("direct");

    // Verify zero DM tables exist in the server SQLite database.
    const db = new DatabaseSync(serverDbPath, { readOnly: true });
    try {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>;
      expect(tables.some((t) => t.name.toLowerCase().includes("dm"))).toBe(false);
    } finally {
      db.close();
    }
  });

  it("5. fails unreachable Direct DM when relay disabled, then succeeds via E2EE relay after admin enables relay", async () => {
    const bobLogin = await bobApi.login({ username: "bob", password: "password123" });
    daemonC = new AgentNodeDaemon({
      homeDir: path.join(tmpDir, "mcp-c"),
      serverUrl: server.url,
      token: bobLogin.token,
      handle: "mcp-c",
      displayName: "MCP C (Unreachable Direct)",
      adapter: new McpPassiveAdapter(),
      bindHost: "127.0.0.1",
      port: 0,
      advertiseUrl: "http://127.0.0.1:1",
      allowPrivate: true,
      enableWebRtc: false,
      iceServers: [],
    });
    await daemonC.start();

    let caughtErr: unknown;
    try {
      await daemonA.sendDm("mcp-c", "cannot deliver without relay");
    } catch (err) {
      caughtErr = err;
    }
    expect(caughtErr).toBeInstanceOf(TransportError);
    expect((caughtErr as TransportError).code).toBe("ALL_TRANSPORTS_FAILED");
    expect(
      (caughtErr as TransportError).attempts?.some(
        (a) => a.mode === "relay" && a.code === "RELAY_DISABLED",
      ),
    ).toBe(true);

    const updated = await adminApi.updateSettings({ enableRelay: true });
    expect(updated.relayEnabled).toBe(true);

    const relayText = "e2ee-over-encrypted-relay-777";
    const relaySend = await daemonA.sendDm("mcp-c", relayText);
    expect(relaySend.transport).toBe("relay");
    expect(relaySend.message.encrypted).toBe(true);

    const receivedOverRelay = await waitUntil(() =>
      daemonC?.localStore
        .listDmMessages({ peer: "bot-a" })
        .find((m) => m.direction === "in" && m.content === relayText),
    );
    expect(receivedOverRelay.transport).toBe("relay");
    expect(receivedOverRelay.encrypted).toBe(true);
  });

  it("6. holds inbound DM under manual_approval until explicitly approved via local control API", async () => {
    const aliceLogin = await aliceApi.login({ username: "alice", password: "password123" });
    daemonGuarded = new AgentNodeDaemon({
      homeDir: path.join(tmpDir, "guarded-bot"),
      serverUrl: server.url,
      token: aliceLogin.token,
      handle: "guarded-bot",
      displayName: "Guarded Bot",
      adapter: new HttpAgentAdapter({
        mode: "http",
        endpoint: demoBotA.url,
        allowPrivate: true,
      }),
      policy: {
        defaultAllow: true,
        defaultMode: "manual_approval",
        defaultMaxRequestsPerHour: 60,
        rules: [],
      },
      bindHost: "127.0.0.1",
      port: 0,
      allowPrivate: true,
    });
    await daemonGuarded.start();

    const promptText = "execute sensitive task 42";
    const sendRes = await daemonB.sendDm("guarded-bot", promptText);
    expect(sendRes.transport).toBe("direct");

    const pendingListRes = await fetch(
      `${daemonGuarded.localControlUrl}/local/approvals?status=pending`,
      {
        headers: {
          authorization: `Bearer ${daemonGuarded.localControlToken}`,
          origin: "http://localhost:5173",
        },
      },
    );
    expect(pendingListRes.status).toBe(200);
    expect(pendingListRes.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:5173",
    );
    const pendingData = (await pendingListRes.json()) as {
      approvals: Array<{ id: string; content: string; status: string }>;
    };
    expect(pendingData.approvals).toHaveLength(1);
    expect(pendingData.approvals[0]?.content).toBe(promptText);

    // No reply sent before approval.
    expect(
      daemonB.localStore
        .listDmMessages({ peer: "guarded-bot" })
        .filter((m) => m.direction === "in"),
    ).toHaveLength(0);

    const approvalId = pendingData.approvals[0]!.id;
    const approveRes = await fetch(
      `${daemonGuarded.localControlUrl}/local/approvals/${encodeURIComponent(approvalId)}/approve`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${daemonGuarded.localControlToken}`,
        },
      },
    );
    expect(approveRes.status).toBe(200);
    const approveBody = (await approveRes.json()) as { ok: boolean; reply: string | null };
    expect(approveBody.ok).toBe(true);
    expect(approveBody.reply).toContain(promptText);

    const replyOnSender = await waitUntil(() =>
      daemonB.localStore
        .listDmMessages({ peer: "guarded-bot" })
        .find((m) => m.direction === "in" && m.content.includes(promptText)),
    );
    expect(replyOnSender.encrypted).toBe(true);
  });

  it("7. falls back direct -> real WebRTC DataChannel -> optional E2EE relay with zero server DM rows", async () => {
    await adminApi.updateSettings({ enableRelay: false });

    const aliceLogin = await aliceApi.login({ username: "alice", password: "password123" });
    const bobLogin = await bobApi.login({ username: "bob", password: "password123" });

    await daemonA.close();
    daemonA = new AgentNodeDaemon({
      homeDir: path.join(tmpDir, "bot-a"),
      serverUrl: server.url,
      token: aliceLogin.token,
      handle: "bot-a",
      displayName: "Bot A (NAT / Unreachable Direct)",
      adapter: new McpPassiveAdapter(),
      bindHost: "127.0.0.1",
      port: 0,
      advertiseUrl: "http://127.0.0.1:1",
      allowPrivate: true,
      enableWebRtc: true,
      iceServers: [],
    });
    await daemonA.start();

    expect(daemonA.getStatus().webrtcEnabled).toBe(true);
    const statusRes = await fetch(`${daemonA.localControlUrl}/local/status`, {
      headers: { authorization: `Bearer ${daemonA.localControlToken}` },
    });
    expect(statusRes.status).toBe(200);
    const statusBody = (await statusRes.json()) as { webrtcEnabled: boolean };
    expect(statusBody.webrtcEnabled).toBe(true);

    const webrtcSecret = "webrtc-e2ee-secret-payload-303";
    const webrtcSend = await daemonB.sendDm("bot-a", webrtcSecret);
    expect(webrtcSend.transport).toBe("webrtc");
    expect(webrtcSend.message.transport).toBe("webrtc");
    expect(webrtcSend.message.encrypted).toBe(true);
    expect(
      webrtcSend.attempts.some((a) => a.mode === "direct" && !a.ok && a.code === "DIRECT_FAILED"),
    ).toBe(true);
    expect(webrtcSend.attempts.some((a) => a.mode === "webrtc" && a.ok)).toBe(true);

    const receivedOverWebRtc = await waitUntil(() =>
      daemonA.localStore
        .listDmMessages({ peer: "mcp-b" })
        .find((m) => m.direction === "in" && m.content === webrtcSecret),
    );
    expect(receivedOverWebRtc.transport).toBe("webrtc");
    expect(receivedOverWebRtc.encrypted).toBe(true);

    const sentStoredLocally = daemonB.localStore
      .listDmMessages({ peer: "bot-a" })
      .find((m) => m.direction === "out" && m.content === webrtcSecret);
    expect(sentStoredLocally?.transport).toBe("webrtc");

    const db = new DatabaseSync(serverDbPath, { readOnly: true });
    try {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>;
      expect(tables.some((t) => t.name.toLowerCase().includes("dm"))).toBe(false);
    } finally {
      db.close();
    }

    // Disabling WebRTC with unreachable directUrl fails while relay is disabled,
    // then falls back to E2EE relay once admin enables relay.
    await daemonB.close();
    daemonB = new AgentNodeDaemon({
      homeDir: path.join(tmpDir, "mcp-b"),
      serverUrl: server.url,
      token: bobLogin.token,
      handle: "mcp-b",
      displayName: "MCP B (WebRTC Disabled)",
      adapter: new McpPassiveAdapter(),
      bindHost: "127.0.0.1",
      port: 0,
      allowPrivate: true,
      enableWebRtc: false,
      iceServers: [],
    });
    await daemonB.start();
    expect(daemonB.getStatus().webrtcEnabled).toBe(false);

    let failedErr: unknown;
    try {
      await daemonB.sendDm("bot-a", "should-fail-without-webrtc-or-relay");
    } catch (err) {
      failedErr = err;
    }
    expect(failedErr).toBeInstanceOf(TransportError);
    expect((failedErr as TransportError).code).toBe("ALL_TRANSPORTS_FAILED");
    expect(
      (failedErr as TransportError).attempts?.some(
        (a) => a.mode === "direct" && a.code === "DIRECT_FAILED",
      ),
    ).toBe(true);
    expect(
      (failedErr as TransportError).attempts?.some(
        (a) => a.mode === "webrtc" && a.code === "WEBRTC_UNAVAILABLE",
      ),
    ).toBe(true);
    expect(
      (failedErr as TransportError).attempts?.some(
        (a) => a.mode === "relay" && a.code === "RELAY_DISABLED",
      ),
    ).toBe(true);

    const enabled = await adminApi.updateSettings({ enableRelay: true });
    expect(enabled.relayEnabled).toBe(true);

    const relayFallbackText = "relay-fallback-after-webrtc-disabled-404";
    const relaySend = await daemonB.sendDm("bot-a", relayFallbackText);
    expect(relaySend.transport).toBe("relay");
    expect(relaySend.message.transport).toBe("relay");
    expect(relaySend.message.encrypted).toBe(true);

    const receivedOverRelay = await waitUntil(() =>
      daemonA.localStore
        .listDmMessages({ peer: "mcp-b" })
        .find((m) => m.direction === "in" && m.content === relayFallbackText),
    );
    expect(receivedOverRelay.transport).toBe("relay");
    expect(receivedOverRelay.encrypted).toBe(true);
  }, 20_000);
});
