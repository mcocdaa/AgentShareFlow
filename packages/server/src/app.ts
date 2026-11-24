import {
  DEFAULT_MAX_AGENT_HOPS,
  HANDLE_PATTERN,
  UserRoleSchema,
  type IceServerConfig,
  type UserProfile,
} from "@agentshare/core";
import { Hono, type Context } from "hono";
import {
  extractBearerToken,
  hashPassword,
  mintSessionToken,
  resolveSession,
  revokeSession,
  verifyPassword,
} from "./auth.js";
import { DbError, type ServerDb } from "./db.js";
import type { ServerHub } from "./hub.js";

const SERVER_VERSION = "2.1.0";
const DEFAULT_STUN_URL = "stun:stun.l.google.com:19302";

function normalizeOrigin(origin: string): string {
  return origin.trim().replace(/\/+$/, "");
}

type AppEnv = {
  Variables: {
    user: UserProfile;
    token: string;
  };
};

export interface CreateAppOptions {
  db: ServerDb;
  hub: ServerHub;
  maxAgentHops?: number;
  iceServers?: IceServerConfig[];
  corsOrigins?: string[];
}

async function readJsonBody(c: Context): Promise<Record<string, unknown>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new DbError(400, "INVALID_JSON", "Request body must be valid JSON");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new DbError(400, "INVALID_JSON", "Request body must be a JSON object");
  }
  return raw as Record<string, unknown>;
}

