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
export type ShareMode = "tunnel" | "endpoint";

export interface ShareRow {
  id: string;
  owner: string;
  title: string;
  project: string | null;
  status: ShareStatus;
  mode: ShareMode;
  endpoint_url: string | null;
  agent_card: string | null;
  handoff: string | null;
  created_at: string;
  last_seen_at: string | null;
}

export interface ShareSessionRow {
  id: string;
  share_id: string;
  visitor_name: string | null;
  dsh_session_id: string | null;
  a2a_context_id: string | null;
  created_at: string;
}

export interface ShareMessageRow {
  id: number;
  session_id: string;
  role: "visitor" | "agent" | "system";
  content: string;
  created_at: string;
}

export interface ShareSubmissionRow {
  id: number;
  share_id: string;
  session_id: string | null;
  author_name: string | null;
  summary: string;
  changes: string;
  open_questions: string;
  status: string;
  owner_note: string | null;
  created_at: string;
  decided_at: string | null;
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
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS share_submissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        share_id TEXT NOT NULL,
        session_id TEXT,
        author_name TEXT,
        summary TEXT NOT NULL,
        changes TEXT NOT NULL DEFAULT '[]',
        open_questions TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'pending',
        owner_note TEXT,
        created_at TEXT NOT NULL,
        decided_at TEXT
      )
    `);
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS share_submissions_share ON share_submissions (share_id, id)",
    );
    this.migrateShareColumns();
  }

  private migrateShareColumns(): void {
    const shareColumns = this.db.prepare("PRAGMA table_info(shares)").all() as unknown as Array<{
      name: string;
    }>;
    const hasShareColumn = (name: string): boolean => shareColumns.some((column) => column.name === name);
    if (!hasShareColumn("mode")) {
      this.db.exec("ALTER TABLE shares ADD COLUMN mode TEXT NOT NULL DEFAULT 'tunnel'");
    }
    if (!hasShareColumn("endpoint_url")) {
      this.db.exec("ALTER TABLE shares ADD COLUMN endpoint_url TEXT");
    }
    if (!hasShareColumn("agent_card")) {
      this.db.exec("ALTER TABLE shares ADD COLUMN agent_card TEXT");
    }
    if (!hasShareColumn("handoff")) {
      this.db.exec("ALTER TABLE shares ADD COLUMN handoff TEXT");
    }

    const sessionColumns = this.db.prepare("PRAGMA table_info(share_sessions)").all() as unknown as Array<{
      name: string;
    }>;
    if (!sessionColumns.some((column) => column.name === "a2a_context_id")) {
      this.db.exec("ALTER TABLE share_sessions ADD COLUMN a2a_context_id TEXT");
    }
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
    mode: ShareMode;
    endpoint_url: string | null;
    agent_card: string | null;
    handoff: string | null;
    created_at: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO shares (id, owner, title, project, status, mode, endpoint_url, agent_card, handoff, created_at)
         VALUES (?, ?, ?, ?, 'offline', ?, ?, ?, ?, ?)`,
      )
      .run(
        share.id,
        share.owner,
        share.title,
        share.project,
        share.mode,
        share.endpoint_url,
        share.agent_card,
        share.handoff,
        share.created_at,
      );
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

  setShareSessionA2aContext(sessionId: string, contextId: string): void {
    this.db
      .prepare("UPDATE share_sessions SET a2a_context_id = ? WHERE id = ?")
      .run(contextId, sessionId);
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

  insertShareSubmission(input: {
    share_id: string;
    session_id: string | null;
    author_name: string | null;
    summary: string;
    changes: string[];
    open_questions: string[];
    created_at: string;
  }): ShareSubmissionRow {
    const result = this.db
      .prepare(
        `INSERT INTO share_submissions
         (share_id, session_id, author_name, summary, changes, open_questions, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.share_id,
        input.session_id,
        input.author_name,
        input.summary,
        JSON.stringify(input.changes),
        JSON.stringify(input.open_questions),
        input.created_at,
      );
    return this.getShareSubmission(Number(result.lastInsertRowid))!;
  }

  getShareSubmission(id: number): ShareSubmissionRow | undefined {
    return this.db.prepare("SELECT * FROM share_submissions WHERE id = ?").get(id) as unknown as
      | ShareSubmissionRow
      | undefined;
  }

  listShareSubmissions(shareId: string, sessionId?: string): ShareSubmissionRow[] {
    if (sessionId !== undefined) {
      return this.db
        .prepare(
          "SELECT * FROM share_submissions WHERE share_id = ? AND session_id = ? ORDER BY id ASC",
        )
        .all(shareId, sessionId) as unknown as ShareSubmissionRow[];
    }
    return this.db
      .prepare("SELECT * FROM share_submissions WHERE share_id = ? ORDER BY id ASC")
      .all(shareId) as unknown as ShareSubmissionRow[];
  }

  decideShareSubmission(
    id: number,
    status: "accepted" | "rejected",
    ownerNote: string | null,
    decidedAt: string,
  ): ShareSubmissionRow | undefined {
    this.db
      .prepare("UPDATE share_submissions SET status = ?, owner_note = ?, decided_at = ? WHERE id = ?")
      .run(status, ownerNote, decidedAt, id);
    return this.getShareSubmission(id);
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
