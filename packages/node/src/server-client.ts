import type {
  FriendRecord,
  InboxItem,
  NodePresence,
  PairCodeRecord,
  RoomMessage,
  RoomSummary,
  UserProfile,
} from "@agentshare/core";
import { normalizeServerUrl } from "./config.js";

export interface ServerInfo {
  version: string;
  relayEnabled: boolean;
  needsBootstrap: boolean;
  maxAgentHops: number;
}

export interface RoomMemberRecord {
  userId: string;
  username: string;
  displayName: string;
  role: string;
  joinedAt: number;
}

export interface InviteRecord {
  code: string;
  createdBy: string | null;
  role: "admin" | "member";
  maxUses: number;
  usedCount: number;
  expiresAt: number | null;
  createdAt: number;
}

export class ServerApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = "ServerApiError";
    this.status = status;
    this.body = body;
  }
}

export class ServerApiClient {
  private readonly baseUrl: string;
  private token: string | null;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: { serverUrl: string; token?: string | null; fetchImpl?: typeof fetch }) {
    this.baseUrl = normalizeServerUrl(opts.serverUrl);
    this.token = opts.token ?? null;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get serverUrl(): string {
    return this.baseUrl;
  }

  setToken(token: string | null): void {
    this.token = token;
  }

  private async request<T>(
    method: string,
    route: string,
    body?: unknown,
  ): Promise<T> {
    const headers: Record<string, string> = {
      accept: "application/json",
    };
    if (this.token) {
      headers["authorization"] = `Bearer ${this.token}`;
    }
    if (body !== undefined) {
      headers["content-type"] = "application/json";
    }
    const res = await this.fetchImpl(`${this.baseUrl}${route}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!res.ok) {
      const errMsg =
        typeof parsed === "object" &&
        parsed !== null &&
        "error" in parsed &&
        typeof (parsed as Record<string, unknown>)["error"] === "string"
          ? String((parsed as Record<string, unknown>)["error"])
          : `Server ${method} ${route} failed with HTTP ${res.status}`;
      throw new ServerApiError(res.status, errMsg, parsed);
    }
    return parsed as T;
  }

  health(): Promise<{ ok: boolean; version: string; relayEnabled: boolean }> {
    return this.request("GET", "/healthz");
  }

  serverInfo(): Promise<ServerInfo> {
    return this.request("GET", "/api/v2/server/info");
  }

  register(input: {
    username: string;
    password: string;
    displayName?: string;
    inviteCode: string;
  }): Promise<{ token: string; user: UserProfile }> {
    return this.request("POST", "/api/v2/auth/register", input);
  }

  login(input: {
    username: string;
    password: string;
  }): Promise<{ token: string; user: UserProfile }> {
    return this.request("POST", "/api/v2/auth/login", input);
  }

  logout(): Promise<{ ok: boolean }> {
    return this.request("POST", "/api/v2/auth/logout");
  }

  me(): Promise<{ user: UserProfile }> {
    return this.request("GET", "/api/v2/me");
  }

  listInvites(): Promise<{ invites: InviteRecord[] }> {
    return this.request("GET", "/api/v2/admin/invites");
  }

  createInvite(input: {
    maxUses?: number;
    expiresInHours?: number;
    role?: "admin" | "member";
  } = {}): Promise<{ invite: InviteRecord }> {
    return this.request("POST", "/api/v2/admin/invites", input);
  }

  updateSettings(input: { enableRelay: boolean }): Promise<{ relayEnabled: boolean }> {
    return this.request("PATCH", "/api/v2/admin/settings", input);
  }

  listFriends(): Promise<{ friends: FriendRecord[] }> {
    return this.request("GET", "/api/v2/friends");
  }

  requestFriend(username: string): Promise<{ friend: FriendRecord }> {
    return this.request("POST", "/api/v2/friends/request", { username });
  }

  acceptFriend(id: string): Promise<{ friend: FriendRecord }> {
    return this.request("POST", `/api/v2/friends/${encodeURIComponent(id)}/accept`);
  }

  createPairCode(input: {
    nodeId?: string;
    maxUses?: number;
    expiresInMinutes?: number;
  } = {}): Promise<{ pairCode: PairCodeRecord }> {
    return this.request("POST", "/api/v2/pair-codes", input);
  }

  redeemPairCode(code: string): Promise<{
    ok: boolean;
    creatorUserId: string;
    nodes: NodePresence[];
  }> {
    return this.request("POST", "/api/v2/pair-codes/redeem", { code });
  }

  listNodes(): Promise<{ nodes: NodePresence[] }> {
    return this.request("GET", "/api/v2/nodes");
  }

  getNode(handleOrId: string): Promise<{ node: NodePresence }> {
    return this.request(
      "GET",
      `/api/v2/nodes/${encodeURIComponent(handleOrId.replace(/^@/, ""))}`,
    );
  }

  listRooms(): Promise<{ rooms: RoomSummary[] }> {
    return this.request("GET", "/api/v2/rooms");
  }

  createRoom(input: {
    name: string;
    slug?: string;
    topic?: string;
    maxAgentHops?: number;
  }): Promise<{ room: RoomSummary }> {
    return this.request("POST", "/api/v2/rooms", input);
  }

  listRoomMembers(roomId: string): Promise<{ members: RoomMemberRecord[] }> {
    return this.request("GET", `/api/v2/rooms/${encodeURIComponent(roomId)}/members`);
  }

  addRoomMember(roomId: string, username: string): Promise<{ ok: boolean }> {
    return this.request("POST", `/api/v2/rooms/${encodeURIComponent(roomId)}/members`, {
      username,
    });
  }

  listRoomMessages(
    roomId: string,
    opts: { sinceSeq?: number; limit?: number } = {},
  ): Promise<{ messages: RoomMessage[] }> {
    const params = new URLSearchParams();
    if (opts.sinceSeq !== undefined) params.set("sinceSeq", String(opts.sinceSeq));
    if (opts.limit !== undefined) params.set("limit", String(opts.limit));
    const qs = params.toString();
    return this.request(
      "GET",
      `/api/v2/rooms/${encodeURIComponent(roomId)}/messages${qs ? `?${qs}` : ""}`,
    );
  }

  sendRoomMessage(
    roomId: string,
    input: {
      content: string;
      senderNodeId?: string;
      hopChainId?: string;
      resetLoop?: boolean;
    },
  ): Promise<{ message: RoomMessage }> {
    return this.request(
      "POST",
      `/api/v2/rooms/${encodeURIComponent(roomId)}/messages`,
      input,
    );
  }

  markRoomRead(roomId: string, seq: number): Promise<{ ok: boolean }> {
    return this.request("POST", `/api/v2/rooms/${encodeURIComponent(roomId)}/read`, {
      seq,
    });
  }

  getServerInbox(opts: {
    handle?: string;
    unreadOnly?: boolean;
  } = {}): Promise<{ items: InboxItem[] }> {
    const params = new URLSearchParams();
    if (opts.handle) params.set("handle", opts.handle);
    if (opts.unreadOnly !== undefined) {
      params.set("unreadOnly", String(opts.unreadOnly));
    }
    const qs = params.toString();
    return this.request("GET", `/api/v2/inbox${qs ? `?${qs}` : ""}`);
  }
}
