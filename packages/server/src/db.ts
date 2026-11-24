import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  DEFAULT_MAX_AGENT_HOPS,
  HANDLE_PATTERN,
  type FriendRecord,
  type InboxItem,
  type NodeKind,
  type NodePresence,
  type PairCodeRecord,
  type RoomMessage,
  type RoomSummary,
  type UserProfile,
  type UserRole,
} from "@agentshare/core";

export interface UserRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  role: UserRole;
  created_at: number;
}

export interface InviteRecord {
  code: string;
  createdBy: string | null;
  role: UserRole;
  maxUses: number;
  usedCount: number;
  expiresAt: number;
  createdAt: number;
}

export interface RoomRow {
  id: string;
  slug: string;
  name: string;
  topic: string;
  created_by: string;
  max_agent_hops: number;
  created_at: number;
}

export interface RoomMemberInfo {
  userId: string;
  username: string;
  displayName: string;
  role: string;
  joinedAt: number;
  nodes: NodePresence[];
}

export interface UpsertNodeInput {
  nodeId: string;
  ownerUserId: string;
  handle: string;
  displayName: string;
  kind: NodeKind;
  description: string;
  capabilities: string[];
  signPublicKey: string;
  kxPublicKey: string;
  directUrl: string | null;
}

export interface InsertRoomMessageInput {
  roomId: string;
  senderType: "human" | "agent" | "system";
  senderUserId: string;
  senderNodeId: string | null;
  senderHandle: string;
  content: string;
  mentions: string[];
  requestedHopChainId?: string;
  maxAgentHops: number;
}

export class DbError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "DbError";
    this.status = status;
    this.code = code;
  }
}

interface NodeJoinRow {
  node_id: string;
  owner_user_id: string;
  owner_username: string;
  handle: string;
  display_name: string;
  kind: NodeKind;
  description: string;
  capabilities_json: string;
  sign_public_key: string;
  kx_public_key: string;
  direct_url: string | null;
  last_seen_at: number;
  created_at: number;
}

interface RoomMessageRow {
  id: string;
  room_id: string;
  seq: number;
  sender_type: "human" | "agent" | "system";
  sender_user_id: string;
  sender_node_id: string | null;
  sender_handle: string;
  content: string;
  mentions_json: string;
  hop_count: number;
  hop_chain_id: string | null;
  loop_broken: number;
  created_at: number;
}

interface InviteRow {
  code: string;
  created_by: string | null;
  role: UserRole;
  max_uses: number;
  used_count: number;
  expires_at: number;
  created_at: number;
}

interface PairCodeRow {
  code: string;
  creator_user_id: string;
  creator_node_id: string | null;
  max_uses: number;
  used_count: number;
  expires_at: number;
  created_at: number;
}

function toUserProfile(row: {
  id: string;
  username: string;
  display_name: string;
  role: UserRole;
  created_at: number;
}): UserProfile {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    createdAt: row.created_at,
  };
}

