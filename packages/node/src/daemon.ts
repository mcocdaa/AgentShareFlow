import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import WebSocket from "ws";
import {
  createSignedEncryptedPacket,
  DirectHttpTransport,
  FallbackTransportRouter,
  P2pPacketSchema,
  RelayTransport,
  ServerToClientFrameSchema,
  TransportError,
  verifyAndDecryptPacket,
  WebRtcTransportStub,
  type ClientToServerFrame,
  type DmMessage,
  type DmPayload,
  type InboxItem,
  type NodePolicyConfig,
  type NodePresence,
  type P2pPacket,
  type RoomMessage,
  type ServerToClientFrame,
  type TransportAttempt,
  type TransportMode,
  type WebRtcTransportStub as _WebRtcStubType,
} from "@agentshare/core";
import { McpPassiveAdapter, type AgentAdapter } from "./adapters.js";
import {
  clearDaemonState,
  httpToWsUrl,
  loadOrCreateIdentity,
  loadPolicy,
  normalizeServerUrl,
  resolveHomeDir,
  saveDaemonState,
  type DaemonState,
  type NodeIdentity,
} from "./config.js";
import { LocalStore, type PendingApproval } from "./local-store.js";
import { PolicyGuard } from "./policy.js";
import { ServerApiClient } from "./server-client.js";

const MAX_HTTP_BODY_BYTES = 1_048_576;
const MAX_SEEN_NONCES = 50_000;
const LOCAL_ORIGIN_PATTERN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

export class DaemonHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "DaemonHttpError";
    this.status = status;
  }
}

export interface AgentNodeDaemonOptions {
  homeDir?: string;
  serverUrl: string;
  token: string;
  handle: string;
  displayName?: string;
  description?: string;
  capabilities?: string[];
  adapter?: AgentAdapter;
  policy?: NodePolicyConfig;
  policyPath?: string;
  bindHost?: string;
  port?: number;
  advertiseUrl?: string | null;
  localControlPort?: number;
  allowPrivate?: boolean;
  directTimeoutMs?: number;
  wsHeartbeatMs?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  onLog?: (message: string) => void;
}

export interface SendDmResult {
  message: DmMessage;
  transport: TransportMode;
  attempts: TransportAttempt[];
}

interface MentionWaiter {
  resolve: (items: InboxItem[]) => void;
  timer: NodeJS.Timeout;
}

