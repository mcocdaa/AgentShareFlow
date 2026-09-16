import { DatabaseSync } from "node:sqlite";

export interface PackRow {
  owner: string;
  name: string;
  version: string;
  title: string;
  description: string;
  mode: string;
  tags: string;
  manifest: string;
  digest: string;
  size: number;
  file: string;
  downloads: number;
  created_at: string;
}

export interface PackInsert {
  owner: string;
  name: string;
  version: string;
  title: string;
  description: string;
  mode: string;
  tags: string;
  manifest: string;
  digest: string;
  size: number;
  file: string;
  created_at: string;
}

export type ShareStatus = "online" | "offline" | "revoked";

export interface ShareRow {
  id: string;
  owner: string;
  title: string;
  project: string | null;
  status: ShareStatus;
  created_at: string;
  last_seen_at: string | null;
}

export interface ShareSessionRow {
  id: string;
  share_id: string;
  visitor_name: string | null;
  dsh_session_id: string | null;
  created_at: string;
}

export interface ShareMessageRow {
  id: number;
  session_id: string;
  role: "visitor" | "agent" | "system";
  content: string;
  created_at: string;
}

export class RegistryDb {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS packs (
        owner TEXT NOT NULL,
        name TEXT NOT NULL,
        version TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        mode TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        manifest TEXT NOT NULL,
        digest TEXT NOT NULL,
        size INTEGER NOT NULL,
        file TEXT NOT NULL,
        downloads INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        PRIMARY KEY (owner, name, version)
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS packs_owner_name ON packs (owner, name)");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS shares (
        id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        title TEXT NOT NULL,
        project TEXT,
        status TEXT NOT NULL DEFAULT 'offline',
        created_at TEXT NOT NULL,
        last_seen_at TEXT
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS shares_owner ON shares (owner)");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS share_sessions (
        id TEXT PRIMARY KEY,
        share_id TEXT NOT NULL,
        visitor_name TEXT,
        dsh_session_id TEXT,
        created_at TEXT NOT NULL
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS share_sessions_share ON share_sessions (share_id)");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS share_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS share_messages_session ON share_messages (session_id)");
  }

  insert(row: PackInsert): void {
    this.db
      .prepare(
        `INSERT INTO packs
         (owner, name, version, title, description, mode, tags, manifest, digest, size, file, downloads, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      )
      .run(
        row.owner,
        row.name,
        row.version,
        row.title,
        row.description,
        row.mode,
        row.tags,
        row.manifest,
        row.digest,
        row.size,
        row.file,
        row.created_at,
      );
  }

  get(owner: string, name: string, version: string): PackRow | undefined {
    return this.db
      .prepare("SELECT * FROM packs WHERE owner = ? AND name = ? AND version = ?")
      .get(owner, name, version) as unknown as PackRow | undefined;
  }

  latest(owner: string, name: string): PackRow | undefined {
    return this.db
      .prepare(
        "SELECT * FROM packs WHERE owner = ? AND name = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
      )
      .get(owner, name) as unknown as PackRow | undefined;
  }

  versions(owner: string, name: string): PackRow[] {
    return this.db
      .prepare(
        "SELECT * FROM packs WHERE owner = ? AND name = ? ORDER BY created_at ASC, rowid ASC",
      )
      .all(owner, name) as unknown as PackRow[];
  }

  search(query: string, mode?: string): PackRow[] {
    const like = `%${query.toLowerCase()}%`;
    const modeFilter = mode ? "AND p.mode = ?" : "";
    const params: string[] = mode ? [like, like, like, like, mode] : [like, like, like, like];
    return this.db
      .prepare(
        `SELECT * FROM packs p
         WHERE p.rowid = (SELECT MAX(rowid) FROM packs WHERE owner = p.owner AND name = p.name)
           AND (lower(p.name) LIKE ? OR lower(p.title) LIKE ? OR lower(p.description) LIKE ? OR lower(p.tags) LIKE ?)
           ${modeFilter}
         ORDER BY p.downloads DESC, p.rowid DESC
         LIMIT 100`,
      )
      .all(...params) as unknown as PackRow[];
  }

  bumpDownloads(owner: string, name: string, version: string): void {
    this.db
      .prepare("UPDATE packs SET downloads = downloads + 1 WHERE owner = ? AND name = ? AND version = ?")
      .run(owner, name, version);
  }

  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM packs").get() as unknown as { n: number };
    return row.n;
  }

  insertShare(share: {
    id: string;
    owner: string;
    title: string;
    project: string | null;
    created_at: string;
  }): void {
    this.db
      .prepare(
        "INSERT INTO shares (id, owner, title, project, status, created_at) VALUES (?, ?, ?, ?, 'offline', ?)",
      )
      .run(share.id, share.owner, share.title, share.project, share.created_at);
  }

  getShare(id: string): ShareRow | undefined {
    return this.db.prepare("SELECT * FROM shares WHERE id = ?").get(id) as unknown as
      | ShareRow
      | undefined;
  }

  listShares(owner: string): ShareRow[] {
    return this.db
      .prepare("SELECT * FROM shares WHERE owner = ? ORDER BY created_at DESC")
      .all(owner) as unknown as ShareRow[];
  }

  setShareStatus(id: string, status: ShareStatus): void {
    this.db.prepare("UPDATE shares SET status = ? WHERE id = ?").run(status, id);
  }

  touchShare(id: string, at: string): void {
    this.db.prepare("UPDATE shares SET last_seen_at = ? WHERE id = ?").run(at, id);
  }

  insertShareSession(session: {
    id: string;
    share_id: string;
    visitor_name: string | null;
    created_at: string;
  }): void {
    this.db
      .prepare(
        "INSERT INTO share_sessions (id, share_id, visitor_name, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(session.id, session.share_id, session.visitor_name, session.created_at);
  }

  getShareSession(id: string): ShareSessionRow | undefined {
    return this.db.prepare("SELECT * FROM share_sessions WHERE id = ?").get(id) as unknown as
      | ShareSessionRow
      | undefined;
  }

  listShareSessions(shareId: string): ShareSessionRow[] {
    return this.db
      .prepare("SELECT * FROM share_sessions WHERE share_id = ? ORDER BY created_at ASC")
      .all(shareId) as unknown as ShareSessionRow[];
  }

  setShareSessionDshId(sessionId: string, dshSessionId: string): void {
    this.db
      .prepare("UPDATE share_sessions SET dsh_session_id = ? WHERE id = ?")
      .run(dshSessionId, sessionId);
  }

  insertShareMessage(message: {
    sessionId: string;
    role: "visitor" | "agent" | "system";
    content: string;
    created_at: string;
  }): ShareMessageRow {
    const result = this.db
      .prepare(
        "INSERT INTO share_messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(message.sessionId, message.role, message.content, message.created_at);
    return {
      id: Number(result.lastInsertRowid),
      session_id: message.sessionId,
      role: message.role,
      content: message.content,
      created_at: message.created_at,
    };
  }

  listShareMessages(shareId: string, sessionId?: string): ShareMessageRow[] {
    if (sessionId) {
      return this.db
        .prepare(
          `SELECT m.* FROM share_messages m
           JOIN share_sessions s ON s.id = m.session_id
           WHERE s.share_id = ? AND m.session_id = ?
           ORDER BY m.id ASC`,
        )
        .all(shareId, sessionId) as unknown as ShareMessageRow[];
    }
    return this.db
      .prepare(
        `SELECT m.* FROM share_messages m
         JOIN share_sessions s ON s.id = m.session_id
         WHERE s.share_id = ?
         ORDER BY m.id ASC`,
      )
      .all(shareId) as unknown as ShareMessageRow[];
  }
}
