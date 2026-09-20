import { DatabaseSync } from "node:sqlite";

export type OrgRole = "owner" | "admin" | "member" | "viewer";

export interface OrganizationRow {
  name: string;
  display_name: string;
  description: string;
  created_at: string;
}

export interface OrganizationMemberRow {
  org_name: string;
  member_identity: string;
  role: OrgRole;
  created_at: string;
}

export interface FederationPeerRow {
  id: string;
  name: string;
  url: string;
  status: "active" | "unreachable" | "pending";
  created_at: string;
  last_synced_at: string | null;
}

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
  public_key: string | null;
  signature: string | null;
  visibility: string;
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
  public_key: string | null;
  signature: string | null;
  visibility?: string;
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
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
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
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS stars (
        owner TEXT NOT NULL,
        pack_owner TEXT NOT NULL,
        pack_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (owner, pack_owner, pack_name)
      )
    `);
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS stars_pack ON stars (pack_owner, pack_name)",
    );
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS organizations (
        name TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS organization_members (
        org_name TEXT NOT NULL,
        member_identity TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        created_at TEXT NOT NULL,
        PRIMARY KEY (org_name, member_identity)
      )
    `);
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS org_members_identity ON organization_members (member_identity)",
    );
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS federation_peers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        last_synced_at TEXT
      )
    `);
    this.migratePackColumns();
    this.migrateShareColumns();
  }

  private migratePackColumns(): void {
    const columns = this.db.prepare("PRAGMA table_info(packs)").all() as unknown as Array<{
      name: string;
    }>;
    const has = (name: string): boolean => columns.some((column) => column.name === name);
    if (!has("public_key")) this.db.exec("ALTER TABLE packs ADD COLUMN public_key TEXT");
    if (!has("signature")) this.db.exec("ALTER TABLE packs ADD COLUMN signature TEXT");
    if (!has("visibility")) {
      this.db.exec("ALTER TABLE packs ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'");
    }
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
    const visibility = row.visibility ?? "public";
    this.db
      .prepare(
        `INSERT INTO packs
         (owner, name, version, title, description, mode, tags, manifest, digest, size, file, public_key, signature, visibility, downloads, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
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
        row.public_key,
        row.signature,
        visibility,
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

  addStar(owner: string, packOwner: string, packName: string, at: string): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO stars (owner, pack_owner, pack_name, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(owner, packOwner, packName, at);
  }

  removeStar(owner: string, packOwner: string, packName: string): void {
    this.db
      .prepare("DELETE FROM stars WHERE owner = ? AND pack_owner = ? AND pack_name = ?")
      .run(owner, packOwner, packName);
  }

  hasStar(owner: string, packOwner: string, packName: string): boolean {
    const row = this.db
      .prepare("SELECT 1 AS n FROM stars WHERE owner = ? AND pack_owner = ? AND pack_name = ?")
      .get(owner, packOwner, packName) as unknown as { n: number } | undefined;
    return row !== undefined;
  }

  countStars(packOwner: string, packName: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM stars WHERE pack_owner = ? AND pack_name = ?")
      .get(packOwner, packName) as unknown as { n: number };
    return row.n;
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

  findShareSessionByA2aContext(shareId: string, contextId: string): ShareSessionRow | undefined {
    return this.db
      .prepare("SELECT * FROM share_sessions WHERE share_id = ? AND a2a_context_id = ?")
      .get(shareId, contextId) as unknown as ShareSessionRow | undefined;
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

  /* ======================================================================== */
  /* Organization & Access Control Methods                                    */
  /* ======================================================================== */

  createOrg(
    name: string,
    displayName: string,
    description: string,
    creatorIdentity: string,
    at: string,
  ): void {
    this.db
      .prepare(
        "INSERT INTO organizations (name, display_name, description, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(name, displayName, description, at);
    this.db
      .prepare(
        "INSERT INTO organization_members (org_name, member_identity, role, created_at) VALUES (?, ?, 'owner', ?)",
      )
      .run(name, creatorIdentity, at);
  }

  getOrg(name: string): OrganizationRow | undefined {
    return this.db
      .prepare("SELECT * FROM organizations WHERE name = ?")
      .get(name) as unknown as OrganizationRow | undefined;
  }

  listUserOrgs(memberIdentity: string): Array<{ org: OrganizationRow; role: OrgRole }> {
    const rows = this.db
      .prepare(
        `SELECT o.name, o.display_name, o.description, o.created_at, m.role
         FROM organizations o
         JOIN organization_members m ON o.name = m.org_name
         WHERE m.member_identity = ?
         ORDER BY o.name ASC`,
      )
      .all(memberIdentity) as unknown as Array<{
      name: string;
      display_name: string;
      description: string;
      created_at: string;
      role: string;
    }>;

    return rows.map((row) => ({
      org: {
        name: row.name,
        display_name: row.display_name,
        description: row.description,
        created_at: row.created_at,
      },
      role: row.role as OrgRole,
    }));
  }

  getOrgMemberRole(orgName: string, memberIdentity: string): OrgRole | null {
    const row = this.db
      .prepare(
        "SELECT role FROM organization_members WHERE org_name = ? AND member_identity = ?",
      )
      .get(orgName, memberIdentity) as unknown as { role: string } | undefined;
    return row ? (row.role as OrgRole) : null;
  }

  listOrgMembers(orgName: string): OrganizationMemberRow[] {
    return this.db
      .prepare(
        "SELECT * FROM organization_members WHERE org_name = ? ORDER BY created_at ASC",
      )
      .all(orgName) as unknown as OrganizationMemberRow[];
  }

  addOrUpdateOrgMember(
    orgName: string,
    memberIdentity: string,
    role: OrgRole,
    at: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO organization_members (org_name, member_identity, role, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (org_name, member_identity) DO UPDATE SET role = excluded.role`,
      )
      .run(orgName, memberIdentity, role, at);
  }

  removeOrgMember(orgName: string, memberIdentity: string): void {
    this.db
      .prepare(
        "DELETE FROM organization_members WHERE org_name = ? AND member_identity = ?",
      )
      .run(orgName, memberIdentity);
  }

  canUserReadPack(
    callerIdentity: string | undefined,
    packOwner: string,
    packVisibility: string = "public",
  ): boolean {
    if (packVisibility === "public") return true;
    if (!callerIdentity) return false;
    if (callerIdentity === packOwner) return true;
    const role = this.getOrgMemberRole(packOwner, callerIdentity);
    if (role !== null) return true;
    return false;
  }

  canUserWritePack(callerIdentity: string, packOwner: string): boolean {
    if (callerIdentity === packOwner) return true;
    const role = this.getOrgMemberRole(packOwner, callerIdentity);
    return role === "owner" || role === "admin" || role === "member";
  }

  listPeers(): FederationPeerRow[] {
    return this.db
      .prepare("SELECT * FROM federation_peers ORDER BY created_at ASC")
      .all() as unknown as FederationPeerRow[];
  }

  addPeer(peer: {
    id?: string;
    name: string;
    url: string;
    status?: "active" | "unreachable" | "pending";
  }): FederationPeerRow {
    const id = peer.id ?? `peer_${Math.random().toString(36).slice(2, 10)}`;
    const status = peer.status ?? "active";
    const now = new Date().toISOString();
    const cleanUrl = peer.url.replace(/\/+$/, "");

    this.db
      .prepare(`
        INSERT INTO federation_peers (id, name, url, status, created_at, last_synced_at)
        VALUES (?, ?, ?, ?, ?, NULL)
        ON CONFLICT(url) DO UPDATE SET
          name = excluded.name,
          status = excluded.status
      `)
      .run(id, peer.name, cleanUrl, status, now);

    return this.db
      .prepare("SELECT * FROM federation_peers WHERE url = ?")
      .get(cleanUrl) as unknown as FederationPeerRow;
  }

  getPeer(idOrUrl: string): FederationPeerRow | null {
    const clean = idOrUrl.replace(/\/+$/, "");
    const row = this.db
      .prepare("SELECT * FROM federation_peers WHERE id = ? OR url = ?")
      .get(idOrUrl, clean);
    return (row as unknown as FederationPeerRow) ?? null;
  }

  removePeer(idOrUrl: string): boolean {
    const clean = idOrUrl.replace(/\/+$/, "");
    const res = this.db
      .prepare("DELETE FROM federation_peers WHERE id = ? OR url = ?")
      .run(idOrUrl, clean);
    return (res.changes ?? 0) > 0;
  }

  updatePeerStatus(id: string, status: "active" | "unreachable", lastSyncedAt?: string): void {
    this.db
      .prepare("UPDATE federation_peers SET status = ?, last_synced_at = ? WHERE id = ?")
      .run(status, lastSyncedAt ?? new Date().toISOString(), id);
  }
}

