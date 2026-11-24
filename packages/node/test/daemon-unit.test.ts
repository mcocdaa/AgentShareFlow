import { mkdtempSync, rmSync, statSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { CliAgentAdapter, splitCommandLine } from "../src/adapters.js";
import {
  clearDaemonState,
  loadDaemonState,
  loadOrCreateIdentity,
  loadPolicy,
  loadSession,
  saveDaemonState,
  savePolicy,
  saveSession,
} from "../src/config.js";
import { AgentNodeDaemon } from "../src/daemon.js";
import { startDemoBotServer } from "../src/demo-bot.js";
import { LocalStore } from "../src/local-store.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentshare-node-unit-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("config & LocalStore", () => {
  it("persists identity with 0600 permissions, session, policy, and daemon state", () => {
    const home = makeTempDir();
    const id1 = loadOrCreateIdentity(home);
    const id2 = loadOrCreateIdentity(home);
    expect(id2).toEqual(id1);
    const mode = statSync(path.join(home, "identity.json")).mode & 0o777;
    expect(mode).toBe(0o600);

    saveSession(home, {
      serverUrl: "http://127.0.0.1:8787/",
      token: "tok-123",
      user: {
        id: "u1",
        username: "alice",
        displayName: "Alice",
        role: "admin",
        createdAt: 1000,
      },
    });
    expect(loadSession(home)?.serverUrl).toBe("http://127.0.0.1:8787");

    expect(loadPolicy(home)).toEqual({
      defaultAllow: true,
      defaultMode: "auto",
      defaultMaxRequestsPerHour: 60,
      rules: [],
    });
    savePolicy(home, {
      defaultAllow: false,
      defaultMode: "manual_approval",
      defaultMaxRequestsPerHour: 12,
      rules: [],
    });
    expect(loadPolicy(home).defaultMode).toBe("manual_approval");

    saveDaemonState(home, {
      localControlUrl: "http://127.0.0.1:9999",
      localControlToken: "secret",
      handle: "alice-bot",
      nodeId: id1.nodeId,
      directUrl: "http://127.0.0.1:9998",
      serverUrl: "http://127.0.0.1:8787",
    });
    expect(loadDaemonState(home)?.handle).toBe("alice-bot");
    clearDaemonState(home);
    expect(loadDaemonState(home)).toBeNull();
  });

  it("supports DM, inbox, and pending approval CRUD in local SQLite", () => {
    const store = new LocalStore(":memory:");
    store.insertDmMessage({
      id: "dm-1",
      peerNodeId: "n-bob",
      peerHandle: "bob-bot",
      direction: "in",
      content: "hello local",
      transport: "direct",
      encrypted: true,
      status: "pending_approval",
      createdAt: 100,
    });
    expect(store.listDmMessages({ peer: "@bob-bot" })).toHaveLength(1);
    store.updateDmStatus("dm-1", "delivered");
    expect(store.getDmMessage("dm-1")?.status).toBe("delivered");

    store.insertInboxItem({
      id: "in-1",
      kind: "dm",
      fromHandle: "bob-bot",
      fromNodeId: "n-bob",
      roomId: null,
      roomName: null,
      messageId: "dm-1",
      preview: "hello local",
      transport: "direct",
      createdAt: 100,
      read: false,
    });
    expect(store.countUnreadInbox()).toBe(1);
    store.markInboxRead(["in-1"]);
    expect(store.countUnreadInbox()).toBe(0);

    store.insertPendingApproval({
      id: "ap-1",
      kind: "dm",
      fromHandle: "bob-bot",
      fromNodeId: "n-bob",
      roomId: null,
      messageId: "dm-1",
      content: "hello local",
      hopChainId: null,
      status: "pending",
      createdAt: 100,
    });
    expect(store.listPendingApprovals("pending")).toHaveLength(1);
    expect(store.updatePendingApprovalStatus("ap-1", "approved")).toBe(true);
    expect(store.updatePendingApprovalStatus("ap-1", "rejected")).toBe(false);
    store.close();
  });
});

