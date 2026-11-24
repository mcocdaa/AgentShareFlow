import {
  ServerToClientFrameSchema,
  type ClientToServerFrame,
  type DmMessage,
  type FriendRecord,
  type IceServerConfig,
  type InboxItem,
  type NodePresence,
  type PairCodeRecord,
  type RoomMessage,
  type RoomSummary,
  type ServerToClientFrame,
  type TransportMode,
  type UserProfile,
  type UserRole,
} from "@agentshare/core/protocol";

export interface HealthResponse {
  ok: boolean;
  version: string;
  relayEnabled: boolean;
}

export interface ServerInfo {
  version: string;
  relayEnabled: boolean;
  needsBootstrap: boolean;
  maxAgentHops: number;
  iceServers?: IceServerConfig[];
}

export interface InviteRecord {
  code: string;
  createdBy?: string | null;
  role: UserRole;
  maxUses: number;
  usedCount: number;
  expiresAt: number | null;
  createdAt: number;
}

export interface RoomMember {
  userId: string;
  username: string;
  displayName: string;
  role: string;
  joinedAt?: number;
}

export interface LocalNodeConfig {
  url: string;
  token: string;
}

export interface LocalNodeStatus {
  nodeId: string;
  handle: string;
  directUrl: string | null;
  online: boolean;
  relayEnabled: boolean;
  webrtcEnabled?: boolean;
  serverUrl: string;
}

export interface PendingApproval {
  id: string;
  kind: string;
  fromHandle: string;
  fromNodeId: string | null;
  roomId: string | null;
  messageId: string;
  content: string;
  hopChainId?: string | null;
  status: string;
  createdAt: number;
}

export type WsConnectionState =
  | "connecting"
  | "connected"
  | "disconnected"
  | "unauthorized";

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

const TOKEN_STORAGE_KEY = "agentshare_token";
const LOCAL_NODE_STORAGE_KEY = "agentshare_local_node";

export function loadStoredToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function saveStoredToken(token: string | null): void {
  try {
    if (token) {
      window.localStorage.setItem(TOKEN_STORAGE_KEY, token);
    } else {
      window.localStorage.removeItem(TOKEN_STORAGE_KEY);
    }
  } catch {
    // Ignore storage restriction
  }
}

export function loadLocalNodeConfig(): LocalNodeConfig | null {
  try {
    const raw = window.localStorage.getItem(LOCAL_NODE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LocalNodeConfig>;
    if (typeof parsed.url === "string" && typeof parsed.token === "string") {
      return { url: parsed.url, token: parsed.token };
    }
    return null;
  } catch {
    return null;
  }
}

export function saveLocalNodeConfig(config: LocalNodeConfig | null): void {
  try {
    if (config) {
      window.localStorage.setItem(LOCAL_NODE_STORAGE_KEY, JSON.stringify(config));
    } else {
      window.localStorage.removeItem(LOCAL_NODE_STORAGE_KEY);
    }
  } catch {
    // Ignore storage restriction
  }
}

async function requestJson<T>(
  url: string,
  options: {
    method?: string;
    token?: string | null;
    body?: unknown;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    signal: options.signal,
  });

  const text = await response.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text };
    }
  }

  if (!response.ok) {
    const obj = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
    const message =
      (typeof obj.error === "string" && obj.error) ||
      (typeof obj.message === "string" && obj.message) ||
      `HTTP ${response.status}`;
    const code = typeof obj.code === "string" ? obj.code : undefined;
    throw new ApiError(response.status, message, code);
  }

  return data as T;
}