function readBodyText(req: IncomingMessage, maxBytes = MAX_HTTP_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new DaemonHttpError(413, "Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (err) => {
      reject(err);
    });
  });
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const text = await readBodyText(req);
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new DaemonHttpError(400, "Invalid JSON request body");
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function constantTimeTokenEquals(actual: string, expected: string): boolean {
  const a = Buffer.from(actual, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function formatHostForUrl(host: string): string {
  if (host === "0.0.0.0" || host === "") return "127.0.0.1";
  if (host === "::") return "[::1]";
  if (host.includes(":") && !host.startsWith("[")) return `[${host}]`;
  return host;
}

function listenServer(server: Server, host: string, port: number): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Unexpected non-TCP server address"));
        return;
      }
      resolve(addr);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function closeServer(server: Server | null): Promise<void> {
  if (!server) return Promise.resolve();
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

export class AgentNodeDaemon {
  readonly homeDir: string;
  readonly serverUrl: string;
  readonly handle: string;
  readonly displayName: string;
  readonly description: string;
  readonly capabilities: string[];
  readonly adapter: AgentAdapter;
  readonly api: ServerApiClient;

  private readonly token: string;
  private readonly bindHost: string;
  private readonly port: number;
  private readonly advertiseUrlOption?: string | null;
  private readonly localControlPort: number;
  private readonly allowPrivate: boolean;
  private readonly directTimeoutMs: number;
  private readonly wsHeartbeatMs: number;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly onLog: (message: string) => void;

  private identity!: NodeIdentity;
  private store!: LocalStore;
  private policyGuard!: PolicyGuard;
  private router!: FallbackTransportRouter;
  private relayTransport!: RelayTransport;

  private p2pServer: Server | null = null;
  private localControlServer: Server | null = null;
  private ws: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;

  private _directUrl: string | null = null;
  private _localControlUrl = "";
  private _localControlToken = "";
  private _online = false;
  private _relayEnabled = false;
  private _ownerUsername: string | null = null;
  private _authStopped = false;
  private _reconnectCount = 0;
  private closing = false;
  private started = false;

  private readonly seenNonces = new Set<string>();
  private readonly peerCache = new Map<string, NodePresence>();
  private readonly roomSlugCache = new Map<string, string>();
  private readonly waiters = new Set<MentionWaiter>();
  private readonly backgroundTasks = new Set<Promise<void>>();

  constructor(options: AgentNodeDaemonOptions) {
    this.homeDir = resolveHomeDir(options.homeDir);
    this.serverUrl = normalizeServerUrl(options.serverUrl);
    this.token = options.token;
    this.handle = options.handle.trim().replace(/^@/, "").toLowerCase();
    this.displayName = options.displayName?.trim() || this.handle;
    this.description = options.description ?? "";
    this.capabilities = options.capabilities ? [...options.capabilities] : [];
    this.adapter = options.adapter ?? new McpPassiveAdapter();
    this.bindHost = options.bindHost ?? "127.0.0.1";
    this.port = options.port ?? 0;
    this.advertiseUrlOption = options.advertiseUrl;
    this.localControlPort = options.localControlPort ?? 0;
    this.allowPrivate = options.allowPrivate ?? false;
    this.directTimeoutMs = options.directTimeoutMs ?? 5_000;
    this.wsHeartbeatMs = options.wsHeartbeatMs ?? 25_000;
    this.reconnectBaseMs = options.reconnectBaseMs ?? 500;
    this.reconnectMaxMs = options.reconnectMaxMs ?? 15_000;
    this.onLog = options.onLog ?? (() => {});
    this.api = new ServerApiClient({ serverUrl: this.serverUrl, token: this.token });

    const policy = options.policy ?? loadPolicy(this.homeDir, options.policyPath);
    this.policyGuard = new PolicyGuard(policy);
  }

  get nodeId(): string {
    return this.identity.nodeId;
  }

  get directUrl(): string | null {
    return this._directUrl;
  }

  get localControlUrl(): string {
    return this._localControlUrl;
  }

  get localControlToken(): string {
    return this._localControlToken;
  }

  get online(): boolean {
    return this._online;
  }

  get relayEnabled(): boolean {
    return this._relayEnabled;
  }

  get authStopped(): boolean {
    return this._authStopped;
  }

  get reconnectCount(): number {
    return this._reconnectCount;
  }

  get localStore(): LocalStore {
    return this.store;
  }

  getStatus(): {
    nodeId: string;
    handle: string;
    directUrl: string | null;
    online: boolean;
    relayEnabled: boolean;
    serverUrl: string;
  } {
    return {
      nodeId: this.identity.nodeId,
      handle: this.handle,
      directUrl: this._directUrl,
      online: this._online,
      relayEnabled: this._relayEnabled,
      serverUrl: this.serverUrl,
    };
  }

  async start(): Promise<DaemonState> {
    if (this.started) {
      return this.buildDaemonState();
    }
    this.closing = false;
    this._authStopped = false;
    this.identity = loadOrCreateIdentity(this.homeDir);
    this.store = new LocalStore(path.join(this.homeDir, "local.db"));

    this.relayTransport = new RelayTransport({
      enabled: () => this._relayEnabled,
      forward: (toNodeId, packet) => this.forwardViaRelay(toNodeId, packet),
    });
    const webrtcStub: _WebRtcStubType = new WebRtcTransportStub();
    this.router = new FallbackTransportRouter({
      direct: new DirectHttpTransport({
        allowPrivate: this.allowPrivate,
        timeoutMs: this.directTimeoutMs,
      }),
      webrtc: webrtcStub,
      relay: this.relayTransport,
    });

    try {
      await this.startP2pServer();
      await this.startLocalControlServer();
      await this.connectWebSocketInitial();
    } catch (err) {
      await this.close();
      throw err;
    }

    this.started = true;
    const state = this.buildDaemonState();
    saveDaemonState(this.homeDir, state);
    return state;
  }

  private buildDaemonState(): DaemonState {
    return {
      localControlUrl: this._localControlUrl,
      localControlToken: this._localControlToken,
      handle: this.handle,
      nodeId: this.identity.nodeId,
      directUrl: this._directUrl,
      serverUrl: this.serverUrl,
      pid: process.pid,
      startedAt: Date.now(),
    };
  }

  private async startP2pServer(): Promise<void> {
    const server = http.createServer((req, res) => {
      void this.handleP2pRequest(req, res);
    });
    const addr = await listenServer(server, this.bindHost, this.port);
    this.p2pServer = server;

    if (this.advertiseUrlOption === undefined) {
      this._directUrl = `http://${formatHostForUrl(this.bindHost)}:${addr.port}`;
    } else if (this.advertiseUrlOption === null || this.advertiseUrlOption === "") {
      this._directUrl = null;
    } else {
      this._directUrl = this.advertiseUrlOption.replace(/\/+$/, "");
    }
  }

  private async startLocalControlServer(): Promise<void> {
    this._localControlToken = randomBytes(24).toString("base64url");
    const server = http.createServer((req, res) => {
      void this.handleLocalControlRequest(req, res);
    });
    const addr = await listenServer(server, "127.0.0.1", this.localControlPort);
    this.localControlServer = server;
    this._localControlUrl = `http://127.0.0.1:${addr.port}`;
  }

  private async handleP2pRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/p2p/v2/health") {
        sendJson(res, 200, {
          ok: true,
          nodeId: this.identity.nodeId,
          handle: this.handle,
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/p2p/v2/message") {
        const body = await readJsonBody(req);
        const parsed = P2pPacketSchema.safeParse(body);
        if (!parsed.success) {
          sendJson(res, 400, { error: "Invalid P2P packet format" });
          return;
        }
        const outcome = await this.handleInboundPacket(parsed.data, "direct");
        if (!outcome.ok) {
          sendJson(res, outcome.status, {
            error: outcome.error,
            ...(outcome.decision ? { decision: outcome.decision } : {}),
          });
          return;
        }
        sendJson(res, 200, { ok: true, status: outcome.dmStatus });
        return;
      }

      sendJson(res, 404, { error: "Not found" });
    } catch (err) {
      if (err instanceof DaemonHttpError) {
        sendJson(res, err.status, { error: err.message });
        return;
      }
      sendJson(res, 500, {
        error: err instanceof Error ? err.message : "Internal server error",
      });
    }
  }

  private applyLocalCors(req: IncomingMessage, res: ServerResponse): void {
    const origin = req.headers.origin;
    if (origin && LOCAL_ORIGIN_PATTERN.test(origin)) {
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
      res.setHeader("access-control-allow-headers", "Authorization, Content-Type");
      res.setHeader("vary", "Origin");
    }
  }

  private async handleLocalControlRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    this.applyLocalCors(req, res);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const authHeader = req.headers.authorization ?? "";
    const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!bearer || !constantTimeTokenEquals(bearer, this._localControlToken)) {
      sendJson(res, 401, { error: "Unauthorized" });
      return;
    }

    try {
      const url = new URL(req.url ?? "/", this._localControlUrl || "http://127.0.0.1");
      const pathname = url.pathname;

      if (req.method === "GET" && pathname === "/local/status") {
        sendJson(res, 200, this.getStatus());
        return;
      }

      if (req.method === "GET" && pathname === "/local/inbox") {
        const unreadParam = url.searchParams.get("unreadOnly");
        const unreadOnly = unreadParam === "true" || unreadParam === "1";
        const limitParam = url.searchParams.get("limit");
        const limit = limitParam ? Number(limitParam) : undefined;
        const items = this.store.listInboxItems({
          unreadOnly,
          ...(limit !== undefined && Number.isFinite(limit) ? { limit } : {}),
        });
        sendJson(res, 200, { items });
        return;
      }

      if (req.method === "GET" && pathname === "/local/inbox/wait") {
        const timeoutParam = Number(url.searchParams.get("timeoutSec") ?? "30");
        const timeoutSec = Number.isFinite(timeoutParam)
          ? Math.max(0.05, Math.min(300, timeoutParam))
          : 30;
        const items = await this.waitForMention(timeoutSec);
        sendJson(res, 200, { items, timedOut: items.length === 0 });
        return;
      }

      if (req.method === "POST" && pathname === "/local/inbox/read") {
        const body = (await readJsonBody(req)) as Record<string, unknown>;
        const ids = Array.isArray(body["ids"])
          ? body["ids"].filter((v): v is string => typeof v === "string")
          : undefined;
        this.store.markInboxRead(ids);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "GET" && pathname === "/local/dms") {
        const peer = url.searchParams.get("peer") ?? undefined;
        const limitParam = url.searchParams.get("limit");
        const limit = limitParam ? Number(limitParam) : 50;
        const messages = this.store.listDmMessages({
          peer,
          limit: Number.isFinite(limit) ? limit : 50,
        });
        sendJson(res, 200, { messages });
        return;
      }

      if (req.method === "POST" && pathname === "/local/dms") {
        const body = (await readJsonBody(req)) as Record<string, unknown>;
        const peer = typeof body["peer"] === "string" ? body["peer"].trim() : "";
        const content = typeof body["content"] === "string" ? body["content"] : "";
        const forceRelay = body["forceRelay"] === true;
        if (!peer || !content) {
          sendJson(res, 400, { error: "Fields 'peer' and 'content' are required" });
          return;
        }
        try {
          const result = await this.sendDm(peer, content, { forceRelay });
          sendJson(res, 200, {
            message: result.message,
            transport: result.transport,
          });
        } catch (err) {
          const code = err instanceof TransportError ? err.code : undefined;
          sendJson(res, 502, {
            error: err instanceof Error ? err.message : String(err),
            ...(code ? { code } : {}),
          });
        }
        return;
      }

      if (req.method === "GET" && pathname === "/local/approvals") {
        const statusParam = url.searchParams.get("status") ?? "pending";
        const status =
          statusParam === "all"
            ? undefined
            : statusParam === "approved" ||
                statusParam === "rejected" ||
                statusParam === "pending"
              ? statusParam
              : "pending";
        const approvals = this.store.listPendingApprovals(status);
        sendJson(res, 200, { approvals });
        return;
      }

      const approveMatch = /^\/local\/approvals\/([^/]+)\/approve$/.exec(pathname);
      if (req.method === "POST" && approveMatch?.[1]) {
        const id = decodeURIComponent(approveMatch[1]);
        const result = await this.approvePending(id);
        sendJson(res, 200, result);
        return;
      }

      const rejectMatch = /^\/local\/approvals\/([^/]+)\/reject$/.exec(pathname);
      if (req.method === "POST" && rejectMatch?.[1]) {
        const id = decodeURIComponent(rejectMatch[1]);
        const result = await this.rejectPending(id);
        sendJson(res, 200, result);
        return;
      }

      sendJson(res, 404, { error: "Not found" });
    } catch (err) {
      if (err instanceof DaemonHttpError) {
        sendJson(res, err.status, { error: err.message });
        return;
      }
      sendJson(res, 500, {
        error: err instanceof Error ? err.message : "Internal server error",
      });
    }
  }

  private connectWebSocketInitial(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const resolveOnce = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      const rejectOnce = (err: Error) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      };
      this.openWebSocket({
        onRegistered: resolveOnce,
        onInitialError: rejectOnce,
      });
    });
  }

  private openWebSocket(hooks?: {
    onRegistered?: () => void;
    onInitialError?: (err: Error) => void;
  }): void {
    if (this.closing || this._authStopped) return;

    const wsUrl = `${httpToWsUrl(this.serverUrl)}?token=${encodeURIComponent(this.token)}`;
    const ws = new WebSocket(wsUrl);
    this.ws = ws;
    let opened = false;
    let registered = false;

    ws.on("unexpected-response", (_req, res) => {
      const status = res.statusCode ?? 0;
      res.resume();
      this._online = false;
      if (status === 401 || status === 403) {
        this._authStopped = true;
        this.clearReconnectTimer();
        const err = new DaemonHttpError(
          status,
          `WebSocket authentication failed (HTTP ${status})`,
        );
        this.onLog(err.message);
        hooks?.onInitialError?.(err);
        ws.terminate();
        return;
      }
      const err = new Error(`Unexpected WebSocket HTTP response: ${status}`);
      if (hooks?.onInitialError) {
        hooks.onInitialError(err);
      } else {
        this.scheduleReconnect();
      }
      ws.terminate();
    });

    ws.on("open", () => {
      opened = true;
      this.reconnectAttempts = 0;
      this.sendWsFrame({
        type: "node.register",
        nodeId: this.identity.nodeId,
        handle: this.handle,
        displayName: this.displayName,
        kind: this.adapter.kind,
        description: this.description,
        capabilities: this.capabilities,
        signPublicKey: this.identity.keys.signPublicKey,
        kxPublicKey: this.identity.keys.kxPublicKey,
        directUrl: this._directUrl,
      });
      this.startHeartbeat();
    });

    ws.on("message", (data) => {
      const raw = typeof data === "string" ? data : data.toString("utf8");
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(raw);
      } catch {
        return;
      }
      const parsed = ServerToClientFrameSchema.safeParse(parsedJson);
      if (!parsed.success) {
        return;
      }
      const frame = parsed.data;
      if (frame.type === "node.registered") {
        registered = true;
        this._online = true;
        this._relayEnabled = frame.relayEnabled;
        this._ownerUsername = frame.node.ownerUsername;
        this.peerCache.set(frame.node.nodeId, frame.node);
        this.peerCache.set(frame.node.handle.toLowerCase(), frame.node);
        this.trackTask(this.syncRoomSubscriptions());
        hooks?.onRegistered?.();
        return;
      }
      this.handleServerFrame(frame);
    });

    ws.on("error", (err) => {
      if (/\b401\b/.test(err.message)) {
        this._authStopped = true;
        this.clearReconnectTimer();
      }
      if (!registered && hooks?.onInitialError) {
        hooks.onInitialError(err);
      }
    });

    ws.on("close", (code) => {
      this.stopHeartbeat();
      if (this.ws === ws) {
        this.ws = null;
      }
      this._online = false;
      if (code === 4001) {
        this._authStopped = true;
        this.clearReconnectTimer();
        hooks?.onInitialError?.(
          new DaemonHttpError(401, "WebSocket closed with auth error (4001)"),
        );
        return;
      }
      if (!registered && hooks?.onInitialError) {
        hooks.onInitialError(
          new Error(
            opened
              ? `WebSocket closed before registration completed (code ${code})`
              : `WebSocket closed before opening (code ${code})`,
          ),
        );
        return;
      }
      if (!this.closing && !this._authStopped) {
        this.scheduleReconnect();
      }
    });
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.sendWsFrame({ type: "ping" });
      }
    }, this.wsHeartbeatMs);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.closing || this._authStopped || this.reconnectTimer) return;
    const delay = Math.min(
      this.reconnectBaseMs * 2 ** this.reconnectAttempts,
      this.reconnectMaxMs,
    );
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closing || this._authStopped) return;
      this._reconnectCount += 1;
      this.openWebSocket();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private sendWsFrame(frame: ClientToServerFrame): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket is not connected");
    }
    this.ws.send(JSON.stringify(frame));
  }

  async subscribeRoom(roomId: string): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.sendWsFrame({ type: "room.subscribe", roomId });
    }
  }

  private async syncRoomSubscriptions(): Promise<void> {
    try {
      const { rooms } = await this.api.listRooms();
      for (const room of rooms) {
        this.roomSlugCache.set(room.id, room.slug);
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.sendWsFrame({ type: "room.subscribe", roomId: room.id });
        }
      }
    } catch {
      // Room subscription sync is best-effort on connect.
    }
  }

  private handleServerFrame(frame: ServerToClientFrame): void {
    switch (frame.type) {
      case "pong":
        return;
      case "presence.update": {
        this.peerCache.set(frame.node.nodeId, frame.node);
        this.peerCache.set(frame.node.handle.toLowerCase(), frame.node);
        return;
      }
      case "settings.update": {
        this._relayEnabled = frame.relayEnabled;
        this.relayTransport.setEnabled(frame.relayEnabled);
        return;
      }
      case "relay.deliver": {
        this.trackTask(
          this.handleInboundPacket(frame.packet, "relay").then(() => undefined),
        );
        return;
      }
      case "inbox.mention": {
        this.trackTask(this.handleInboxMention(frame.item, frame.message));
        return;
      }
      case "room.message":
      case "room.loop_broken":
      case "signal.deliver":
        return;
      case "error": {
        this.onLog(`Server WS error [${frame.code}]: ${frame.message}`);
        return;
      }
    }
  }

  private async resolvePeer(handleOrId: string, forceRefresh = false): Promise<NodePresence> {
    const key = handleOrId.trim().replace(/^@/, "");
    const lowerKey = key.toLowerCase();
    if (!forceRefresh) {
      const cached = this.peerCache.get(key) ?? this.peerCache.get(lowerKey);
      if (cached) return cached;
    }
    const { node } = await this.api.getNode(key);
    this.peerCache.set(node.nodeId, node);
    this.peerCache.set(node.handle.toLowerCase(), node);
    return node;
  }

  private pruneSeenNonces(): void {
    if (this.seenNonces.size <= MAX_SEEN_NONCES) return;
    let removed = 0;
    for (const key of this.seenNonces) {
      this.seenNonces.delete(key);
      removed += 1;
      if (removed >= 10_000) break;
    }
  }

  private async handleInboundPacket(
    packet: P2pPacket,
    transport: TransportMode,
  ): Promise<
    | { ok: true; dmStatus: DmMessage["status"] }
    | { ok: false; status: number; error: string; decision?: string }
  > {
    if (packet.toNodeId !== this.identity.nodeId) {
      return { ok: false, status: 403, error: "Packet recipient nodeId mismatch" };
    }

    let sender: NodePresence;
    try {
      sender = await this.resolvePeer(packet.fromNodeId);
    } catch (err) {
      return {
        ok: false,
        status: 403,
        error: `Unknown or unauthorized sender node: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    let payload: DmPayload;
    try {
      payload = verifyAndDecryptPacket({
        packet,
        expectedToNodeId: this.identity.nodeId,
        senderSignPublicKey: sender.signPublicKey,
        senderKxPublicKey: sender.kxPublicKey,
        recipientKxPrivateKey: this.identity.keys.kxPrivateKey,
        seenNonces: this.seenNonces,
      });
    } catch (firstErr) {
      const firstMsg = firstErr instanceof Error ? firstErr.message : String(firstErr);
      if (firstMsg.includes("Replay detected") || firstMsg.includes("clock skew")) {
        return { ok: false, status: 400, error: firstMsg };
      }
      try {
        sender = await this.resolvePeer(packet.fromNodeId, true);
        payload = verifyAndDecryptPacket({
          packet,
          expectedToNodeId: this.identity.nodeId,
          senderSignPublicKey: sender.signPublicKey,
          senderKxPublicKey: sender.kxPublicKey,
          recipientKxPrivateKey: this.identity.keys.kxPrivateKey,
          seenNonces: this.seenNonces,
        });
      } catch (err) {
        return {
          ok: false,
          status: 400,
          error: err instanceof Error ? err.message : "Packet verification failed",
        };
      }
    }
    this.pruneSeenNonces();

    const evalResult = this.policyGuard.evaluate({
      fromHandle: sender.handle || packet.fromHandle,
      fromUsername: sender.ownerUsername,
    });

    if (evalResult.decision === "deny_policy") {
      return {
        ok: false,
        status: 403,
        error: evalResult.reason ?? "Denied by local policy",
        decision: evalResult.decision,
      };
    }

    if (evalResult.decision === "deny_rate_limit") {
      return {
        ok: false,
        status: 429,
        error: evalResult.reason ?? "Rate limit exceeded",
        decision: evalResult.decision,
      };
    }

    if (evalResult.decision === "require_approval") {
      const dm: DmMessage = {
        id: packet.id,
        peerNodeId: sender.nodeId,
        peerHandle: sender.handle,
        direction: "in",
        content: payload.text,
        transport,
        encrypted: true,
        status: "pending_approval",
        createdAt: packet.timestamp,
      };
      this.store.insertDmMessage(dm);
      this.store.insertPendingApproval({
        id: randomUUID(),
        kind: "dm",
        fromHandle: sender.handle,
        fromNodeId: sender.nodeId,
        roomId: null,
        messageId: packet.id,
        content: payload.text,
        hopChainId: null,
        status: "pending",
        createdAt: Date.now(),
      });
      this.store.insertInboxItem({
        id: randomUUID(),
        kind: "approval_request",
        fromHandle: sender.handle,
        fromNodeId: sender.nodeId,
        roomId: null,
        roomName: null,
        messageId: packet.id,
        preview: payload.text.slice(0, 140),
        transport,
        createdAt: Date.now(),
        read: false,
      });
      this.notifyWaiters();
      return { ok: true, dmStatus: "pending_approval" };
    }

    const dm: DmMessage = {
      id: packet.id,
      peerNodeId: sender.nodeId,
      peerHandle: sender.handle,
      direction: "in",
      content: payload.text,
      transport,
      encrypted: true,
      status: "delivered",
      createdAt: packet.timestamp,
    };
    this.store.insertDmMessage(dm);
    this.store.insertInboxItem({
      id: randomUUID(),
      kind: "dm",
      fromHandle: sender.handle,
      fromNodeId: sender.nodeId,
      roomId: null,
      roomName: null,
      messageId: packet.id,
      preview: payload.text.slice(0, 140),
      transport,
      createdAt: Date.now(),
      read: false,
    });
    this.notifyWaiters();

    // Auto-replies are sent with kind "task_result" so two active bots never loop on DMs.
    if (payload.kind !== "task_result") {
      const readOnlyDir =
        evalResult.decision === "allow_read_only" ? evalResult.allowedDir : undefined;
      this.trackTask(
        this.runAdapterForDm(sender, payload.text, readOnlyDir),
      );
    }

    return { ok: true, dmStatus: "delivered" };
  }

  private async runAdapterForDm(
    sender: NodePresence,
    text: string,
    readOnlyDir?: string,
  ): Promise<void> {
    if (this.closing) return;
    try {
      const reply = await this.adapter.handleTurn({
        text,
        fromHandle: sender.handle,
        roomId: null,
        ...(readOnlyDir ? { readOnlyDir } : {}),
      });
      if (reply && !this.closing) {
        await this.sendDm(sender.nodeId, reply, { payloadKind: "task_result" });
      }
    } catch (err) {
      this.onLog(
        `Adapter DM handling error for @${sender.handle}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async handleInboxMention(
    item: InboxItem,
    message: RoomMessage,
  ): Promise<void> {
    if (this.closing) return;
    if (message.senderNodeId === this.identity.nodeId) return;
    if (message.loopBroken) return;

    const myHandle = this.handle.toLowerCase();
    const myOwner = this._ownerUsername?.toLowerCase();
    const mentions = message.mentions.map((m) => m.toLowerCase());
    if (mentions.length > 0) {
      const targeted =
        this.adapter.kind === "mcp"
          ? mentions.includes(myHandle) || Boolean(myOwner && mentions.includes(myOwner))
          : mentions.includes(myHandle);
      if (!targeted) {
        return;
      }
    }

    const roomSlug = this.roomSlugCache.get(message.roomId) ?? item.roomName ?? undefined;
    const evalResult = this.policyGuard.evaluate({
      fromHandle: message.senderHandle,
      fromUsername: message.senderType === "human" ? message.senderHandle : undefined,
      roomSlug,
      roomId: message.roomId,
    });

    if (
      evalResult.decision === "deny_policy" ||
      evalResult.decision === "deny_rate_limit"
    ) {
      return;
    }

    if (evalResult.decision === "require_approval") {
      this.store.insertPendingApproval({
        id: randomUUID(),
        kind: "room_mention",
        fromHandle: message.senderHandle,
        fromNodeId: message.senderNodeId,
        roomId: message.roomId,
        messageId: message.id,
        content: message.content,
        hopChainId: message.hopChainId,
        status: "pending",
        createdAt: Date.now(),
      });
      this.store.insertInboxItem({
        id: randomUUID(),
        kind: "approval_request",
        fromHandle: message.senderHandle,
        fromNodeId: message.senderNodeId,
        roomId: message.roomId,
        roomName: item.roomName,
        messageId: message.id,
        preview: message.content.slice(0, 140),
        createdAt: Date.now(),
        read: false,
      });
      this.notifyWaiters();
      return;
    }

    this.store.insertInboxItem({
      id: item.id || randomUUID(),
      kind: "room_mention",
      fromHandle: message.senderHandle,
      fromNodeId: message.senderNodeId,
      roomId: message.roomId,
      roomName: item.roomName,
      messageId: message.id,
      preview: item.preview || message.content.slice(0, 140),
      createdAt: item.createdAt || message.createdAt,
      read: false,
    });
    this.notifyWaiters();

    if (this.adapter.kind === "mcp") {
      return;
    }

    try {
      const context = await this.fetchRoomContext(message.roomId, message.id);
      const readOnlyDir =
        evalResult.decision === "allow_read_only" ? evalResult.allowedDir : undefined;
      const reply = await this.adapter.handleTurn({
        text: message.content,
        fromHandle: message.senderHandle,
        roomId: message.roomId,
        context,
        ...(readOnlyDir ? { readOnlyDir } : {}),
      });
      if (reply && !this.closing) {
        await this.api.sendRoomMessage(message.roomId, {
          content: reply,
          senderNodeId: this.identity.nodeId,
          ...(message.hopChainId ? { hopChainId: message.hopChainId } : {}),
        });
      }
    } catch (err) {
      this.onLog(
        `Adapter room mention error in ${message.roomId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async fetchRoomContext(
    roomId: string,
    excludeMessageId?: string,
  ): Promise<Array<{ sender: string; content: string }>> {
    try {
      const { messages } = await this.api.listRoomMessages(roomId, { limit: 20 });
      return messages
        .filter((m) => m.id !== excludeMessageId)
        .map((m) => ({ sender: m.senderHandle, content: m.content }));
    } catch {
      return [];
    }
  }

  private async refreshRelayState(): Promise<void> {
    try {
      const info = await this.api.serverInfo();
      this._relayEnabled = info.relayEnabled;
      this.relayTransport.setEnabled(info.relayEnabled);
    } catch {
      // Keep last known relay state from WS if info fetch fails transiently.
    }
  }

  private forwardViaRelay(toNodeId: string, packet: P2pPacket): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(
        new TransportError("RELAY_FAILED", "WebSocket is not connected", {
          mode: "relay",
        }),
      );
    }
    const cachedPeer = this.peerCache.get(toNodeId);
    if (cachedPeer && !cachedPeer.online) {
      return Promise.reject(
        new TransportError(
          "RELAY_FAILED",
          `Peer ${cachedPeer.handle} is offline`,
          { mode: "relay" },
        ),
      );
    }
    const frame: ClientToServerFrame = {
      type: "relay.forward",
      toNodeId,
      packet,
    };
    return new Promise((resolve, reject) => {
      this.ws?.send(JSON.stringify(frame), (err) => {
        if (err) {
          reject(
            new TransportError("RELAY_FAILED", err.message, {
              mode: "relay",
              cause: err,
            }),
          );
          return;
        }
        resolve();
      });
    });
  }

  async sendDm(
    targetHandleOrId: string,
    content: string,
    opts?: {
      forceRelay?: boolean;
      payloadKind?: DmPayload["kind"];
      taskId?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<SendDmResult> {
    const peer = await this.resolvePeer(targetHandleOrId, true);
    await this.refreshRelayState();

    const packet = createSignedEncryptedPacket({
      fromNodeId: this.identity.nodeId,
      fromHandle: this.handle,
      toNodeId: peer.nodeId,
      senderSignPrivateKey: this.identity.keys.signPrivateKey,
      senderKxPrivateKey: this.identity.keys.kxPrivateKey,
      recipientKxPublicKey: peer.kxPublicKey,
      payload: {
        kind: opts?.payloadKind ?? "text",
        text: content,
        ...(opts?.taskId ? { taskId: opts.taskId } : {}),
        ...(opts?.metadata ? { metadata: opts.metadata } : {}),
      },
    });

    const result = await this.router.send(
      {
        nodeId: peer.nodeId,
        handle: peer.handle,
        directUrl: peer.directUrl,
      },
      packet,
      { forceRelay: opts?.forceRelay },
    );

    const message: DmMessage = {
      id: packet.id,
      peerNodeId: peer.nodeId,
      peerHandle: peer.handle,
      direction: "out",
      content,
      transport: result.mode,
      encrypted: true,
      status: "delivered",
      createdAt: packet.timestamp,
    };
    this.store.insertDmMessage(message);

    return {
      message,
      transport: result.mode,
      attempts: result.attempts,
    };
  }

  waitForMention(timeoutSec = 30): Promise<InboxItem[]> {
    const existing = this.store.listInboxItems({ unreadOnly: true });
    if (existing.length > 0) {
      return Promise.resolve(existing);
    }
    const timeoutMs = Math.max(0, timeoutSec) * 1000;
    if (timeoutMs === 0) {
      return Promise.resolve([]);
    }
    return new Promise((resolve) => {
      const waiter: MentionWaiter = {
        resolve,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          resolve([]);
        }, timeoutMs),
      };
      this.waiters.add(waiter);
    });
  }

  private notifyWaiters(): void {
    if (this.waiters.size === 0) return;
    const unread = this.store.listInboxItems({ unreadOnly: true });
    if (unread.length === 0) return;
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(unread);
    }
    this.waiters.clear();
  }

  async approvePending(id: string): Promise<{ ok: true; reply: string | null }> {
    const approval = this.store.getPendingApproval(id);
    if (!approval) {
      throw new DaemonHttpError(404, `Approval request not found: ${id}`);
    }
    if (approval.status !== "pending") {
      throw new DaemonHttpError(409, `Approval request ${id} is already ${approval.status}`);
    }

    const updated = this.store.updatePendingApprovalStatus(id, "approved");
    if (!updated) {
      throw new DaemonHttpError(409, `Approval request ${id} is no longer pending`);
    }
    this.store.markInboxReadByMessageId(approval.messageId);

    let reply: string | null = null;
    if (approval.kind === "dm") {
      this.store.updateDmStatus(approval.messageId, "delivered");
      reply = await this.adapter.handleTurn({
        text: approval.content,
        fromHandle: approval.fromHandle,
        roomId: null,
      });
      if (reply && approval.fromNodeId) {
        await this.sendDm(approval.fromNodeId, reply, { payloadKind: "task_result" });
      }
      return { ok: true, reply };
    }

    if (approval.roomId) {
      const context = await this.fetchRoomContext(approval.roomId, approval.messageId);
      reply = await this.adapter.handleTurn({
        text: approval.content,
        fromHandle: approval.fromHandle,
        roomId: approval.roomId,
        context,
      });
      if (reply) {
        await this.api.sendRoomMessage(approval.roomId, {
          content: reply,
          senderNodeId: this.identity.nodeId,
          ...(approval.hopChainId ? { hopChainId: approval.hopChainId } : {}),
        });
      }
    }

    return { ok: true, reply };
  }

  async rejectPending(id: string): Promise<{ ok: true }> {
    const approval = this.store.getPendingApproval(id);
    if (!approval) {
      throw new DaemonHttpError(404, `Approval request not found: ${id}`);
    }
    if (approval.status !== "pending") {
      throw new DaemonHttpError(409, `Approval request ${id} is already ${approval.status}`);
    }
    const updated = this.store.updatePendingApprovalStatus(id, "rejected");
    if (!updated) {
      throw new DaemonHttpError(409, `Approval request ${id} is no longer pending`);
    }
    this.store.markInboxReadByMessageId(approval.messageId);
    if (approval.kind === "dm") {
      this.store.updateDmStatus(approval.messageId, "rejected");
    }
    return { ok: true };
  }

  listPendingApprovals(status?: PendingApproval["status"]): PendingApproval[] {
    return this.store.listPendingApprovals(status);
  }

  private trackTask(promise: Promise<void>): void {
    const wrapped = promise.catch((err) => {
      this.onLog(
        `Daemon task error: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    this.backgroundTasks.add(wrapped);
    void wrapped.finally(() => {
      this.backgroundTasks.delete(wrapped);
    });
  }

  async close(): Promise<void> {
    this.closing = true;
    this.stopHeartbeat();
    this.clearReconnectTimer();

    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve([]);
    }
    this.waiters.clear();

    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      if (
        ws.readyState === WebSocket.OPEN ||
        ws.readyState === WebSocket.CONNECTING
      ) {
        ws.terminate();
      }
    }
    this._online = false;

    await Promise.allSettled([...this.backgroundTasks]);
    await closeServer(this.p2pServer);
    this.p2pServer = null;
    await closeServer(this.localControlServer);
    this.localControlServer = null;

    if (this.store) {
      try {
        this.store.close();
      } catch {
        // Ignore already-closed database.
      }
    }
    if (this.started) {
      clearDaemonState(this.homeDir);
      this.started = false;
    }
  }
}
