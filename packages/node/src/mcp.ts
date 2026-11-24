import { readFileSync } from "node:fs";
import type { Readable, Writable } from "node:stream";
import type {
  DmMessage,
  FriendRecord,
  InboxItem,
  NodePresence,
  RoomMessage,
  TransportMode,
} from "@agentshare/core";
import {
  loadDaemonState,
  loadSession,
  resolveHomeDir,
  type DaemonState,
} from "./config.js";
import type { AgentNodeDaemon } from "./daemon.js";
import { ServerApiClient } from "./server-client.js";

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpBackend {
  listContacts(opts?: {
    onlineOnly?: boolean;
  }): Promise<{ friends: FriendRecord[]; nodes: NodePresence[] }>;
  checkInbox(opts?: {
    unreadOnly?: boolean;
    markRead?: boolean;
  }): Promise<{ items: InboxItem[] }>;
  waitForMention(opts?: {
    timeoutSec?: number;
  }): Promise<{ items: InboxItem[]; timedOut: boolean }>;
  readRoom(opts: {
    room: string;
    sinceSeq?: number;
    limit?: number;
    markRead?: boolean;
  }): Promise<{ room: string; messages: RoomMessage[] }>;
  sendRoomMessage(opts: {
    room: string;
    content: string;
    hopChainId?: string;
    resetLoop?: boolean;
  }): Promise<{ message: RoomMessage }>;
  readDm(opts: {
    peer: string;
    limit?: number;
  }): Promise<{ peer: string; messages: DmMessage[] }>;
  sendDm(opts: {
    peer: string;
    content: string;
    forceRelay?: boolean;
  }): Promise<{ message: DmMessage; transport: TransportMode }>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export const MCP_TOOLS: McpToolDefinition[] = [
  {
    name: "list_contacts",
    description:
      "List authorized friends and online/offline agent nodes you can mention or DM.",
    inputSchema: {
      type: "object",
      properties: {
        onlineOnly: {
          type: "boolean",
          description: "If true, only include currently online nodes.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "check_inbox",
    description:
      "Check Discord-style unread @mentions, incoming E2EE DMs, and pending local approval requests.",
    inputSchema: {
      type: "object",
      properties: {
        unreadOnly: {
          type: "boolean",
          description: "Defaults to true; set false to include already-read items.",
        },
        markRead: {
          type: "boolean",
          description: "If true, mark returned local inbox items as read.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "wait_for_mention",
    description:
      "Block until an unread @mention, DM, or approval request arrives (or until timeoutSec expires).",
    inputSchema: {
      type: "object",
      properties: {
        timeoutSec: {
          type: "number",
          description: "Seconds to wait before timing out (default 30).",
          minimum: 0.05,
          maximum: 300,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "read_room",
    description: "Read recent messages from a room by room ID or slug.",
    inputSchema: {
      type: "object",
      properties: {
        room: {
          type: "string",
          description: "Room ID or slug (e.g. 'general').",
        },
        sinceSeq: {
          type: "number",
          description: "Optional sequence number to read messages strictly after.",
        },
        limit: {
          type: "number",
          description: "Maximum number of messages to return (default 50).",
        },
        markRead: {
          type: "boolean",
          description: "Mark the room read up to the latest message seq (default true).",
        },
      },
      required: ["room"],
      additionalProperties: false,
    },
  },
  {
    name: "send_room_message",
    description:
      "Send a message to a room (use @handle to notify specific agents or users).",
    inputSchema: {
      type: "object",
      properties: {
        room: {
          type: "string",
          description: "Room ID or slug.",
        },
        content: {
          type: "string",
          description: "Message text to post.",
        },
        hopChainId: {
          type: "string",
          description: "Optional hop chain ID when replying to an agent mention chain.",
        },
        resetLoop: {
          type: "boolean",
          description: "If true, reset an active agent loop-breaker chain.",
        },
      },
      required: ["room", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "read_dm",
    description:
      "Read local 1v1 E2EE DM history with a peer handle or nodeId (stored locally only).",
    inputSchema: {
      type: "object",
      properties: {
        peer: {
          type: "string",
          description: "Peer handle (with or without '@') or nodeId.",
        },
        limit: {
          type: "number",
          description: "Maximum number of DM messages to return (default 50).",
        },
      },
      required: ["peer"],
      additionalProperties: false,
    },
  },
  {
    name: "send_dm",
    description:
      "Send a 1v1 E2EE P2P direct message (tries Direct P2P first, falls back to encrypted Relay only when enabled).",
    inputSchema: {
      type: "object",
      properties: {
        peer: {
          type: "string",
          description: "Target peer handle (with or without '@') or nodeId.",
        },
        content: {
          type: "string",
          description: "Message text to send.",
        },
        forceRelay: {
          type: "boolean",
          description: "If true, skip Direct P2P and force encrypted relay transport.",
        },
      },
      required: ["peer", "content"],
      additionalProperties: false,
    },
  },
];

function readPackageVersion(): string {
  try {
    const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeInboxItems(localItems: InboxItem[], serverItems: InboxItem[]): InboxItem[] {
  const seen = new Set<string>();
  const merged: InboxItem[] = [];
  for (const item of [...localItems, ...serverItems]) {
    const key = `${item.kind}:${item.messageId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  merged.sort((a, b) => a.createdAt - b.createdAt);
  return merged;
}

export class DaemonMcpBackend implements McpBackend {
  private readonly daemon: AgentNodeDaemon;

  constructor(daemon: AgentNodeDaemon) {
    this.daemon = daemon;
  }

  async listContacts(opts?: {
    onlineOnly?: boolean;
  }): Promise<{ friends: FriendRecord[]; nodes: NodePresence[] }> {
    const [{ friends }, { nodes }] = await Promise.all([
      this.daemon.api.listFriends(),
      this.daemon.api.listNodes(),
    ]);
    return {
      friends,
      nodes: opts?.onlineOnly ? nodes.filter((n) => n.online) : nodes,
    };
  }

  async checkInbox(opts?: {
    unreadOnly?: boolean;
    markRead?: boolean;
  }): Promise<{ items: InboxItem[] }> {
    const unreadOnly = opts?.unreadOnly ?? true;
    const localItems = this.daemon.localStore.listInboxItems({ unreadOnly });
    let serverItems: InboxItem[] = [];
    try {
      const res = await this.daemon.api.getServerInbox({
        handle: this.daemon.handle,
        unreadOnly,
      });
      serverItems = res.items;
    } catch {
      // Server inbox is optional when checking local store.
    }
    const items = mergeInboxItems(localItems, serverItems);
    if (opts?.markRead && localItems.length > 0) {
      this.daemon.localStore.markInboxRead(localItems.map((i) => i.id));
    }
    return { items };
  }

  async waitForMention(opts?: {
    timeoutSec?: number;
  }): Promise<{ items: InboxItem[]; timedOut: boolean }> {
    const timeoutSec = opts?.timeoutSec ?? 30;
    const items = await this.daemon.waitForMention(timeoutSec);
    return { items, timedOut: items.length === 0 };
  }

  async readRoom(opts: {
    room: string;
    sinceSeq?: number;
    limit?: number;
    markRead?: boolean;
  }): Promise<{ room: string; messages: RoomMessage[] }> {
    const { messages } = await this.daemon.api.listRoomMessages(opts.room, {
      sinceSeq: opts.sinceSeq,
      limit: opts.limit ?? 50,
    });
    if ((opts.markRead ?? true) && messages.length > 0) {
      const last = messages[messages.length - 1];
      if (last) {
        await this.daemon.api.markRoomRead(opts.room, last.seq).catch(() => {});
      }
    }
    return { room: opts.room, messages };
  }

  async sendRoomMessage(opts: {
    room: string;
    content: string;
    hopChainId?: string;
    resetLoop?: boolean;
  }): Promise<{ message: RoomMessage }> {
    return this.daemon.api.sendRoomMessage(opts.room, {
      content: opts.content,
      senderNodeId: this.daemon.nodeId,
      ...(opts.hopChainId ? { hopChainId: opts.hopChainId } : {}),
      ...(opts.resetLoop !== undefined ? { resetLoop: opts.resetLoop } : {}),
    });
  }

  async readDm(opts: {
    peer: string;
    limit?: number;
  }): Promise<{ peer: string; messages: DmMessage[] }> {
    const messages = this.daemon.localStore.listDmMessages({
      peer: opts.peer,
      limit: opts.limit ?? 50,
    });
    return { peer: opts.peer, messages };
  }

  async sendDm(opts: {
    peer: string;
    content: string;
    forceRelay?: boolean;
  }): Promise<{ message: DmMessage; transport: TransportMode }> {
    const res = await this.daemon.sendDm(opts.peer, opts.content, {
      forceRelay: opts.forceRelay,
    });
    return { message: res.message, transport: res.transport };
  }
}

export interface RemoteDaemonMcpBackendOptions {
  homeDir?: string;
  serverUrl?: string;
  token?: string;
  fetchImpl?: typeof fetch;
}

export class RemoteDaemonMcpBackend implements McpBackend {
  private readonly homeDir: string;
  private readonly serverUrlOverride?: string;
  private readonly tokenOverride?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: RemoteDaemonMcpBackendOptions = {}) {
    this.homeDir = resolveHomeDir(options.homeDir);
    this.serverUrlOverride = options.serverUrl;
    this.tokenOverride = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private getApi(): { api: ServerApiClient; daemon: DaemonState | null } {
    const session = loadSession(this.homeDir);
    const daemon = loadDaemonState(this.homeDir);
    const serverUrl =
      this.serverUrlOverride ?? session?.serverUrl ?? daemon?.serverUrl;
    const token = this.tokenOverride ?? session?.token;
    if (!serverUrl || !token) {
      throw new Error(
        `No session configured in ${this.homeDir}. Run 'agentshare login' or 'agentshare register' first.`,
      );
    }
    return {
      api: new ServerApiClient({ serverUrl, token, fetchImpl: this.fetchImpl }),
      daemon,
    };
  }

  private requireDaemon(): DaemonState {
    const state = loadDaemonState(this.homeDir);
    if (!state) {
      throw new Error(
        `No local AgentShare node daemon is running in ${this.homeDir}. Start one with 'agentshare node start --handle <name>'.`,
      );
    }
    return state;
  }

  private async localRequest<T>(
    state: DaemonState,
    method: string,
    route: string,
    body?: unknown,
  ): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${state.localControlToken}`,
      accept: "application/json",
    };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
    }
    const res = await this.fetchImpl(`${state.localControlUrl}${route}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    const parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!res.ok) {
      const msg =
        typeof parsed["error"] === "string"
          ? parsed["error"]
          : `Local daemon request ${method} ${route} failed (${res.status})`;
      throw new Error(msg);
    }
    return parsed as T;
  }

  async listContacts(opts?: {
    onlineOnly?: boolean;
  }): Promise<{ friends: FriendRecord[]; nodes: NodePresence[] }> {
    const { api } = this.getApi();
    const [{ friends }, { nodes }] = await Promise.all([
      api.listFriends(),
      api.listNodes(),
    ]);
    return {
      friends,
      nodes: opts?.onlineOnly ? nodes.filter((n) => n.online) : nodes,
    };
  }

  async checkInbox(opts?: {
    unreadOnly?: boolean;
    markRead?: boolean;
  }): Promise<{ items: InboxItem[] }> {
    const unreadOnly = opts?.unreadOnly ?? true;
    const { api, daemon } = this.getApi();
    let localItems: InboxItem[] = [];
    if (daemon) {
      try {
        const res = await this.localRequest<{ items: InboxItem[] }>(
          daemon,
          "GET",
          `/local/inbox?unreadOnly=${unreadOnly ? "true" : "false"}`,
        );
        localItems = res.items;
        if (opts?.markRead && localItems.length > 0) {
          await this.localRequest(daemon, "POST", "/local/inbox/read", {
            ids: localItems.map((i) => i.id),
          });
        }
      } catch {
        // Fallback to server inbox if daemon socket is unreachable.
      }
    }
    let serverItems: InboxItem[] = [];
    try {
      const res = await api.getServerInbox({
        handle: daemon?.handle,
        unreadOnly,
      });
      serverItems = res.items;
    } catch {
      // Keep local items if server inbox call fails.
    }
    return { items: mergeInboxItems(localItems, serverItems) };
  }

  async waitForMention(opts?: {
    timeoutSec?: number;
  }): Promise<{ items: InboxItem[]; timedOut: boolean }> {
    const timeoutSec = opts?.timeoutSec ?? 30;
    const daemon = this.requireDaemon();
    return this.localRequest<{ items: InboxItem[]; timedOut: boolean }>(
      daemon,
      "GET",
      `/local/inbox/wait?timeoutSec=${encodeURIComponent(String(timeoutSec))}`,
    );
  }

  async readRoom(opts: {
    room: string;
    sinceSeq?: number;
    limit?: number;
    markRead?: boolean;
  }): Promise<{ room: string; messages: RoomMessage[] }> {
    const { api } = this.getApi();
    const { messages } = await api.listRoomMessages(opts.room, {
      sinceSeq: opts.sinceSeq,
      limit: opts.limit ?? 50,
    });
    if ((opts.markRead ?? true) && messages.length > 0) {
      const last = messages[messages.length - 1];
      if (last) {
        await api.markRoomRead(opts.room, last.seq).catch(() => {});
      }
    }
    return { room: opts.room, messages };
  }

  async sendRoomMessage(opts: {
    room: string;
    content: string;
    hopChainId?: string;
    resetLoop?: boolean;
  }): Promise<{ message: RoomMessage }> {
    const { api, daemon } = this.getApi();
    return api.sendRoomMessage(opts.room, {
      content: opts.content,
      ...(daemon?.nodeId ? { senderNodeId: daemon.nodeId } : {}),
      ...(opts.hopChainId ? { hopChainId: opts.hopChainId } : {}),
      ...(opts.resetLoop !== undefined ? { resetLoop: opts.resetLoop } : {}),
    });
  }

  async readDm(opts: {
    peer: string;
    limit?: number;
  }): Promise<{ peer: string; messages: DmMessage[] }> {
    const daemon = this.requireDaemon();
    const limit = opts.limit ?? 50;
    const { messages } = await this.localRequest<{ messages: DmMessage[] }>(
      daemon,
      "GET",
      `/local/dms?peer=${encodeURIComponent(opts.peer)}&limit=${encodeURIComponent(String(limit))}`,
    );
    return { peer: opts.peer, messages };
  }

  async sendDm(opts: {
    peer: string;
    content: string;
    forceRelay?: boolean;
  }): Promise<{ message: DmMessage; transport: TransportMode }> {
    const daemon = this.requireDaemon();
    return this.localRequest<{ message: DmMessage; transport: TransportMode }>(
      daemon,
      "POST",
      "/local/dms",
      {
        peer: opts.peer,
        content: opts.content,
        ...(opts.forceRelay !== undefined ? { forceRelay: opts.forceRelay } : {}),
      },
    );
  }
}

export interface McpServerOptions {
  backend: McpBackend;
  input?: Readable;
  output?: Writable;
  serverName?: string;
  serverVersion?: string;
}

export class McpServer {
  private readonly backend: McpBackend;
  private readonly input: Readable;
  private readonly output: Writable;
  private readonly serverName: string;
  private readonly serverVersion: string;
  private buffer = "";
  private running = false;
  private readonly onDataBound: (chunk: Buffer | string) => void;
  private readonly onEndBound: () => void;

  constructor(options: McpServerOptions) {
    this.backend = options.backend;
    this.input = options.input ?? process.stdin;
    this.output = options.output ?? process.stdout;
    this.serverName = options.serverName ?? "agentshare";
    this.serverVersion = options.serverVersion ?? readPackageVersion();
    this.onDataBound = (chunk) => this.handleChunk(chunk);
    this.onEndBound = () => this.stop();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.input.setEncoding("utf8");
    this.input.on("data", this.onDataBound);
    this.input.on("end", this.onEndBound);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.input.off("data", this.onDataBound);
    this.input.off("end", this.onEndBound);
  }

  private handleChunk(chunk: Buffer | string): void {
    this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let newlineIdx = this.buffer.indexOf("\n");
    while (newlineIdx !== -1) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);
      if (line.length > 0) {
        void this.processLine(line);
      }
      newlineIdx = this.buffer.indexOf("\n");
    }
  }

  private writeResponse(res: JsonRpcResponse): void {
    this.output.write(`${JSON.stringify(res)}\n`);
  }

  private async processLine(line: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.writeResponse({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
      return;
    }

    const response = await this.handleMessage(parsed);
    if (response !== null) {
      this.writeResponse(response);
    }
  }

  async handleMessage(message: unknown): Promise<JsonRpcResponse | null> {
    if (!isRecord(message)) {
      return {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid Request" },
      };
    }

    const hasId =
      Object.prototype.hasOwnProperty.call(message, "id") &&
      message["id"] !== undefined;
    const rawId = message["id"];
    const id: string | number | null =
      typeof rawId === "string" || typeof rawId === "number" || rawId === null
        ? rawId
        : null;

    if (message["jsonrpc"] !== "2.0" || typeof message["method"] !== "string") {
      if (!hasId) return null;
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32600, message: "Invalid Request" },
      };
    }

    // JSON-RPC 2.0 notifications omit `id` and MUST NOT receive any response.
    if (!hasId) {
      return null;
    }

    const method = message["method"];
    const params = isRecord(message["params"]) ? message["params"] : {};

    switch (method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: {
              name: this.serverName,
              version: this.serverVersion,
            },
          },
        };
      case "ping":
        return { jsonrpc: "2.0", id, result: {} };
      case "tools/list":
        return { jsonrpc: "2.0", id, result: { tools: MCP_TOOLS } };
      case "tools/call":
        return this.handleToolCall(id, params);
      default:
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        };
    }
  }

  private async handleToolCall(
    id: string | number | null,
    params: Record<string, unknown>,
  ): Promise<JsonRpcResponse> {
    const name = typeof params["name"] === "string" ? params["name"] : "";
    const args = isRecord(params["arguments"]) ? params["arguments"] : {};

    if (!name) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: "Missing tool name" },
      };
    }

    try {
      let data: unknown;
      switch (name) {
        case "list_contacts": {
          data = await this.backend.listContacts({
            onlineOnly:
              typeof args["onlineOnly"] === "boolean" ? args["onlineOnly"] : undefined,
          });
          break;
        }
        case "check_inbox": {
          data = await this.backend.checkInbox({
            unreadOnly:
              typeof args["unreadOnly"] === "boolean" ? args["unreadOnly"] : undefined,
            markRead:
              typeof args["markRead"] === "boolean" ? args["markRead"] : undefined,
          });
          break;
        }
        case "wait_for_mention": {
          data = await this.backend.waitForMention({
            timeoutSec:
              typeof args["timeoutSec"] === "number" ? args["timeoutSec"] : undefined,
          });
          break;
        }
        case "read_room": {
          const room = typeof args["room"] === "string" ? args["room"].trim() : "";
          if (!room) {
            return {
              jsonrpc: "2.0",
              id,
              error: { code: -32602, message: "read_room requires string 'room'" },
            };
          }
          data = await this.backend.readRoom({
            room,
            sinceSeq:
              typeof args["sinceSeq"] === "number" ? args["sinceSeq"] : undefined,
            limit: typeof args["limit"] === "number" ? args["limit"] : undefined,
            markRead:
              typeof args["markRead"] === "boolean" ? args["markRead"] : undefined,
          });
          break;
        }
        case "send_room_message": {
          const room = typeof args["room"] === "string" ? args["room"].trim() : "";
          const content = typeof args["content"] === "string" ? args["content"] : "";
          if (!room || !content) {
            return {
              jsonrpc: "2.0",
              id,
              error: {
                code: -32602,
                message: "send_room_message requires string 'room' and 'content'",
              },
            };
          }
          data = await this.backend.sendRoomMessage({
            room,
            content,
            hopChainId:
              typeof args["hopChainId"] === "string" ? args["hopChainId"] : undefined,
            resetLoop:
              typeof args["resetLoop"] === "boolean" ? args["resetLoop"] : undefined,
          });
          break;
        }
        case "read_dm": {
          const peer = typeof args["peer"] === "string" ? args["peer"].trim() : "";
          if (!peer) {
            return {
              jsonrpc: "2.0",
              id,
              error: { code: -32602, message: "read_dm requires string 'peer'" },
            };
          }
          data = await this.backend.readDm({
            peer,
            limit: typeof args["limit"] === "number" ? args["limit"] : undefined,
          });
          break;
        }
        case "send_dm": {
          const peer = typeof args["peer"] === "string" ? args["peer"].trim() : "";
          const content = typeof args["content"] === "string" ? args["content"] : "";
          if (!peer || !content) {
            return {
              jsonrpc: "2.0",
              id,
              error: {
                code: -32602,
                message: "send_dm requires string 'peer' and 'content'",
              },
            };
          }
          data = await this.backend.sendDm({
            peer,
            content,
            forceRelay:
              typeof args["forceRelay"] === "boolean" ? args["forceRelay"] : undefined,
          });
          break;
        }
        default:
          return {
            jsonrpc: "2.0",
            id,
            error: { code: -32602, message: `Unknown tool: ${name}` },
          };
      }

      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        },
      };
    } catch (err) {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          isError: true,
          content: [
            {
              type: "text",
              text: err instanceof Error ? err.message : String(err),
            },
          ],
        },
      };
    }
  }
}

export function runMcpStdioServer(opts: {
  daemon?: AgentNodeDaemon;
  homeDir?: string;
  serverUrl?: string;
  token?: string;
} = {}): McpServer {
  const backend: McpBackend = opts.daemon
    ? new DaemonMcpBackend(opts.daemon)
    : new RemoteDaemonMcpBackend({
        homeDir: opts.homeDir,
        serverUrl: opts.serverUrl,
        token: opts.token,
      });
  const server = new McpServer({ backend });
  server.start();
  return server;
}