export const serverApi = {
  health(): Promise<HealthResponse> {
    return requestJson<HealthResponse>("/healthz");
  },

  serverInfo(): Promise<ServerInfo> {
    return requestJson<ServerInfo>("/api/v2/server/info");
  },

  register(input: {
    username: string;
    password: string;
    displayName?: string;
    inviteCode: string;
  }): Promise<{ token: string; user: UserProfile }> {
    return requestJson("/api/v2/auth/register", { method: "POST", body: input });
  },

  login(input: {
    username: string;
    password: string;
  }): Promise<{ token: string; user: UserProfile }> {
    return requestJson("/api/v2/auth/login", { method: "POST", body: input });
  },

  logout(token: string): Promise<{ ok: boolean }> {
    return requestJson("/api/v2/auth/logout", { method: "POST", token });
  },

  me(token: string): Promise<{ user: UserProfile }> {
    return requestJson("/api/v2/me", { token });
  },

  listInvites(token: string): Promise<{ invites: InviteRecord[] }> {
    return requestJson("/api/v2/admin/invites", { token });
  },

  createInvite(
    token: string,
    input: { maxUses?: number; expiresInHours?: number; role?: UserRole },
  ): Promise<{ invite: InviteRecord }> {
    return requestJson("/api/v2/admin/invites", {
      method: "POST",
      token,
      body: input,
    });
  },

  updateSettings(
    token: string,
    input: { enableRelay: boolean },
  ): Promise<{ relayEnabled: boolean }> {
    return requestJson("/api/v2/admin/settings", {
      method: "PATCH",
      token,
      body: input,
    });
  },

  listFriends(token: string): Promise<{ friends: FriendRecord[] }> {
    return requestJson("/api/v2/friends", { token });
  },

  requestFriend(
    token: string,
    username: string,
  ): Promise<{ friend: FriendRecord }> {
    return requestJson("/api/v2/friends/request", {
      method: "POST",
      token,
      body: { username },
    });
  },

  acceptFriend(token: string, id: string): Promise<{ friend: FriendRecord }> {
    return requestJson(`/api/v2/friends/${encodeURIComponent(id)}/accept`, {
      method: "POST",
      token,
    });
  },

  deleteFriend(token: string, id: string): Promise<{ ok: boolean }> {
    return requestJson(`/api/v2/friends/${encodeURIComponent(id)}`, {
      method: "DELETE",
      token,
    });
  },

  createPairCode(
    token: string,
    input: { nodeId?: string; maxUses?: number; expiresInMinutes?: number },
  ): Promise<{ pairCode: PairCodeRecord }> {
    return requestJson("/api/v2/pair-codes", {
      method: "POST",
      token,
      body: input,
    });
  },

  redeemPairCode(
    token: string,
    code: string,
  ): Promise<{ ok: boolean; creatorUserId: string; nodes: NodePresence[] }> {
    return requestJson("/api/v2/pair-codes/redeem", {
      method: "POST",
      token,
      body: { code },
    });
  },

  listNodes(token: string): Promise<{ nodes: NodePresence[] }> {
    return requestJson("/api/v2/nodes", { token });
  },

  listRooms(token: string): Promise<{ rooms: RoomSummary[] }> {
    return requestJson("/api/v2/rooms", { token });
  },

  createRoom(
    token: string,
    input: { name: string; slug?: string; topic?: string; maxAgentHops?: number },
  ): Promise<{ room: RoomSummary }> {
    return requestJson("/api/v2/rooms", {
      method: "POST",
      token,
      body: input,
    });
  },

  async listRoomMembers(
    token: string,
    roomId: string,
  ): Promise<{ members: RoomMember[] }> {
    const raw = await requestJson<{
      members: Array<Partial<RoomMember> & { id?: string }>;
    }>(`/api/v2/rooms/${encodeURIComponent(roomId)}/members`, { token });
    const members: RoomMember[] = (raw.members ?? []).map((m) => ({
      userId: m.userId ?? m.id ?? "",
      username: m.username ?? "",
      displayName: m.displayName ?? m.username ?? "",
      role: m.role ?? "member",
      joinedAt: m.joinedAt,
    }));
    return { members };
  },

  addRoomMember(
    token: string,
    roomId: string,
    username: string,
  ): Promise<{ ok: boolean }> {
    return requestJson(`/api/v2/rooms/${encodeURIComponent(roomId)}/members`, {
      method: "POST",
      token,
      body: { username },
    });
  },

  listRoomMessages(
    token: string,
    roomId: string,
    opts?: { sinceSeq?: number; limit?: number },
  ): Promise<{ messages: RoomMessage[] }> {
    const params = new URLSearchParams();
    if (opts?.sinceSeq !== undefined) params.set("sinceSeq", String(opts.sinceSeq));
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    const qs = params.toString();
    return requestJson(
      `/api/v2/rooms/${encodeURIComponent(roomId)}/messages${qs ? `?${qs}` : ""}`,
      { token },
    );
  },

  sendRoomMessage(
    token: string,
    roomId: string,
    input: { content: string; resetLoop?: boolean },
  ): Promise<{ message: RoomMessage }> {
    return requestJson(`/api/v2/rooms/${encodeURIComponent(roomId)}/messages`, {
      method: "POST",
      token,
      body: input,
    });
  },

  markRoomRead(token: string, roomId: string, seq: number): Promise<{ ok: boolean }> {
    return requestJson(`/api/v2/rooms/${encodeURIComponent(roomId)}/read`, {
      method: "POST",
      token,
      body: { seq },
    });
  },

  listInbox(
    token: string,
    opts?: { unreadOnly?: boolean },
  ): Promise<{ items: InboxItem[] }> {
    const qs = opts?.unreadOnly ? "?unreadOnly=true" : "";
    return requestJson(`/api/v2/inbox${qs}`, { token });
  },
};

function normalizeBaseUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim().replace(/\/+$/, "");
  const parsed = new URL(trimmed);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Local node URL must start with http:// or https://");
  }
  return trimmed;
}

export class LocalNodeClient {
  readonly baseUrl: string;
  readonly token: string;

  constructor(config: LocalNodeConfig) {
    this.baseUrl = normalizeBaseUrl(config.url);
    this.token = config.token.trim();
  }

  status(signal?: AbortSignal): Promise<LocalNodeStatus> {
    return requestJson<LocalNodeStatus>(`${this.baseUrl}/local/status`, {
      token: this.token,
      signal,
    });
  }