export function createApp(options: CreateAppOptions): Hono<AppEnv> {
  const { db, hub } = options;
  const maxAgentHops = options.maxAgentHops ?? DEFAULT_MAX_AGENT_HOPS;
  const iceServers =
    options.iceServers !== undefined
      ? options.iceServers
      : [{ urls: DEFAULT_STUN_URL }];
  const normalizedCorsOrigins = (options.corsOrigins ?? ["*"])
    .map(normalizeOrigin)
    .filter((origin) => origin.length > 0);
  const allowAnyOrigin = normalizedCorsOrigins.includes("*");
  const allowedOrigins = new Set(normalizedCorsOrigins);
  const app = new Hono<AppEnv>();

  app.onError((err, c) => {
    if (err instanceof DbError) {
      return c.json(
        { error: err.message, code: err.code },
        err.status as 400 | 401 | 403 | 404 | 409 | 410 | 500,
      );
    }
    return c.json(
      { error: "Internal server error", code: "INTERNAL_ERROR" },
      500,
    );
  });

  app.notFound((c) => c.json({ error: "Not found", code: "NOT_FOUND" }, 404));

  app.use("*", async (c, next) => {
    let originAllowed = false;
    if (allowAnyOrigin) {
      c.header("Access-Control-Allow-Origin", "*");
      originAllowed = true;
    } else {
      const requestOrigin = c.req.header("origin");
      if (requestOrigin && allowedOrigins.has(normalizeOrigin(requestOrigin))) {
        c.header("Access-Control-Allow-Origin", requestOrigin);
        c.header("Vary", "Origin", { append: true });
        originAllowed = true;
      }
    }

    if (originAllowed) {
      c.header(
        "Access-Control-Allow-Methods",
        "GET, POST, PATCH, DELETE, OPTIONS",
      );
      c.header(
        "Access-Control-Allow-Headers",
        "Authorization, Content-Type, Accept",
      );
      c.header("Access-Control-Max-Age", "86400");
    }

    if (c.req.method === "OPTIONS") {
      return c.body(null, 204);
    }

    await next();
  });

  app.get("/healthz", (c) => {
    return c.json({
      ok: true,
      version: SERVER_VERSION,
      relayEnabled: db.getRelayEnabled(),
    });
  });

  app.get("/api/v2/server/info", (c) => {
    return c.json({
      version: SERVER_VERSION,
      relayEnabled: db.getRelayEnabled(),
      needsBootstrap: db.countUsers() === 0,
      maxAgentHops,
      iceServers,
    });
  });

  app.post("/api/v2/auth/register", async (c) => {
    const body = await readJsonBody(c);
    const inviteCode =
      typeof body.inviteCode === "string" ? body.inviteCode.trim() : "";
    if (!inviteCode) {
      throw new DbError(
        403,
        "INVITE_REQUIRED",
        "Invite code is required to register",
      );
    }

    const rawUsername =
      typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
    if (!HANDLE_PATTERN.test(rawUsername)) {
      throw new DbError(
        400,
        "INVALID_USERNAME",
        "Username must be 2-32 lowercase alphanumeric, underscore, or hyphen characters",
      );
    }

    const password = typeof body.password === "string" ? body.password : "";
    if (password.length < 8 || password.length > 256) {
      throw new DbError(
        400,
        "INVALID_PASSWORD",
        "Password must be between 8 and 256 characters",
      );
    }

    const displayName =
      typeof body.displayName === "string" && body.displayName.trim().length > 0
        ? body.displayName.trim().slice(0, 64)
        : rawUsername;

    const user = db.registerWithInvite({
      inviteCode,
      username: rawUsername,
      displayName,
      passwordHash: hashPassword(password),
    });
    const { token } = mintSessionToken(db, user.id);
    return c.json({ token, user }, 201);
  });

  app.post("/api/v2/auth/login", async (c) => {
    const body = await readJsonBody(c);
    const username =
      typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!username || !password) {
      throw new DbError(
        401,
        "INVALID_CREDENTIALS",
        "Invalid username or password",
      );
    }

    const row = db.getUserByUsername(username);
    if (!row || !verifyPassword(password, row.password_hash)) {
      throw new DbError(
        401,
        "INVALID_CREDENTIALS",
        "Invalid username or password",
      );
    }

    const user: UserProfile = {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      role: row.role,
      createdAt: row.created_at,
    };
    const { token } = mintSessionToken(db, user.id);
    return c.json({ token, user }, 200);
  });

  const requireAuth = async (c: Context<AppEnv>, next: () => Promise<void>) => {
    const token = extractBearerToken(c.req.header("authorization"));
    if (!token) {
      return c.json(
        { error: "Authentication required", code: "UNAUTHORIZED" },
        401,
      );
    }
    const user = resolveSession(db, token);
    if (!user) {
      return c.json(
        { error: "Invalid or expired session", code: "UNAUTHORIZED" },
        401,
      );
    }
    c.set("user", user);
    c.set("token", token);
    await next();
  };

  const requireAdmin = async (
    c: Context<AppEnv>,
    next: () => Promise<void>,
  ) => {
    const user = c.get("user");
    if (user.role !== "admin") {
      return c.json(
        { error: "Admin role required", code: "FORBIDDEN" },
        403,
      );
    }
    await next();
  };

  app.use("/api/v2/auth/logout", requireAuth);
  app.use("/api/v2/me", requireAuth);
  app.use("/api/v2/admin/*", requireAuth, requireAdmin);
  app.use("/api/v2/friends", requireAuth);
  app.use("/api/v2/friends/*", requireAuth);
  app.use("/api/v2/pair-codes", requireAuth);
  app.use("/api/v2/pair-codes/*", requireAuth);
  app.use("/api/v2/nodes", requireAuth);
  app.use("/api/v2/nodes/*", requireAuth);
  app.use("/api/v2/rooms", requireAuth);
  app.use("/api/v2/rooms/*", requireAuth);
  app.use("/api/v2/inbox", requireAuth);

  app.post("/api/v2/auth/logout", (c) => {
    const tokenHash = revokeSession(db, c.get("token"));
    hub.disconnectSession(tokenHash);
    return c.json({ ok: true });
  });

  app.get("/api/v2/me", (c) => {
    return c.json({ user: c.get("user") });
  });

  app.get("/api/v2/admin/invites", (c) => {
    return c.json({ invites: db.listInvites() });
  });

  app.post("/api/v2/admin/invites", async (c) => {
    const body = await readJsonBody(c);
    const maxUsesRaw = body.maxUses ?? 1;
    if (
      typeof maxUsesRaw !== "number" ||
      !Number.isInteger(maxUsesRaw) ||
      maxUsesRaw < 1 ||
      maxUsesRaw > 1000
    ) {
      throw new DbError(400, "INVALID_INPUT", "maxUses must be an integer 1..1000");
    }

    const expiresInHoursRaw = body.expiresInHours ?? 168;
    if (
      typeof expiresInHoursRaw !== "number" ||
      !Number.isFinite(expiresInHoursRaw) ||
      expiresInHoursRaw <= 0 ||
      expiresInHoursRaw > 8760
    ) {
      throw new DbError(
        400,
        "INVALID_INPUT",
        "expiresInHours must be between 0 and 8760",
      );
    }

    const roleParsed = UserRoleSchema.safeParse(body.role ?? "member");
    if (!roleParsed.success) {
      throw new DbError(400, "INVALID_INPUT", "role must be 'admin' or 'member'");
    }

    const invite = db.createInvite({
      createdBy: c.get("user").id,
      role: roleParsed.data,
      maxUses: maxUsesRaw,
      expiresAt: Date.now() + Math.round(expiresInHoursRaw * 3_600_000),
    });
    return c.json({ invite }, 201);
  });

  app.patch("/api/v2/admin/settings", async (c) => {
    const body = await readJsonBody(c);
    const nextRelay =
      typeof body.enableRelay === "boolean"
        ? body.enableRelay
        : typeof body.relayEnabled === "boolean"
          ? body.relayEnabled
          : undefined;
    if (nextRelay !== undefined) {
      db.setRelayEnabled(nextRelay);
      hub.broadcastAll({
        type: "settings.update",
        relayEnabled: nextRelay,
      });
    }
    return c.json({ relayEnabled: db.getRelayEnabled() });
  });

  app.get("/api/v2/friends", (c) => {
    return c.json({ friends: db.listFriends(c.get("user").id) });
  });

  app.post("/api/v2/friends/request", async (c) => {
    const body = await readJsonBody(c);
    const username =
      typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
    if (!username) {
      throw new DbError(400, "INVALID_INPUT", "username is required");
    }
    const friend = db.createFriendRequest(c.get("user").id, username);
    return c.json({ friend }, 201);
  });

  app.post("/api/v2/friends/:id/accept", (c) => {
    const friend = db.acceptFriendRequest(c.req.param("id"), c.get("user").id);
    return c.json({ friend });
  });

  app.delete("/api/v2/friends/:id", (c) => {
    const result = db.deleteFriendship(c.req.param("id"), c.get("user").id);
    if (result === "not_found") {
      throw new DbError(404, "NOT_FOUND", "Friendship not found");
    }
    if (result === "forbidden") {
      throw new DbError(403, "FORBIDDEN", "Not permitted to remove friendship");
    }
    return c.json({ ok: true });
  });

  app.post("/api/v2/pair-codes", async (c) => {
    const body = await readJsonBody(c);
    const nodeId =
      typeof body.nodeId === "string" && body.nodeId.trim().length > 0
        ? body.nodeId.trim()
        : null;
    const maxUsesRaw = body.maxUses ?? 1;
    if (
      typeof maxUsesRaw !== "number" ||
      !Number.isInteger(maxUsesRaw) ||
      maxUsesRaw < 1 ||
      maxUsesRaw > 100
    ) {
      throw new DbError(400, "INVALID_INPUT", "maxUses must be an integer 1..100");
    }
    const expiresInMinutesRaw = body.expiresInMinutes ?? 30;
    if (
      typeof expiresInMinutesRaw !== "number" ||
      !Number.isFinite(expiresInMinutesRaw) ||
      expiresInMinutesRaw <= 0 ||
      expiresInMinutesRaw > 43200
    ) {
      throw new DbError(
        400,
        "INVALID_INPUT",
        "expiresInMinutes must be between 0 and 43200",
      );
    }

    const pairCode = db.createPairCode({
      creatorUserId: c.get("user").id,
      creatorNodeId: nodeId,
      maxUses: maxUsesRaw,
      expiresInMinutes: expiresInMinutesRaw,
    });
    return c.json({ pairCode }, 201);
  });

  app.post("/api/v2/pair-codes/redeem", async (c) => {
    const body = await readJsonBody(c);
    const code = typeof body.code === "string" ? body.code.trim() : "";
    if (!code) {
      throw new DbError(400, "INVALID_INPUT", "Pair code is required");
    }
    const { creatorUserId, nodes } = db.redeemPairCode(
      code,
      c.get("user").id,
      hub.isNodeOnline,
    );
    return c.json({ ok: true, creatorUserId, nodes });
  });

  app.get("/api/v2/nodes", (c) => {
    const nodes = db.listAuthorizedNodes(c.get("user").id, hub.isNodeOnline);
    return c.json({ nodes });
  });

  app.get("/api/v2/nodes/:handleOrId", (c) => {
    const node = db.getNodeByHandleOrId(
      c.req.param("handleOrId"),
      hub.isNodeOnline,
    );
    if (!node) {
      throw new DbError(404, "NOT_FOUND", "Node not found");
    }
    if (!db.arePeersAuthorized(c.get("user").id, node.ownerUserId)) {
      throw new DbError(403, "FORBIDDEN", "Not authorized to access this node");
    }
    return c.json({ node });
  });

  app.delete("/api/v2/nodes/:nodeId", (c) => {
    const nodeId = c.req.param("nodeId");
    const existing = db.getNodeById(nodeId, hub.isNodeOnline);
    if (!existing) {
      throw new DbError(404, "NOT_FOUND", "Node not found");
    }
    if (existing.ownerUserId !== c.get("user").id) {
      throw new DbError(403, "FORBIDDEN", "Only the owner can delete a node");
    }
    hub.disconnectNode(nodeId);
    db.deleteNode(nodeId, c.get("user").id);
    return c.json({ ok: true });
  });

  app.get("/api/v2/rooms", (c) => {
    return c.json({ rooms: db.listRoomsForUser(c.get("user").id) });
  });

  app.post("/api/v2/rooms", async (c) => {
    const body = await readJsonBody(c);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 80) {
      throw new DbError(
        400,
        "INVALID_INPUT",
        "Room name must be between 1 and 80 characters",
      );
    }
    const slug =
      typeof body.slug === "string" && body.slug.trim().length > 0
        ? body.slug.trim()
        : undefined;
    const topic =
      typeof body.topic === "string" ? body.topic.trim().slice(0, 500) : "";

    let roomMaxHops = maxAgentHops;
    if (body.maxAgentHops !== undefined) {
      if (
        typeof body.maxAgentHops !== "number" ||
        !Number.isInteger(body.maxAgentHops) ||
        body.maxAgentHops < 0 ||
        body.maxAgentHops > 50
      ) {
        throw new DbError(
          400,
          "INVALID_INPUT",
          "maxAgentHops must be an integer 0..50",
        );
      }
      roomMaxHops = body.maxAgentHops;
    }

    const room = db.createRoom({
      name,
      slug,
      topic,
      createdBy: c.get("user").id,
      maxAgentHops: roomMaxHops,
    });
    return c.json({ room }, 201);
  });

  app.get("/api/v2/rooms/:roomId/members", (c) => {
    const room = db.findRoomByIdOrSlug(c.req.param("roomId"));
    if (!room) {
      throw new DbError(404, "NOT_FOUND", "Room not found");
    }
    if (!db.isRoomMember(room.id, c.get("user").id)) {
      throw new DbError(403, "FORBIDDEN", "Not a member of this room");
    }
    return c.json({
      members: db.listRoomMembers(room.id, hub.isNodeOnline),
    });
  });

  app.post("/api/v2/rooms/:roomId/members", async (c) => {
    const room = db.findRoomByIdOrSlug(c.req.param("roomId"));
    if (!room) {
      throw new DbError(404, "NOT_FOUND", "Room not found");
    }
    if (!db.isRoomMember(room.id, c.get("user").id)) {
      throw new DbError(403, "FORBIDDEN", "Not a member of this room");
    }
    const body = await readJsonBody(c);
    const username =
      typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
    if (!username) {
      throw new DbError(400, "INVALID_INPUT", "username is required");
    }
    const target = db.getUserByUsername(username);
    if (!target) {
      throw new DbError(404, "USER_NOT_FOUND", "User not found");
    }
    db.addRoomMember(room.id, target.id);
    return c.json({ ok: true }, 201);
  });

  app.get("/api/v2/rooms/:roomId/messages", (c) => {
    const room = db.findRoomByIdOrSlug(c.req.param("roomId"));
    if (!room) {
      throw new DbError(404, "NOT_FOUND", "Room not found");
    }
    if (!db.isRoomMember(room.id, c.get("user").id)) {
      throw new DbError(403, "FORBIDDEN", "Not a member of this room");
    }
    const sinceSeqRaw = Number(c.req.query("sinceSeq") ?? "0");
    const limitRaw = Number(c.req.query("limit") ?? "50");
    const sinceSeq =
      Number.isFinite(sinceSeqRaw) && sinceSeqRaw >= 0 ? sinceSeqRaw : 0;
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 50;
    return c.json({
      messages: db.listRoomMessages(room.id, sinceSeq, limit),
    });
  });

  app.post("/api/v2/rooms/:roomId/messages", async (c) => {
    const body = await readJsonBody(c);
    const content = typeof body.content === "string" ? body.content : "";
    const senderNodeId =
      typeof body.senderNodeId === "string" && body.senderNodeId.trim().length > 0
        ? body.senderNodeId.trim()
        : undefined;
    const hopChainId =
      typeof body.hopChainId === "string" && body.hopChainId.trim().length > 0
        ? body.hopChainId.trim()
        : undefined;
    const resetLoop = body.resetLoop === true;

    const message = hub.postRoomMessage({
      roomIdOrSlug: c.req.param("roomId"),
      user: c.get("user"),
      content,
      senderNodeId,
      hopChainId,
      resetLoop,
    });
    return c.json({ message }, 201);
  });

  app.post("/api/v2/rooms/:roomId/read", async (c) => {
    const room = db.findRoomByIdOrSlug(c.req.param("roomId"));
    if (!room) {
      throw new DbError(404, "NOT_FOUND", "Room not found");
    }
    if (!db.isRoomMember(room.id, c.get("user").id)) {
      throw new DbError(403, "FORBIDDEN", "Not a member of this room");
    }
    const body = await readJsonBody(c);
    const seq = body.seq;
    if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0) {
      throw new DbError(400, "INVALID_INPUT", "seq must be a non-negative integer");
    }
    db.markRoomRead(room.id, c.get("user").id, seq);
    return c.json({ ok: true });
  });

  app.get("/api/v2/inbox", (c) => {
    const handle = c.req.query("handle")?.trim().toLowerCase() || undefined;
    const unreadParam = c.req.query("unreadOnly");
    const unreadOnly = unreadParam === "true" || unreadParam === "1";
    const items = db.getInboxForUser(c.get("user").id, {
      handle,
      unreadOnly,
    });
    return c.json({ items });
  });

  return app;
}