function toInviteRecord(row: InviteRow): InviteRecord {
  return {
    code: row.code,
    createdBy: row.created_by,
    role: row.role,
    maxUses: row.max_uses,
    usedCount: row.used_count,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

function toPairCodeRecord(row: PairCodeRow): PairCodeRecord {
  return {
    code: row.code,
    creatorUserId: row.creator_user_id,
    creatorNodeId: row.creator_node_id,
    expiresAt: row.expires_at,
    maxUses: row.max_uses,
    usedCount: row.used_count,
  };
}

function parseJsonStringArray(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

function toNodePresence(
  row: NodeJoinRow,
  isOnline?: (nodeId: string) => boolean,
): NodePresence {
  return {
    nodeId: row.node_id,
    ownerUserId: row.owner_user_id,
    ownerUsername: row.owner_username,
    handle: row.handle,
    displayName: row.display_name,
    kind: row.kind,
    description: row.description,
    capabilities: parseJsonStringArray(row.capabilities_json),
    signPublicKey: row.sign_public_key,
    kxPublicKey: row.kx_public_key,
    directUrl: row.direct_url,
    online: isOnline ? isOnline(row.node_id) : false,
    lastSeenAt: row.last_seen_at,
  };
}

function toRoomMessage(row: RoomMessageRow): RoomMessage {
  return {
    id: row.id,
    roomId: row.room_id,
    seq: row.seq,
    senderType: row.sender_type,
    senderUserId: row.sender_user_id,
    senderNodeId: row.sender_node_id,
    senderHandle: row.sender_handle,
    content: row.content,
    mentions: parseJsonStringArray(row.mentions_json),
    hopCount: row.hop_count,
    hopChainId: row.hop_chain_id,
    loopBroken: row.loop_broken !== 0,
    createdAt: row.created_at,
  };
}

function slugifyRoomName(name: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  if (base.length >= 2 && /^[a-z0-9]/.test(base)) {
    return base;
  }
  return `room-${randomBytes(3).toString("hex")}`;
}

export class ServerDb {
  readonly sqlite: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.sqlite = new DatabaseSync(dbPath);
    this.sqlite.exec("PRAGMA journal_mode = WAL;");
    this.sqlite.exec("PRAGMA foreign_keys = ON;");
    this.initSchema();
  }

  private initSchema(): void {
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);

      CREATE TABLE IF NOT EXISTS invites (
        code TEXT PRIMARY KEY,
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
        max_uses INTEGER NOT NULL,
        used_count INTEGER NOT NULL DEFAULT 0,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS nodes (
        node_id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        handle TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        kind TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        capabilities_json TEXT NOT NULL DEFAULT '[]',
        sign_public_key TEXT NOT NULL,
        kx_public_key TEXT NOT NULL,
        direct_url TEXT,
        last_seen_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_nodes_owner ON nodes(owner_user_id);

      CREATE TABLE IF NOT EXISTS friendships (
        id TEXT PRIMARY KEY,
        requester_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        addressee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('pending', 'accepted')),
        created_at INTEGER NOT NULL,
        UNIQUE(requester_id, addressee_id)
      );
      CREATE INDEX IF NOT EXISTS idx_friendships_requester ON friendships(requester_id);
      CREATE INDEX IF NOT EXISTS idx_friendships_addressee ON friendships(addressee_id);

      CREATE TABLE IF NOT EXISTS pair_codes (
        code TEXT PRIMARY KEY,
        creator_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        creator_node_id TEXT REFERENCES nodes(node_id) ON DELETE SET NULL,
        max_uses INTEGER NOT NULL,
        used_count INTEGER NOT NULL DEFAULT 0,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS pair_grants (
        id TEXT PRIMARY KEY,
        user_a_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        user_b_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        pair_code TEXT REFERENCES pair_codes(code) ON DELETE SET NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pair_grants_users ON pair_grants(user_a_id, user_b_id);

      CREATE TABLE IF NOT EXISTS rooms (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        topic TEXT NOT NULL DEFAULT '',
        created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        max_agent_hops INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS room_members (
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL DEFAULT 'member',
        last_read_seq INTEGER NOT NULL DEFAULT 0,
        joined_at INTEGER NOT NULL,
        PRIMARY KEY (room_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_room_members_user ON room_members(user_id);

      CREATE TABLE IF NOT EXISTS room_messages (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        sender_type TEXT NOT NULL CHECK (sender_type IN ('human', 'agent', 'system')),
        sender_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        sender_node_id TEXT REFERENCES nodes(node_id) ON DELETE SET NULL,
        sender_handle TEXT NOT NULL,
        content TEXT NOT NULL,
        mentions_json TEXT NOT NULL DEFAULT '[]',
        hop_count INTEGER NOT NULL DEFAULT 0,
        hop_chain_id TEXT,
        loop_broken INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        UNIQUE(room_id, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_room_messages_room_seq ON room_messages(room_id, seq);
      CREATE INDEX IF NOT EXISTS idx_room_messages_hop_chain ON room_messages(room_id, hop_chain_id);

      CREATE TABLE IF NOT EXISTS server_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  private inTransaction<T>(fn: () => T): T {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.sqlite.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        this.sqlite.exec("ROLLBACK");
      } catch {
        // ignore rollback error after failed transaction
      }
      throw err;
    }
  }

  close(): void {
    this.sqlite.close();
  }

  listTableNames(): string[] {
    const rows = this.sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name ASC",
      )
      .all() as Array<{ name: string }>;
    return rows.map((r) => r.name);
  }

  getSetting(key: string): string | null {
    const row = this.sqlite
      .prepare("SELECT value FROM server_settings WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  setSetting(key: string, value: string): void {
    this.sqlite
      .prepare(
        "INSERT INTO server_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  getRelayEnabled(): boolean {
    return this.getSetting("relay_enabled") === "true";
  }

  setRelayEnabled(enabled: boolean): void {
    this.setSetting("relay_enabled", enabled ? "true" : "false");
  }

  countUsers(): number {
    const row = this.sqlite
      .prepare("SELECT COUNT(*) AS cnt FROM users")
      .get() as { cnt: number };
    return Number(row.cnt);
  }

  getUserById(id: string): UserRow | null {
    const row = this.sqlite
      .prepare("SELECT * FROM users WHERE id = ?")
      .get(id) as UserRow | undefined;
    return row ?? null;
  }

  getUserByUsername(username: string): UserRow | null {
    const row = this.sqlite
      .prepare("SELECT * FROM users WHERE username = ?")
      .get(username.toLowerCase()) as UserRow | undefined;
    return row ?? null;
  }

  createUser(input: {
    username: string;
    displayName: string;
    passwordHash: string;
    role: UserRole;
  }): UserProfile {
    const now = Date.now();
    const id = randomUUID();
    const normalized = input.username.toLowerCase();
    try {
      this.sqlite
        .prepare(
          "INSERT INTO users (id, username, display_name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
          id,
          normalized,
          input.displayName,
          input.passwordHash,
          input.role,
          now,
        );
    } catch {
      throw new DbError(409, "USERNAME_TAKEN", "Username already exists");
    }
    return {
      id,
      username: normalized,
      displayName: input.displayName,
      role: input.role,
      createdAt: now,
    };
  }

  registerWithInvite(input: {
    inviteCode: string;
    username: string;
    displayName: string;
    passwordHash: string;
  }): UserProfile {
    const now = Date.now();
    const normalized = input.username.toLowerCase();
    return this.inTransaction(() => {
      const invite = this.sqlite
        .prepare("SELECT * FROM invites WHERE code = ?")
        .get(input.inviteCode) as InviteRow | undefined;
      if (
        !invite ||
        invite.expires_at <= now ||
        invite.used_count >= invite.max_uses
      ) {
        throw new DbError(
          403,
          "INVALID_INVITE",
          "Invite code is invalid, expired, or exhausted",
        );
      }

      const existing = this.sqlite
        .prepare("SELECT id FROM users WHERE username = ?")
        .get(normalized) as { id: string } | undefined;
      if (existing) {
        throw new DbError(409, "USERNAME_TAKEN", "Username already exists");
      }

      const updated = this.sqlite
        .prepare(
          "UPDATE invites SET used_count = used_count + 1 WHERE code = ? AND used_count < max_uses AND expires_at > ?",
        )
        .run(input.inviteCode, now);
      if (Number(updated.changes) === 0) {
        throw new DbError(
          403,
          "INVALID_INVITE",
          "Invite code is invalid, expired, or exhausted",
        );
      }

      const id = randomUUID();
      this.sqlite
        .prepare(
          "INSERT INTO users (id, username, display_name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
          id,
          normalized,
          input.displayName,
          input.passwordHash,
          invite.role,
          now,
        );
      return {
        id,
        username: normalized,
        displayName: input.displayName,
        role: invite.role,
        createdAt: now,
      };
    });
  }

  createInvite(input: {
    code?: string;
    createdBy: string | null;
    role: UserRole;
    maxUses: number;
    expiresAt: number;
  }): InviteRecord {
    const now = Date.now();
    const code = input.code ?? `inv_${randomBytes(10).toString("hex")}`;
    this.sqlite
      .prepare(
        "INSERT INTO invites (code, created_by, role, max_uses, used_count, expires_at, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)",
      )
      .run(
        code,
        input.createdBy,
        input.role,
        input.maxUses,
        input.expiresAt,
        now,
      );
    return {
      code,
      createdBy: input.createdBy,
      role: input.role,
      maxUses: input.maxUses,
      usedCount: 0,
      expiresAt: input.expiresAt,
      createdAt: now,
    };
  }

  getInvite(code: string): InviteRecord | null {
    const row = this.sqlite
      .prepare("SELECT * FROM invites WHERE code = ?")
      .get(code) as InviteRow | undefined;
    return row ? toInviteRecord(row) : null;
  }

  findActiveAdminInvite(now = Date.now()): InviteRecord | null {
    const row = this.sqlite
      .prepare(
        "SELECT * FROM invites WHERE role = 'admin' AND used_count < max_uses AND expires_at > ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(now) as InviteRow | undefined;
    return row ? toInviteRecord(row) : null;
  }

  listInvites(): InviteRecord[] {
    const rows = this.sqlite
      .prepare("SELECT * FROM invites ORDER BY created_at DESC")
      .all() as unknown as InviteRow[];
    return rows.map(toInviteRecord);
  }

  insertSession(input: {
    tokenHash: string;
    userId: string;
    expiresAt: number;
    createdAt: number;
  }): void {
    this.sqlite
      .prepare(
        "INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(input.tokenHash, input.userId, input.expiresAt, input.createdAt);
  }

  getSessionUser(tokenHash: string, now = Date.now()): UserProfile | null {
    const row = this.sqlite
      .prepare(
        `SELECT u.id, u.username, u.display_name, u.role, u.created_at
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.expires_at > ?`,
      )
      .get(tokenHash, now) as
      | {
          id: string;
          username: string;
          display_name: string;
          role: UserRole;
          created_at: number;
        }
      | undefined;
    return row ? toUserProfile(row) : null;
  }

  deleteSession(tokenHash: string): void {
    this.sqlite
      .prepare("DELETE FROM sessions WHERE token_hash = ?")
      .run(tokenHash);
  }

  upsertNode(
    input: UpsertNodeInput,
    isOnline?: (nodeId: string) => boolean,
  ): NodePresence {
    const handle = input.handle.toLowerCase();
    if (!HANDLE_PATTERN.test(handle)) {
      throw new DbError(400, "INVALID_HANDLE", "Invalid node handle format");
    }
    const now = Date.now();
    this.inTransaction(() => {
      const existingById = this.sqlite
        .prepare("SELECT node_id, owner_user_id FROM nodes WHERE node_id = ?")
        .get(input.nodeId) as
        | { node_id: string; owner_user_id: string }
        | undefined;
      if (existingById && existingById.owner_user_id !== input.ownerUserId) {
        throw new DbError(
          403,
          "NODE_ID_TAKEN",
          "Node ID is owned by another user",
        );
      }

      const existingByHandle = this.sqlite
        .prepare("SELECT node_id, owner_user_id FROM nodes WHERE handle = ?")
        .get(handle) as
        | { node_id: string; owner_user_id: string }
        | undefined;
      if (existingByHandle) {
        if (existingByHandle.owner_user_id !== input.ownerUserId) {
          throw new DbError(
            409,
            "HANDLE_TAKEN",
            "Node handle is owned by another user",
          );
        }
        if (existingByHandle.node_id !== input.nodeId) {
          this.sqlite
            .prepare("DELETE FROM nodes WHERE node_id = ?")
            .run(existingByHandle.node_id);
        }
      }

      this.sqlite
        .prepare(
          `INSERT INTO nodes (
             node_id, owner_user_id, handle, display_name, kind, description,
             capabilities_json, sign_public_key, kx_public_key, direct_url, last_seen_at, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(node_id) DO UPDATE SET
             handle = excluded.handle,
             display_name = excluded.display_name,
             kind = excluded.kind,
             description = excluded.description,
             capabilities_json = excluded.capabilities_json,
             sign_public_key = excluded.sign_public_key,
             kx_public_key = excluded.kx_public_key,
             direct_url = excluded.direct_url,
             last_seen_at = excluded.last_seen_at`,
        )
        .run(
          input.nodeId,
          input.ownerUserId,
          handle,
          input.displayName,
          input.kind,
          input.description,
          JSON.stringify(input.capabilities),
          input.signPublicKey,
          input.kxPublicKey,
          input.directUrl,
          now,
          now,
        );
    });

    const node = this.getNodeById(input.nodeId, isOnline);
    if (!node) {
      throw new DbError(500, "INTERNAL_ERROR", "Failed to load registered node");
    }
    return node;
  }

  touchNodeLastSeen(nodeId: string, ts = Date.now()): void {
    this.sqlite
      .prepare("UPDATE nodes SET last_seen_at = ? WHERE node_id = ?")
      .run(ts, nodeId);
  }

  getNodeById(
    nodeId: string,
    isOnline?: (nodeId: string) => boolean,
  ): NodePresence | null {
    const row = this.sqlite
      .prepare(
        `SELECT n.*, u.username AS owner_username
         FROM nodes n
         JOIN users u ON u.id = n.owner_user_id
         WHERE n.node_id = ?`,
      )
      .get(nodeId) as NodeJoinRow | undefined;
    return row ? toNodePresence(row, isOnline) : null;
  }

  getNodeByHandleOrId(
    handleOrId: string,
    isOnline?: (nodeId: string) => boolean,
  ): NodePresence | null {
    const row = this.sqlite
      .prepare(
        `SELECT n.*, u.username AS owner_username
         FROM nodes n
         JOIN users u ON u.id = n.owner_user_id
         WHERE n.node_id = ? OR n.handle = ?
         LIMIT 1`,
      )
      .get(handleOrId, handleOrId.toLowerCase()) as NodeJoinRow | undefined;
    return row ? toNodePresence(row, isOnline) : null;
  }

  deleteNode(nodeId: string, ownerUserId: string): "deleted" | "not_found" | "forbidden" {
    const row = this.sqlite
      .prepare("SELECT owner_user_id FROM nodes WHERE node_id = ?")
      .get(nodeId) as { owner_user_id: string } | undefined;
    if (!row) return "not_found";
    if (row.owner_user_id !== ownerUserId) return "forbidden";
    this.sqlite.prepare("DELETE FROM nodes WHERE node_id = ?").run(nodeId);
    return "deleted";
  }

  listNodesByOwner(
    ownerUserId: string,
    isOnline?: (nodeId: string) => boolean,
  ): NodePresence[] {
    const rows = this.sqlite
      .prepare(
        `SELECT n.*, u.username AS owner_username
         FROM nodes n
         JOIN users u ON u.id = n.owner_user_id
         WHERE n.owner_user_id = ?
         ORDER BY n.handle ASC`,
      )
      .all(ownerUserId) as unknown as NodeJoinRow[];
    return rows.map((row) => toNodePresence(row, isOnline));
  }

  arePeersAuthorized(userAId: string, userBId: string, now = Date.now()): boolean {
    if (userAId === userBId) return true;

    const friend = this.sqlite
      .prepare(
        `SELECT 1 FROM friendships
         WHERE status = 'accepted'
           AND ((requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?))
         LIMIT 1`,
      )
      .get(userAId, userBId, userBId, userAId);
    if (friend) return true;

    const sharedRoom = this.sqlite
      .prepare(
        `SELECT 1 FROM room_members a
         JOIN room_members b ON a.room_id = b.room_id
         WHERE a.user_id = ? AND b.user_id = ?
         LIMIT 1`,
      )
      .get(userAId, userBId);
    if (sharedRoom) return true;

    const pairGrant = this.sqlite
      .prepare(
        `SELECT 1 FROM pair_grants
         WHERE expires_at > ?
           AND ((user_a_id = ? AND user_b_id = ?) OR (user_a_id = ? AND user_b_id = ?))
         LIMIT 1`,
      )
      .get(now, userAId, userBId, userBId, userAId);
    return Boolean(pairGrant);
  }

  listAuthorizedPeerUserIds(userId: string, now = Date.now()): string[] {
    const rows = this.sqlite
      .prepare(
        `SELECT id FROM users WHERE id = ?
         UNION
         SELECT CASE WHEN requester_id = ? THEN addressee_id ELSE requester_id END AS id
         FROM friendships
         WHERE status = 'accepted' AND (requester_id = ? OR addressee_id = ?)
         UNION
         SELECT DISTINCT rm2.user_id AS id
         FROM room_members rm1
         JOIN room_members rm2 ON rm1.room_id = rm2.room_id
         WHERE rm1.user_id = ?
         UNION
         SELECT CASE WHEN user_a_id = ? THEN user_b_id ELSE user_a_id END AS id
         FROM pair_grants
         WHERE expires_at > ? AND (user_a_id = ? OR user_b_id = ?)`,
      )
      .all(
        userId,
        userId,
        userId,
        userId,
        userId,
        userId,
        now,
        userId,
        userId,
      ) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  listAuthorizedNodes(
    userId: string,
    isOnline?: (nodeId: string) => boolean,
    now = Date.now(),
  ): NodePresence[] {
    const peerIds = this.listAuthorizedPeerUserIds(userId, now);
    if (peerIds.length === 0) return [];
    const placeholders = peerIds.map(() => "?").join(", ");
    const rows = this.sqlite
      .prepare(
        `SELECT n.*, u.username AS owner_username
         FROM nodes n
         JOIN users u ON u.id = n.owner_user_id
         WHERE n.owner_user_id IN (${placeholders})
         ORDER BY n.handle ASC`,
      )
      .all(...(peerIds as SQLInputValue[])) as unknown as NodeJoinRow[];
    return rows.map((row) => toNodePresence(row, isOnline));
  }

  listFriends(userId: string): FriendRecord[] {
    const rows = this.sqlite
      .prepare(
        `SELECT
           f.id,
           f.requester_id,
           f.addressee_id,
           f.status,
           f.created_at,
           u.id AS friend_user_id,
           u.username AS friend_username,
           u.display_name AS friend_display_name
         FROM friendships f
         JOIN users u ON u.id = CASE WHEN f.requester_id = ? THEN f.addressee_id ELSE f.requester_id END
         WHERE f.requester_id = ? OR f.addressee_id = ?
         ORDER BY f.created_at DESC`,
      )
      .all(userId, userId, userId) as Array<{
      id: string;
      requester_id: string;
      addressee_id: string;
      status: "pending" | "accepted";
      created_at: number;
      friend_user_id: string;
      friend_username: string;
      friend_display_name: string;
    }>;

    return rows.map((row) => ({
      id: row.id,
      userId,
      friendUserId: row.friend_user_id,
      friendUsername: row.friend_username,
      friendDisplayName: row.friend_display_name,
      status: row.status,
      direction: row.requester_id === userId ? "outgoing" : "incoming",
      createdAt: row.created_at,
    }));
  }

  createFriendRequest(requesterId: string, targetUsername: string): FriendRecord {
    const target = this.getUserByUsername(targetUsername);
    if (!target) {
      throw new DbError(404, "USER_NOT_FOUND", "Target user not found");
    }
    if (target.id === requesterId) {
      throw new DbError(400, "INVALID_FRIEND", "Cannot add yourself as a friend");
    }

    return this.inTransaction(() => {
      const existing = this.sqlite
        .prepare(
          `SELECT * FROM friendships
           WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)
           LIMIT 1`,
        )
        .get(requesterId, target.id, target.id, requesterId) as
        | {
            id: string;
            requester_id: string;
            addressee_id: string;
            status: "pending" | "accepted";
            created_at: number;
          }
        | undefined;

      if (existing) {
        if (
          existing.status === "pending" &&
          existing.requester_id === target.id &&
          existing.addressee_id === requesterId
        ) {
          this.sqlite
            .prepare("UPDATE friendships SET status = 'accepted' WHERE id = ?")
            .run(existing.id);
          return {
            id: existing.id,
            userId: requesterId,
            friendUserId: target.id,
            friendUsername: target.username,
            friendDisplayName: target.display_name,
            status: "accepted",
            direction: "incoming",
            createdAt: existing.created_at,
          };
        }
        throw new DbError(
          409,
          "FRIENDSHIP_EXISTS",
          "Friendship or pending request already exists",
        );
      }

      const id = randomUUID();
      const now = Date.now();
      this.sqlite
        .prepare(
          "INSERT INTO friendships (id, requester_id, addressee_id, status, created_at) VALUES (?, ?, ?, 'pending', ?)",
        )
        .run(id, requesterId, target.id, now);
      return {
        id,
        userId: requesterId,
        friendUserId: target.id,
        friendUsername: target.username,
        friendDisplayName: target.display_name,
        status: "pending",
        direction: "outgoing",
        createdAt: now,
      };
    });
  }

  acceptFriendRequest(friendshipId: string, userId: string): FriendRecord {
    const row = this.sqlite
      .prepare("SELECT * FROM friendships WHERE id = ?")
      .get(friendshipId) as
      | {
          id: string;
          requester_id: string;
          addressee_id: string;
          status: "pending" | "accepted";
          created_at: number;
        }
      | undefined;

    if (!row) {
      throw new DbError(404, "NOT_FOUND", "Friend request not found");
    }
    if (row.addressee_id !== userId) {
      throw new DbError(
        403,
        "FORBIDDEN",
        "Only the recipient can accept a friend request",
      );
    }
    if (row.status !== "accepted") {
      this.sqlite
        .prepare("UPDATE friendships SET status = 'accepted' WHERE id = ?")
        .run(friendshipId);
    }

    const peer = this.getUserById(row.requester_id);
    if (!peer) {
      throw new DbError(404, "USER_NOT_FOUND", "Requester not found");
    }
    return {
      id: row.id,
      userId,
      friendUserId: peer.id,
      friendUsername: peer.username,
      friendDisplayName: peer.display_name,
      status: "accepted",
      direction: "incoming",
      createdAt: row.created_at,
    };
  }

  deleteFriendship(
    friendshipId: string,
    userId: string,
  ): "deleted" | "not_found" | "forbidden" {
    const row = this.sqlite
      .prepare("SELECT requester_id, addressee_id FROM friendships WHERE id = ?")
      .get(friendshipId) as
      | { requester_id: string; addressee_id: string }
      | undefined;
    if (!row) return "not_found";
    if (row.requester_id !== userId && row.addressee_id !== userId) {
      return "forbidden";
    }
    this.sqlite
      .prepare("DELETE FROM friendships WHERE id = ?")
      .run(friendshipId);
    return "deleted";
  }

  createPairCode(input: {
    creatorUserId: string;
    creatorNodeId: string | null;
    maxUses: number;
    expiresInMinutes: number;
  }): PairCodeRecord {
    if (input.creatorNodeId) {
      const node = this.getNodeById(input.creatorNodeId);
      if (!node || node.ownerUserId !== input.creatorUserId) {
        throw new DbError(
          403,
          "FORBIDDEN",
          "nodeId does not belong to authenticated user",
        );
      }
    }
    const now = Date.now();
    const expiresAt = now + input.expiresInMinutes * 60_000;
    const code = `pair_${randomBytes(9).toString("base64url")}`;
    this.sqlite
      .prepare(
        "INSERT INTO pair_codes (code, creator_user_id, creator_node_id, max_uses, used_count, expires_at, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)",
      )
      .run(
        code,
        input.creatorUserId,
        input.creatorNodeId,
        input.maxUses,
        expiresAt,
        now,
      );
    return {
      code,
      creatorUserId: input.creatorUserId,
      creatorNodeId: input.creatorNodeId,
      expiresAt,
      maxUses: input.maxUses,
      usedCount: 0,
    };
  }

  redeemPairCode(
    code: string,
    redeemerUserId: string,
    isOnline?: (nodeId: string) => boolean,
  ): { creatorUserId: string; nodes: NodePresence[] } {
    const now = Date.now();
    const grantTtlMs = 30 * 24 * 60 * 60 * 1000;
    const creatorUserId = this.inTransaction(() => {
      const row = this.sqlite
        .prepare("SELECT * FROM pair_codes WHERE code = ?")
        .get(code) as PairCodeRow | undefined;
      if (!row) {
        throw new DbError(404, "NOT_FOUND", "Pair code not found");
      }
      if (row.expires_at <= now || row.used_count >= row.max_uses) {
        throw new DbError(
          410,
          "PAIR_CODE_EXPIRED",
          "Pair code is expired or exhausted",
        );
      }
      const updated = this.sqlite
        .prepare(
          "UPDATE pair_codes SET used_count = used_count + 1 WHERE code = ? AND used_count < max_uses AND expires_at > ?",
        )
        .run(code, now);
      if (Number(updated.changes) === 0) {
        throw new DbError(
          410,
          "PAIR_CODE_EXPIRED",
          "Pair code is expired or exhausted",
        );
      }
      const grantExpiresAt = Math.max(row.expires_at, now + grantTtlMs);
      this.sqlite
        .prepare(
          "INSERT INTO pair_grants (id, user_a_id, user_b_id, pair_code, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
          randomUUID(),
          row.creator_user_id,
          redeemerUserId,
          code,
          grantExpiresAt,
          now,
        );
      return row.creator_user_id;
    });

    const nodes = this.listNodesByOwner(creatorUserId, isOnline);
    return { creatorUserId, nodes };
  }

  findRoomByIdOrSlug(idOrSlug: string): RoomRow | null {
    const row = this.sqlite
      .prepare("SELECT * FROM rooms WHERE id = ? OR slug = ? LIMIT 1")
      .get(idOrSlug, idOrSlug.toLowerCase()) as RoomRow | undefined;
    return row ?? null;
  }

  createRoom(input: {
    name: string;
    slug?: string;
    topic?: string;
    createdBy: string;
    maxAgentHops?: number;
  }): RoomSummary {
    const now = Date.now();
    const id = randomUUID();
    const explicitSlug = input.slug?.trim().toLowerCase();
    if (explicitSlug !== undefined && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(explicitSlug)) {
      throw new DbError(400, "INVALID_SLUG", "Invalid room slug format");
    }
    const maxAgentHops = input.maxAgentHops ?? DEFAULT_MAX_AGENT_HOPS;
    const topic = input.topic ?? "";

    return this.inTransaction(() => {
      let slug = explicitSlug ?? slugifyRoomName(input.name);
      if (!explicitSlug) {
        let candidate = slug;
        let suffix = 1;
        while (
          this.sqlite
            .prepare("SELECT 1 FROM rooms WHERE slug = ?")
            .get(candidate)
        ) {
          candidate = `${slug}-${suffix++}`;
        }
        slug = candidate;
      } else {
        const exists = this.sqlite
          .prepare("SELECT 1 FROM rooms WHERE slug = ?")
          .get(slug);
        if (exists) {
          throw new DbError(409, "SLUG_TAKEN", "Room slug already exists");
        }
      }

      this.sqlite
        .prepare(
          "INSERT INTO rooms (id, slug, name, topic, created_by, max_agent_hops, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(id, slug, input.name, topic, input.createdBy, maxAgentHops, now);

      this.sqlite
        .prepare(
          "INSERT INTO room_members (room_id, user_id, role, last_read_seq, joined_at) VALUES (?, ?, 'owner', 0, ?)",
        )
        .run(id, input.createdBy, now);

      return {
        id,
        slug,
        name: input.name,
        topic,
        createdBy: input.createdBy,
        maxAgentHops,
        createdAt: now,
        unreadCount: 0,
        mentionCount: 0,
      };
    });
  }

  isRoomMember(roomId: string, userId: string): boolean {
    const row = this.sqlite
      .prepare(
        "SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ? LIMIT 1",
      )
      .get(roomId, userId);
    return Boolean(row);
  }

  addRoomMember(roomId: string, userId: string, role = "member"): void {
    this.sqlite
      .prepare(
        "INSERT OR IGNORE INTO room_members (room_id, user_id, role, last_read_seq, joined_at) VALUES (?, ?, ?, 0, ?)",
      )
      .run(roomId, userId, role, Date.now());
  }

  listRoomMemberUserIds(roomId: string): string[] {
    const rows = this.sqlite
      .prepare("SELECT user_id FROM room_members WHERE room_id = ?")
      .all(roomId) as Array<{ user_id: string }>;
    return rows.map((r) => r.user_id);
  }

  listRoomMembers(
    roomId: string,
    isOnline?: (nodeId: string) => boolean,
  ): RoomMemberInfo[] {
    const rows = this.sqlite
      .prepare(
        `SELECT rm.user_id, rm.role, rm.joined_at, u.username, u.display_name
         FROM room_members rm
         JOIN users u ON u.id = rm.user_id
         WHERE rm.room_id = ?
         ORDER BY rm.joined_at ASC`,
      )
      .all(roomId) as Array<{
      user_id: string;
      role: string;
      joined_at: number;
      username: string;
      display_name: string;
    }>;

    return rows.map((row) => ({
      userId: row.user_id,
      username: row.username,
      displayName: row.display_name,
      role: row.role,
      joinedAt: row.joined_at,
      nodes: this.listNodesByOwner(row.user_id, isOnline),
    }));
  }

  private getTargetHandlesForUser(userId: string): Set<string> {
    const handles = new Set<string>();
    const user = this.getUserById(userId);
    if (user) {
      handles.add(user.username.toLowerCase());
    }
    const nodeRows = this.sqlite
      .prepare("SELECT handle FROM nodes WHERE owner_user_id = ?")
      .all(userId) as Array<{ handle: string }>;
    for (const row of nodeRows) {
      handles.add(row.handle.toLowerCase());
    }
    return handles;
  }

  getRoomSummaryForUser(roomId: string, userId: string): RoomSummary | null {
    const row = this.sqlite
      .prepare(
        `SELECT r.*, rm.last_read_seq
         FROM rooms r
         JOIN room_members rm ON rm.room_id = r.id
         WHERE r.id = ? AND rm.user_id = ?`,
      )
      .get(roomId, userId) as (RoomRow & { last_read_seq: number }) | undefined;
    if (!row) return null;

    const unreadRows = this.sqlite
      .prepare(
        `SELECT sender_type, sender_user_id, sender_handle, mentions_json, loop_broken
         FROM room_messages
         WHERE room_id = ? AND seq > ?`,
      )
      .all(roomId, row.last_read_seq) as Array<{
      sender_type: string;
      sender_user_id: string;
      sender_handle: string;
      mentions_json: string;
      loop_broken: number;
    }>;

    const targetHandles = this.getTargetHandlesForUser(userId);
    let unreadCount = 0;
    let mentionCount = 0;
    for (const msg of unreadRows) {
      if (msg.sender_type === "human" && msg.sender_user_id === userId) {
        continue;
      }
      unreadCount += 1;
      if (msg.loop_broken !== 0) continue;
      const mentions = parseJsonStringArray(msg.mentions_json);
      const senderLower = msg.sender_handle.toLowerCase();
      if (mentions.some((m) => m !== senderLower && targetHandles.has(m))) {
        mentionCount += 1;
      }
    }

    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      topic: row.topic,
      createdBy: row.created_by,
      maxAgentHops: row.max_agent_hops,
      createdAt: row.created_at,
      unreadCount,
      mentionCount,
    };
  }

  listRoomsForUser(userId: string): RoomSummary[] {
    const rows = this.sqlite
      .prepare(
        `SELECT r.id
         FROM rooms r
         JOIN room_members rm ON rm.room_id = r.id
         WHERE rm.user_id = ?
         ORDER BY r.created_at ASC`,
      )
      .all(userId) as Array<{ id: string }>;

    const result: RoomSummary[] = [];
    for (const row of rows) {
      const summary = this.getRoomSummaryForUser(row.id, userId);
      if (summary) result.push(summary);
    }
    return result;
  }

  insertRoomMessage(input: InsertRoomMessageInput): RoomMessage {
    const now = Date.now();
    const id = randomUUID();
    return this.inTransaction(() => {
      let hopCount = 0;
      let hopChainId: string | null = null;
      let loopBroken = false;

      if (input.senderType === "human") {
        hopCount = 0;
        hopChainId = randomUUID();
        loopBroken = false;
      } else if (input.mentions.length > 0) {
        const requested = input.requestedHopChainId?.trim();
        if (requested) {
          hopChainId = requested;
          const prevRow = this.sqlite
            .prepare(
              "SELECT COALESCE(MAX(hop_count), 0) AS max_hop FROM room_messages WHERE room_id = ? AND hop_chain_id = ?",
            )
            .get(input.roomId, hopChainId) as { max_hop: number };
          hopCount = Number(prevRow.max_hop) + 1;
        } else {
          hopChainId = randomUUID();
          hopCount = 1;
        }
        loopBroken = hopCount > input.maxAgentHops;
      } else if (input.requestedHopChainId?.trim()) {
        hopChainId = input.requestedHopChainId.trim();
        const prevRow = this.sqlite
          .prepare(
            "SELECT COALESCE(MAX(hop_count), 0) AS max_hop FROM room_messages WHERE room_id = ? AND hop_chain_id = ?",
          )
          .get(input.roomId, hopChainId) as { max_hop: number };
        hopCount = Number(prevRow.max_hop);
      }

      const seqRow = this.sqlite
        .prepare(
          "SELECT COALESCE(MAX(seq), 0) AS max_seq FROM room_messages WHERE room_id = ?",
        )
        .get(input.roomId) as { max_seq: number };
      const nextSeq = Number(seqRow.max_seq) + 1;

      this.sqlite
        .prepare(
          `INSERT INTO room_messages (
             id, room_id, seq, sender_type, sender_user_id, sender_node_id,
             sender_handle, content, mentions_json, hop_count, hop_chain_id, loop_broken, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.roomId,
          nextSeq,
          input.senderType,
          input.senderUserId,
          input.senderNodeId,
          input.senderHandle,
          input.content,
          JSON.stringify(input.mentions),
          hopCount,
          hopChainId,
          loopBroken ? 1 : 0,
          now,
        );

      return {
        id,
        roomId: input.roomId,
        seq: nextSeq,
        senderType: input.senderType,
        senderUserId: input.senderUserId,
        senderNodeId: input.senderNodeId,
        senderHandle: input.senderHandle,
        content: input.content,
        mentions: input.mentions,
        hopCount,
        hopChainId,
        loopBroken,
        createdAt: now,
      };
    });
  }

  listRoomMessages(roomId: string, sinceSeq = 0, limit = 50): RoomMessage[] {
    const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
    const safeSince = Math.max(0, Math.floor(sinceSeq));
    const rows = this.sqlite
      .prepare(
        "SELECT * FROM room_messages WHERE room_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?",
      )
      .all(roomId, safeSince, safeLimit) as unknown as RoomMessageRow[];
    return rows.map(toRoomMessage);
  }

  markRoomRead(roomId: string, userId: string, seq: number): void {
    const safeSeq = Math.max(0, Math.floor(seq));
    this.sqlite
      .prepare(
        "UPDATE room_members SET last_read_seq = MAX(last_read_seq, ?) WHERE room_id = ? AND user_id = ?",
      )
      .run(safeSeq, roomId, userId);
  }

  getInboxForUser(
    userId: string,
    opts?: { handle?: string; unreadOnly?: boolean; limit?: number },
  ): InboxItem[] {
    const ownedHandles = this.getTargetHandlesForUser(userId);
    let targetHandles: Set<string>;
    if (opts?.handle) {
      const normalized = opts.handle.toLowerCase();
      if (!ownedHandles.has(normalized)) {
        return [];
      }
      targetHandles = new Set([normalized]);
    } else {
      targetHandles = ownedHandles;
    }

    const unreadClause = opts?.unreadOnly ? "AND m.seq > rm.last_read_seq" : "";
    const rows = this.sqlite
      .prepare(
        `SELECT m.*, r.name AS room_name, rm.last_read_seq
         FROM room_messages m
         JOIN rooms r ON r.id = m.room_id
         JOIN room_members rm ON rm.room_id = m.room_id AND rm.user_id = ?
         WHERE m.loop_broken = 0 AND m.mentions_json != '[]' ${unreadClause}
         ORDER BY m.created_at DESC, m.seq DESC
         LIMIT 500`,
      )
      .all(userId) as unknown as Array<
      RoomMessageRow & { room_name: string; last_read_seq: number }
    >;

    const limit = Math.max(1, Math.min(200, opts?.limit ?? 100));
    const userRow = this.getUserById(userId);
    const queryingSpecificNodeHandle =
      opts?.handle !== undefined &&
      userRow !== null &&
      opts.handle.toLowerCase() !== userRow.username.toLowerCase();
    const items: InboxItem[] = [];
    for (const row of rows) {
      if (
        !queryingSpecificNodeHandle &&
        row.sender_type === "human" &&
        row.sender_user_id === userId
      ) {
        continue;
      }
      const mentions = parseJsonStringArray(row.mentions_json);
      const senderLower = row.sender_handle.toLowerCase();
      const matched = mentions.some(
        (m) => m !== senderLower && targetHandles.has(m),
      );
      if (!matched) continue;
      items.push({
        id: `mention:${row.id}`,
        kind: "room_mention",
        fromHandle: row.sender_handle,
        fromNodeId: row.sender_node_id,
        roomId: row.room_id,
        roomName: row.room_name,
        messageId: row.id,
        preview: row.content.slice(0, 200),
        createdAt: row.created_at,
        read: row.seq <= row.last_read_seq,
      });
      if (items.length >= limit) break;
    }
    return items;
  }
}
