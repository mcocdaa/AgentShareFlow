import { randomUUID } from "node:crypto";
import {
  ClientToServerFrameSchema,
  extractMentions,
  type InboxItem,
  type RoomMessage,
  type ServerToClientFrame,
  type UserProfile,
} from "@agentshare/core";
import { WebSocket, type RawData } from "ws";
import { DbError, type ServerDb } from "./db.js";

const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_ROOM_MESSAGE_LENGTH = 32_768;

interface ClientConnection {
  id: string;
  ws: WebSocket;
  user: UserProfile;
  tokenHash: string;
  nodeId: string | null;
  handle: string | null;
  subscribedRooms: Set<string>;
  alive: boolean;
  closed: boolean;
}

export interface PostRoomMessageInput {
  roomIdOrSlug: string;
  user: UserProfile;
  content: string;
  senderNodeId?: string;
  hopChainId?: string;
  resetLoop?: boolean;
}

export class ServerHub {
  private readonly db: ServerDb;
  private readonly connections = new Set<ClientConnection>();
  private readonly byUserId = new Map<string, Set<ClientConnection>>();
  private readonly byNodeId = new Map<string, ClientConnection>();
  private readonly byRoomId = new Map<string, Set<ClientConnection>>();
  private readonly heartbeatTimer: NodeJS.Timeout;