  listDms(
    peerHandle: string,
    limit = 50,
    signal?: AbortSignal,
  ): Promise<{ messages: DmMessage[] }> {
    const params = new URLSearchParams({
      peer: peerHandle,
      limit: String(limit),
    });
    return requestJson(`${this.baseUrl}/local/dms?${params.toString()}`, {
      token: this.token,
      signal,
    });
  }

  sendDm(
    peerHandle: string,
    content: string,
    forceRelay?: boolean,
  ): Promise<{ message: DmMessage; transport: TransportMode }> {
    return requestJson(`${this.baseUrl}/local/dms`, {
      method: "POST",
      token: this.token,
      body: { peer: peerHandle, content, forceRelay },
    });
  }

  listApprovals(
    status = "pending",
    signal?: AbortSignal,
  ): Promise<{ approvals: PendingApproval[] }> {
    const params = new URLSearchParams({ status });
    return requestJson(`${this.baseUrl}/local/approvals?${params.toString()}`, {
      token: this.token,
      signal,
    });
  }

  approve(id: string): Promise<{ ok: boolean; reply?: string | null }> {
    return requestJson(
      `${this.baseUrl}/local/approvals/${encodeURIComponent(id)}/approve`,
      { method: "POST", token: this.token },
    );
  }

  reject(id: string): Promise<{ ok: boolean }> {
    return requestJson(
      `${this.baseUrl}/local/approvals/${encodeURIComponent(id)}/reject`,
      { method: "POST", token: this.token },
    );
  }
}

export interface ServerWsHandlers {
  onFrame: (frame: ServerToClientFrame) => void;
  onStateChange: (state: WsConnectionState) => void;
  onAuthFailure: () => void;
}

export class ServerWsClient {
  private readonly token: string;
  private readonly handlers: ServerWsHandlers;
  private ws: WebSocket | null = null;
  private closed = false;
  private reconnectAttempt = 0;
  private reconnectTimer: number | null = null;
  private pingTimer: number | null = null;
  private readonly subscribedRooms = new Set<string>();

  constructor(token: string, handlers: ServerWsHandlers) {
    this.token = token;
    this.handlers = handlers;
  }

  connect(): void {
    if (this.closed) return;
    this.clearTimers();
    this.handlers.onStateChange("connecting");

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${window.location.host}/ws?token=${encodeURIComponent(this.token)}`;
    const socket = new WebSocket(url);
    this.ws = socket;

    let opened = false;

    socket.addEventListener("open", () => {
      if (this.closed || this.ws !== socket) return;
      opened = true;
      this.reconnectAttempt = 0;
      this.handlers.onStateChange("connected");
      for (const roomId of this.subscribedRooms) {
        this.sendFrame({ type: "room.subscribe", roomId });
      }
      this.pingTimer = window.setInterval(() => {
        this.sendFrame({ type: "ping" });
      }, 25_000);
    });

    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(event.data);
      } catch {
        return;
      }
      const parsed = ServerToClientFrameSchema.safeParse(parsedJson);
      if (parsed.success) {
        this.handlers.onFrame(parsed.data);
      }
    });

    socket.addEventListener("close", (event) => {
      if (this.ws === socket) {
        this.ws = null;
      }
      this.clearTimers();
      if (this.closed) return;

      // Close code 4001 indicates an invalid/revoked session token; never reconnect.
      if (event.code === 4001) {
        this.closed = true;
        this.handlers.onStateChange("unauthorized");
        this.handlers.onAuthFailure();
        return;
      }

      // HTTP 401 rejected before WS upgrade surfaces as abnormal close (1006) without open.
      if (!opened && event.code === 1006) {
        void serverApi.me(this.token).catch((err) => {
          if (!this.closed && err instanceof ApiError && err.status === 401) {
            this.closed = true;
            this.clearTimers();
            this.handlers.onStateChange("unauthorized");
            this.handlers.onAuthFailure();
          }
        });
      }

      this.handlers.onStateChange("disconnected");
      const baseDelay = Math.min(1000 * 2 ** this.reconnectAttempt, 15_000);
      this.reconnectAttempt += 1;
      const jitter = Math.floor(Math.random() * 400);
      this.reconnectTimer = window.setTimeout(() => {
        this.connect();
      }, baseDelay + jitter);
    });

    socket.addEventListener("error", () => {
      // Browser always fires close after error; let close manage backoff.
    });
  }

  subscribeRoom(roomId: string): void {
    this.subscribedRooms.add(roomId);
    this.sendFrame({ type: "room.subscribe", roomId });
  }

  sendFrame(frame: ClientToServerFrame): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(frame));
    }
  }

  close(): void {
    this.closed = true;
    this.clearTimers();
    if (this.ws) {
      try {
        this.ws.close(1000, "client closing");
      } catch {
        // Ignore close error
      }
      this.ws = null;
    }
  }

  private clearTimers(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pingTimer !== null) {
      window.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}
