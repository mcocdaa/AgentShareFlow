import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { DmMessage, InboxItem, TransportMode } from "@agentshare/core";

export interface PendingApproval {
  id: string;
  kind: "dm" | "room_mention";
  fromHandle: string;
  fromNodeId: string | null;
  roomId: string | null;
  messageId: string;
  content: string;
  hopChainId: string | null;
  status: "pending" | "approved" | "rejected";
  createdAt: number;
}

interface DmRow {
  id: string;
  peer_node_id: string;
  peer_handle: string;
  direction: "in" | "out";
  content: string;
  transport: TransportMode;
  encrypted: number;
  status: DmMessage["status"];
  created_at: number;
}

interface InboxRow {
  id: string;
  kind: InboxItem["kind"];
  from_handle: string;
  from_node_id: string | null;
  room_id: string | null;
  room_name: string | null;
  message_id: string;
  preview: string;
  transport: TransportMode | null;
  created_at: number;
  read: number;
}

interface ApprovalRow {
  id: string;
  kind: PendingApproval["kind"];
  from_handle: string;
  from_node_id: string | null;
  room_id: string | null;
  message_id: string;
  content: string;
  hop_chain_id: string | null;
  status: PendingApproval["status"];
  created_at: number;
}

function mapDmRow(row: DmRow): DmMessage {
  return {
    id: row.id,
    peerNodeId: row.peer_node_id,
    peerHandle: row.peer_handle,
    direction: row.direction,
    content: row.content,
    transport: row.transport,
    encrypted: row.encrypted === 1,
    status: row.status,
    createdAt: row.created_at,
  };
}

function mapInboxRow(row: InboxRow): InboxItem {
  return {
    id: row.id,
    kind: row.kind,
    fromHandle: row.from_handle,
    fromNodeId: row.from_node_id,
    roomId: row.room_id,
    roomName: row.room_name,
    messageId: row.message_id,
    preview: row.preview,
    ...(row.transport !== null ? { transport: row.transport } : {}),
    createdAt: row.created_at,
    read: row.read === 1,
  };
}

function mapApprovalRow(row: ApprovalRow): PendingApproval {
  return {
    id: row.id,
    kind: row.kind,
    fromHandle: row.from_handle,
    fromNodeId: row.from_node_id,
    roomId: row.room_id,
    messageId: row.message_id,
    content: row.content,
    hopChainId: row.hop_chain_id,
    status: row.status,
    createdAt: row.created_at,
  };
}