describe("CliAgentAdapter & startDemoBotServer", () => {
  it("runs CLI adapter with shell:false and respects stdin JSON + readOnlyDir cwd", async () => {
    const dir = makeTempDir();
    const parsed = splitCommandLine(`"${process.execPath}" -e "const fs=require('fs');const d=JSON.parse(fs.readFileSync(0,'utf8'));process.stdout.write(d.fromHandle+':'+d.text+':'+process.cwd());"`);
    const adapter = new CliAgentAdapter({
      command: parsed.command,
      args: parsed.args,
      timeoutMs: 5_000,
    });
    const out = await adapter.handleTurn({
      text: "hello; echo injected",
      fromHandle: "alice",
      readOnlyDir: dir,
    });
    expect(out).toBe(`alice:hello; echo injected:${dir}`);
  });

  it("replies with context and deterministic ping @handle in demo-bot", async () => {
    const bot = await startDemoBotServer({ host: "127.0.0.1", port: 0, name: "bot-a" });
    try {
      const res1 = await fetch(bot.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: "summarize please",
          from: "alice",
          context: [{ sender: "bob", content: "project deadline is Friday" }],
        }),
      });
      const data1 = (await res1.json()) as { reply: string };
      expect(data1.reply).toContain("project deadline is Friday");

      const res2 = await fetch(bot.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: "@bot-a ping @bot-b",
          from: "alice",
          context: [],
        }),
      });
      const data2 = (await res2.json()) as { reply: string };
      expect(data2.reply).toContain("@bot-b");
      expect(data2.reply).toContain("ping @bot-a");
    } finally {
      await bot.close();
    }
  });
});

describe("AgentNodeDaemon WebSocket auth failure guards", () => {
  it("stops reconnecting when server rejects /ws with HTTP 401 before upgrade", async () => {
    let upgradeCount = 0;
    const server = http.createServer();
    server.on("upgrade", (_req, socket) => {
      upgradeCount += 1;
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const { port } = server.address() as AddressInfo;

    const daemon = new AgentNodeDaemon({
      homeDir: makeTempDir(),
      serverUrl: `http://127.0.0.1:${port}`,
      token: "bad-token",
      handle: "test-bot",
      reconnectBaseMs: 20,
      reconnectMaxMs: 40,
    });

    try {
      await expect(daemon.start()).rejects.toThrow(/401/);
      await new Promise((r) => setTimeout(r, 120));
      expect(daemon.authStopped).toBe(true);
      expect(daemon.reconnectCount).toBe(0);
      expect(upgradeCount).toBe(1);
    } finally {
      await daemon.close();
      await new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections?.();
      });
    }
  });

  it("stops reconnecting when connected WS closes with code 4001", async () => {
    let connections = 0;
    const server = http.createServer((req, res) => {
      if (req.url === "/api/v2/rooms") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ rooms: [] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, (ws) => {
        connections += 1;
        ws.on("message", (raw) => {
          const msg = JSON.parse(raw.toString()) as { type: string; nodeId?: string; handle?: string };
          if (msg.type === "node.register") {
            ws.send(
              JSON.stringify({
                type: "node.registered",
                relayEnabled: false,
                node: {
                  nodeId: msg.nodeId,
                  ownerUserId: "u1",
                  ownerUsername: "alice",
                  handle: msg.handle,
                  displayName: "Test",
                  kind: "mcp",
                  description: "",
                  capabilities: [],
                  signPublicKey: "k",
                  kxPublicKey: "x",
                  directUrl: null,
                  online: true,
                  lastSeenAt: Date.now(),
                },
              }),
            );
            setTimeout(() => ws.close(4001, "revoked"), 30);
          }
        });
      });
    });

    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const { port } = server.address() as AddressInfo;

    const daemon = new AgentNodeDaemon({
      homeDir: makeTempDir(),
      serverUrl: `http://127.0.0.1:${port}`,
      token: "valid-then-revoked",
      handle: "test-bot",
      reconnectBaseMs: 20,
      reconnectMaxMs: 40,
    });

    try {
      await daemon.start();
      await new Promise((r) => setTimeout(r, 150));
      expect(daemon.authStopped).toBe(true);
      expect(daemon.online).toBe(false);
      expect(daemon.reconnectCount).toBe(0);
      expect(connections).toBe(1);
    } finally {
      await daemon.close();
      wss.close();
      await new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections?.();
      });
    }
  });
});