  constructor(db: ServerDb) {
    this.db = db;
    this.heartbeatTimer = setInterval(() => {
      for (const conn of this.connections) {
        if (!conn.alive) {
          conn.ws.terminate();
          this.detachConnection(conn);
          continue;
        }
        conn.alive = false;
        if (conn.ws.readyState === WebSocket.OPEN) {
          conn.ws.ping();
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref();
  }

  isNodeOnline = (nodeId: string): boolean => {
    const conn = this.byNodeId.get(nodeId);
    return conn !== undefined && conn.ws.readyState === WebSocket.OPEN;
  };

  private sendFrame(conn: ClientConnection, frame: ServerToClientFrame): boolean {
    if (conn.ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    try {
      conn.ws.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }

  sendToUser(userId: string, frame: ServerToClientFrame): number {
    const set = this.byUserId.get(userId);
    if (!set) return 0;
    let sent = 0;
    for (const conn of set) {
      if (this.sendFrame(conn, frame)) {
        sent += 1;
      }
    }
    return sent;
  }

  sendToNode(nodeId: string, frame: ServerToClientFrame): boolean {
    const conn = this.byNodeId.get(nodeId);
    if (!conn) return false;
    return this.sendFrame(conn, frame);
  }

  broadcastToRoomMembers(roomId: string, frame: ServerToClientFrame): void {
    const memberUserIds = this.db.listRoomMemberUserIds(roomId);
    const delivered = new Set<ClientConnection>();
    for (const userId of memberUserIds) {
      const conns = this.byUserId.get(userId);
      if (!conns) continue;
      for (const conn of conns) {
        if (delivered.has(conn)) continue;
        delivered.add(conn);
        this.sendFrame(conn, frame);
      }
    }
  }

  broadcastAll(frame: ServerToClientFrame): void {
    for (const conn of this.connections) {
      this.sendFrame(conn, frame);
    }
  }

  disconnectSession(tokenHash: string): void {
    for (const conn of [...this.connections]) {
      if (conn.tokenHash === tokenHash) {
        try {
          conn.ws.close(4001, "Session revoked");
        } catch {
          conn.ws.terminate();
        }
        this.detachConnection(conn);
      }
    }
  }

  disconnectNode(nodeId: string): void {
    const conn = this.byNodeId.get(nodeId);
    if (!conn) return;
    this.byNodeId.delete(nodeId);
    conn.nodeId = null;
    conn.handle = null;
    this.broadcastPresenceUpdate(nodeId, conn.user.id);
  }

  handleConnection(ws: WebSocket, user: UserProfile, tokenHash: string): void {
    const conn: ClientConnection = {
      id: randomUUID(),
      ws,
      user,
      tokenHash,
      nodeId: null,
      handle: null,
      subscribedRooms: new Set(),
      alive: true,
      closed: false,
    };

    this.connections.add(conn);
    let userSet = this.byUserId.get(user.id);
    if (!userSet) {
      userSet = new Set();
      this.byUserId.set(user.id, userSet);
    }
    userSet.add(conn);

    ws.on("pong", () => {
      conn.alive = true;
    });

    ws.on("message", (raw: RawData) => {
      conn.alive = true;
      this.handleRawMessage(conn, raw);
    });

    ws.on("close", () => {
      this.detachConnection(conn);
    });

    ws.on("error", () => {
      this.detachConnection(conn);
    });
  }

  private detachConnection(conn: ClientConnection): void {
    if (conn.closed) return;
    conn.closed = true;

    this.connections.delete(conn);

    const userSet = this.byUserId.get(conn.user.id);
    if (userSet) {
      userSet.delete(conn);
      if (userSet.size === 0) {
        this.byUserId.delete(conn.user.id);
      }
    }

    for (const roomId of conn.subscribedRooms) {
      const roomSet = this.byRoomId.get(roomId);
      if (roomSet) {
        roomSet.delete(conn);
        if (roomSet.size === 0) {
          this.byRoomId.delete(roomId);
        }
      }
    }
    conn.subscribedRooms.clear();

    if (conn.nodeId && this.byNodeId.get(conn.nodeId) === conn) {
      const offlineNodeId = conn.nodeId;
      this.byNodeId.delete(offlineNodeId);
      conn.nodeId = null;
      conn.handle = null;
      this.db.touchNodeLastSeen(offlineNodeId);
      this.broadcastPresenceUpdate(offlineNodeId, conn.user.id);
    }
  }

  private broadcastPresenceUpdate(nodeId: string, ownerUserId: string): void {
    const node = this.db.getNodeById(nodeId, this.isNodeOnline);
    if (!node) return;
    const peerUserIds = this.db.listAuthorizedPeerUserIds(ownerUserId);
    const frame: ServerToClientFrame = {
      type: "presence.update",
      node,
    };
    for (const peerUserId of peerUserIds) {
      this.sendToUser(peerUserId, frame);
    }
  }

  private handleRawMessage(conn: ClientConnection, raw: RawData): void {
    const text =
      typeof raw === "string"
        ? raw
        : Buffer.isBuffer(raw)
          ? raw.toString("utf8")
          : Array.isArray(raw)
            ? Buffer.concat(raw).toString("utf8")
            : Buffer.from(raw).toString("utf8");

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(text);
    } catch {
      this.sendFrame(conn, {
        type: "error",
        code: "INVALID_JSON",
        message: "Malformed JSON WebSocket frame",
      });
      return;
    }

    const parsed = ClientToServerFrameSchema.safeParse(parsedJson);
    if (!parsed.success) {
      this.sendFrame(conn, {
        type: "error",
        code: "INVALID_FRAME",
        message: parsed.error.issues[0]?.message ?? "Invalid frame schema",
      });
      return;
    }

    const frame = parsed.data;
    switch (frame.type) {
      case "ping": {
        this.sendFrame(conn, { type: "pong" });
        return;
      }

      case "node.register": {
        try {
          const previousNodeId = conn.nodeId;
          const existingOnline = this.byNodeId.get(frame.nodeId);
          if (existingOnline && existingOnline !== conn) {
            existingOnline.nodeId = null;
            existingOnline.handle = null;
            this.byNodeId.delete(frame.nodeId);
          }

          const registered = this.db.upsertNode(
            {
              nodeId: frame.nodeId,
              ownerUserId: conn.user.id,
              handle: frame.handle,
              displayName: frame.displayName,
              kind: frame.kind,
              description: frame.description,
              capabilities: frame.capabilities,
              signPublicKey: frame.signPublicKey,
              kxPublicKey: frame.kxPublicKey,
              directUrl: frame.directUrl,
            },
            (id) => id === frame.nodeId || this.isNodeOnline(id),
          );

          if (previousNodeId && previousNodeId !== registered.nodeId) {
            if (this.byNodeId.get(previousNodeId) === conn) {
              this.byNodeId.delete(previousNodeId);
              this.broadcastPresenceUpdate(previousNodeId, conn.user.id);
            }
          }

          conn.nodeId = registered.nodeId;
          conn.handle = registered.handle;
          this.byNodeId.set(registered.nodeId, conn);

          const liveNode = { ...registered, online: true };
          this.sendFrame(conn, {
            type: "node.registered",
            node: liveNode,
            relayEnabled: this.db.getRelayEnabled(),
          });
          this.broadcastPresenceUpdate(registered.nodeId, conn.user.id);
        } catch (err) {
          if (err instanceof DbError) {
            this.sendFrame(conn, {
              type: "error",
              code: err.code,
              message: err.message,
            });
            return;
          }
          this.sendFrame(conn, {
            type: "error",
            code: "REGISTER_FAILED",
            message: err instanceof Error ? err.message : "Registration failed",
          });
        }
        return;
      }

      case "room.subscribe": {
        const room = this.db.findRoomByIdOrSlug(frame.roomId);
        if (!room) {
          this.sendFrame(conn, {
            type: "error",
            code: "NOT_FOUND",
            message: "Room not found",
          });
          return;
        }
        if (!this.db.isRoomMember(room.id, conn.user.id)) {
          this.sendFrame(conn, {
            type: "error",
            code: "FORBIDDEN",
            message: "Not a member of this room",
          });
          return;
        }
        conn.subscribedRooms.add(room.id);
        let set = this.byRoomId.get(room.id);
        if (!set) {
          set = new Set();
          this.byRoomId.set(room.id, set);
        }
        set.add(conn);
        return;
      }

      case "room.send": {
        try {
          this.postRoomMessage({
            roomIdOrSlug: frame.roomId,
            user: conn.user,
            content: frame.content,
            senderNodeId: frame.senderNodeId,
            hopChainId: frame.hopChainId,
            resetLoop: frame.resetLoop,
          });
        } catch (err) {
          if (err instanceof DbError) {
            this.sendFrame(conn, {
              type: "error",
              code: err.code,
              message: err.message,
            });
            return;
          }
          this.sendFrame(conn, {
            type: "error",
            code: "ROOM_SEND_FAILED",
            message: err instanceof Error ? err.message : "Failed to send message",
          });
        }
        return;
      }

      case "signal.offer":
      case "signal.answer": {
        if (!conn.nodeId || !conn.handle) {
          this.sendFrame(conn, {
            type: "error",
            code: "NODE_NOT_REGISTERED",
            message: "Register a node before signaling",
          });
          return;
        }
        const target = this.db.getNodeById(frame.toNodeId, this.isNodeOnline);
        if (!target) {
          this.sendFrame(conn, {
            type: "error",
            code: "NOT_FOUND",
            message: "Target node not found",
          });
          return;
        }
        if (!this.db.arePeersAuthorized(conn.user.id, target.ownerUserId)) {
          this.sendFrame(conn, {
            type: "error",
            code: "FORBIDDEN",
            message: "Peers are not authorized",
          });
          return;
        }
        const delivered = this.sendToNode(target.nodeId, {
          type: "signal.deliver",
          fromNodeId: conn.nodeId,
          fromHandle: conn.handle,
          signalType: frame.signalType,
          payload: frame.payload,
        });
        if (!delivered) {
          this.sendFrame(conn, {
            type: "error",
            code: "PEER_OFFLINE",
            message: "Target node is offline",
          });
        }
        return;
      }

      case "relay.forward": {
        if (!this.db.getRelayEnabled()) {
          this.sendFrame(conn, {
            type: "error",
            code: "RELAY_DISABLED",
            message: "Server relay is disabled",
          });
          return;
        }
        if (!conn.nodeId || !conn.handle) {
          this.sendFrame(conn, {
            type: "error",
            code: "NODE_NOT_REGISTERED",
            message: "Register a node before using relay",
          });
          return;
        }
        if (
          frame.packet.fromNodeId !== conn.nodeId ||
          frame.packet.toNodeId !== frame.toNodeId
        ) {
          this.sendFrame(conn, {
            type: "error",
            code: "FORBIDDEN",
            message: "Relay packet node identifiers mismatch",
          });
          return;
        }
        const target = this.db.getNodeById(frame.toNodeId, this.isNodeOnline);
        if (!target) {
          this.sendFrame(conn, {
            type: "error",
            code: "PEER_OFFLINE",
            message: "Target node not found or offline",
          });
          return;
        }
        if (!this.db.arePeersAuthorized(conn.user.id, target.ownerUserId)) {
          this.sendFrame(conn, {
            type: "error",
            code: "FORBIDDEN",
            message: "Peers are not authorized",
          });
          return;
        }
        const delivered = this.sendToNode(target.nodeId, {
          type: "relay.deliver",
          fromNodeId: conn.nodeId,
          fromHandle: conn.handle,
          packet: frame.packet,
        });
        if (!delivered) {
          this.sendFrame(conn, {
            type: "error",
            code: "PEER_OFFLINE",
            message: "Target node is offline",
          });
        }
        return;
      }
    }
  }

  postRoomMessage(input: PostRoomMessageInput): RoomMessage {
    const content = input.content.trim();
    if (!content || content.length > MAX_ROOM_MESSAGE_LENGTH) {
      throw new DbError(
        400,
        "INVALID_CONTENT",
        "Message content must be between 1 and 32768 characters",
      );
    }

    const room = this.db.findRoomByIdOrSlug(input.roomIdOrSlug);
    if (!room) {
      throw new DbError(404, "NOT_FOUND", "Room not found");
    }
    if (!this.db.isRoomMember(room.id, input.user.id)) {
      throw new DbError(403, "FORBIDDEN", "Not a member of this room");
    }

    let senderType: "human" | "agent" = "human";
    let senderNodeId: string | null = null;
    let senderHandle = input.user.username;

    if (input.senderNodeId) {
      const node = this.db.getNodeById(input.senderNodeId, this.isNodeOnline);
      if (!node || node.ownerUserId !== input.user.id) {
        throw new DbError(
          403,
          "FORBIDDEN",
          "senderNodeId does not belong to authenticated user",
        );
      }
      senderType = "agent";
      senderNodeId = node.nodeId;
      senderHandle = node.handle;
    }

    const mentions = extractMentions(content);
    const message = this.db.insertRoomMessage({
      roomId: room.id,
      senderType,
      senderUserId: input.user.id,
      senderNodeId,
      senderHandle,
      content,
      mentions,
      requestedHopChainId: input.hopChainId,
      maxAgentHops: room.max_agent_hops,
    });

    this.broadcastToRoomMembers(room.id, {
      type: "room.message",
      message,
    });

    if (message.loopBroken) {
      this.broadcastToRoomMembers(room.id, {
        type: "room.loop_broken",
        roomId: room.id,
        hopChainId: message.hopChainId ?? "",
        hopCount: message.hopCount,
        maxAgentHops: room.max_agent_hops,
        message,
      });
      return message;
    }

    if (message.mentions.length > 0) {
      this.emitInboxMentions(room.id, room.name, message);
    }

    return message;
  }

  private emitInboxMentions(
    roomId: string,
    roomName: string,
    message: RoomMessage,
  ): void {
    const memberSet = new Set(this.db.listRoomMemberUserIds(roomId));
    const senderLower = message.senderHandle.toLowerCase();
    const item: InboxItem = {
      id: `mention:${message.id}`,
      kind: "room_mention",
      fromHandle: message.senderHandle,
      fromNodeId: message.senderNodeId,
      roomId,
      roomName,
      messageId: message.id,
      preview: message.content.slice(0, 200),
      createdAt: message.createdAt,
      read: false,
    };
    const frame: ServerToClientFrame = {
      type: "inbox.mention",
      item,
      message,
    };

    const notified = new Set<ClientConnection>();
    const notifySocket = (conn: ClientConnection | undefined) => {
      if (!conn || notified.has(conn)) return;
      notified.add(conn);
      this.sendFrame(conn, frame);
    };

    const notifyUserNonNodeSockets = (userId: string) => {
      const conns = this.byUserId.get(userId);
      if (!conns) return;
      for (const conn of conns) {
        // Target only human/WebUI sessions here so unrelated agent nodes owned by the same user are never woken.
        if (conn.nodeId === null) {
          notifySocket(conn);
        }
      }
    };

    for (const mention of message.mentions) {
      if (mention === senderLower) continue;

      const node = this.db.getNodeByHandleOrId(mention, this.isNodeOnline);
      if (node && node.handle === mention && memberSet.has(node.ownerUserId)) {
        if (node.nodeId !== message.senderNodeId) {
          notifySocket(this.byNodeId.get(node.nodeId));
          if (
            !(
              message.senderType === "human" &&
              message.senderUserId === node.ownerUserId
            )
          ) {
            notifyUserNonNodeSockets(node.ownerUserId);
          }
        }
      }

      const targetUser = this.db.getUserByUsername(mention);
      if (targetUser && memberSet.has(targetUser.id)) {
        if (
          !(
            message.senderType === "human" &&
            message.senderUserId === targetUser.id
          )
        ) {
          notifyUserNonNodeSockets(targetUser.id);
        }
      }
    }
  }

  close(): void {
    clearInterval(this.heartbeatTimer);
    for (const conn of [...this.connections]) {
      try {
        conn.ws.close(1001, "Server shutting down");
      } catch {
        conn.ws.terminate();
      }
      this.detachConnection(conn);
    }
  }
}