export class LocalStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    }
    this.db = new DatabaseSync(dbPath);
    if (dbPath !== ":memory:") {
      this.db.exec("PRAGMA journal_mode = WAL;");
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS dm_messages (
        id TEXT PRIMARY KEY,
        peer_node_id TEXT NOT NULL,
        peer_handle TEXT NOT NULL,
        direction TEXT NOT NULL,
        content TEXT NOT NULL,
        transport TEXT NOT NULL,
        encrypted INTEGER NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_dm_peer_handle ON dm_messages(peer_handle, created_at);
      CREATE INDEX IF NOT EXISTS idx_dm_peer_node ON dm_messages(peer_node_id, created_at);

      CREATE TABLE IF NOT EXISTS inbox_items (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        from_handle TEXT NOT NULL,
        from_node_id TEXT,
        room_id TEXT,
        room_name TEXT,
        message_id TEXT NOT NULL,
        preview TEXT NOT NULL,
        transport TEXT,
        created_at INTEGER NOT NULL,
        read INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_inbox_read_created ON inbox_items(read, created_at);
      CREATE INDEX IF NOT EXISTS idx_inbox_message_id ON inbox_items(message_id);

      CREATE TABLE IF NOT EXISTS pending_approvals (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        from_handle TEXT NOT NULL,
        from_node_id TEXT,
        room_id TEXT,
        message_id TEXT NOT NULL,
        content TEXT NOT NULL,
        hop_chain_id TEXT,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_approvals_status_created ON pending_approvals(status, created_at);
    `);
  }

  insertDmMessage(msg: DmMessage): DmMessage {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO dm_messages
          (id, peer_node_id, peer_handle, direction, content, transport, encrypted, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        msg.id,
        msg.peerNodeId,
        msg.peerHandle,
        msg.direction,
        msg.content,
        msg.transport,
        msg.encrypted ? 1 : 0,
        msg.status,
        msg.createdAt,
      );
    return msg;
  }

  updateDmStatus(id: string, status: DmMessage["status"]): void {
    this.db.prepare("UPDATE dm_messages SET status = ? WHERE id = ?").run(status, id);
  }

  getDmMessage(id: string): DmMessage | null {
    const row = this.db
      .prepare("SELECT * FROM dm_messages WHERE id = ?")
      .get(id) as DmRow | undefined;
    return row ? mapDmRow(row) : null;
  }

  listDmMessages(opts: { peer?: string; limit?: number } = {}): DmMessage[] {
    const limit = Math.max(1, Math.min(500, Math.floor(opts.limit ?? 50)));
    if (opts.peer && opts.peer.trim()) {
      const raw = opts.peer.trim();
      const handle = raw.replace(/^@/, "").toLowerCase();
      const rows = this.db
        .prepare(
          `SELECT * FROM (
             SELECT rowid AS _rid, * FROM dm_messages
             WHERE LOWER(peer_handle) = ? OR peer_node_id = ?
             ORDER BY created_at DESC, rowid DESC
             LIMIT ?
           ) ORDER BY created_at ASC, _rid ASC`,
        )
        .all(handle, raw, limit) as unknown as DmRow[];
      return rows.map(mapDmRow);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT rowid AS _rid, * FROM dm_messages
           ORDER BY created_at DESC, rowid DESC
           LIMIT ?
         ) ORDER BY created_at ASC, _rid ASC`,
      )
      .all(limit) as unknown as DmRow[];
    return rows.map(mapDmRow);
  }

  insertInboxItem(item: InboxItem): InboxItem {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO inbox_items
          (id, kind, from_handle, from_node_id, room_id, room_name, message_id, preview, transport, created_at, read)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        item.id,
        item.kind,
        item.fromHandle,
        item.fromNodeId,
        item.roomId,
        item.roomName,
        item.messageId,
        item.preview,
        item.transport ?? null,
        item.createdAt,
        item.read ? 1 : 0,
      );
    return item;
  }

  listInboxItems(opts: { unreadOnly?: boolean; limit?: number } = {}): InboxItem[] {
    const limit = Math.max(1, Math.min(500, Math.floor(opts.limit ?? 100)));
    const rows = opts.unreadOnly
      ? (this.db
          .prepare(
            `SELECT * FROM inbox_items WHERE read = 0 ORDER BY created_at ASC LIMIT ?`,
          )
          .all(limit) as unknown as InboxRow[])
      : (this.db
          .prepare(
            `SELECT * FROM (
               SELECT * FROM inbox_items ORDER BY created_at DESC LIMIT ?
             ) ORDER BY created_at ASC`,
          )
          .all(limit) as unknown as InboxRow[]);
    return rows.map(mapInboxRow);
  }

  markInboxRead(ids?: string[]): void {
    if (!ids) {
      this.db.prepare("UPDATE inbox_items SET read = 1 WHERE read = 0").run();
      return;
    }
    if (ids.length === 0) return;
    const stmt = this.db.prepare("UPDATE inbox_items SET read = 1 WHERE id = ?");
    for (const id of ids) {
      stmt.run(id);
    }
  }

  markInboxReadByMessageId(messageId: string): void {
    this.db
      .prepare("UPDATE inbox_items SET read = 1 WHERE message_id = ?")
      .run(messageId);
  }

  countUnreadInbox(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM inbox_items WHERE read = 0")
      .get() as { count: number } | undefined;
    return row?.count ?? 0;
  }

  insertPendingApproval(approval: PendingApproval): PendingApproval {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO pending_approvals
          (id, kind, from_handle, from_node_id, room_id, message_id, content, hop_chain_id, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        approval.id,
        approval.kind,
        approval.fromHandle,
        approval.fromNodeId,
        approval.roomId,
        approval.messageId,
        approval.content,
        approval.hopChainId,
        approval.status,
        approval.createdAt,
      );
    return approval;
  }

  getPendingApproval(id: string): PendingApproval | null {
    const row = this.db
      .prepare("SELECT * FROM pending_approvals WHERE id = ?")
      .get(id) as ApprovalRow | undefined;
    return row ? mapApprovalRow(row) : null;
  }

  listPendingApprovals(status?: PendingApproval["status"]): PendingApproval[] {
    const rows = status
      ? (this.db
          .prepare(
            "SELECT * FROM pending_approvals WHERE status = ? ORDER BY created_at ASC",
          )
          .all(status) as unknown as ApprovalRow[])
      : (this.db
          .prepare("SELECT * FROM pending_approvals ORDER BY created_at ASC")
          .all() as unknown as ApprovalRow[]);
    return rows.map(mapApprovalRow);
  }

  updatePendingApprovalStatus(
    id: string,
    status: "approved" | "rejected",
  ): boolean {
    const result = this.db
      .prepare("UPDATE pending_approvals SET status = ? WHERE id = ? AND status = 'pending'")
      .run(status, id);
    return Number(result.changes) > 0;
  }

  close(): void {
    this.db.close();
  }
}
