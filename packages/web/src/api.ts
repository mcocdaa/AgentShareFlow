export interface PackSummary {
  owner: string;
  name: string;
  version: string;
  title: string;
  description: string;
  mode: string;
  tags: string[];
  downloads: number;
  stars: number;
  createdAt: string;
}

export interface PackDetail extends PackSummary {
  digest: string;
  size: number;
  downloadUrl: string;
  readmeUrl?: string;
  readme?: string | null;
  versions: string[];
  starred?: boolean;
  signature?: {
    publicKey: string;
    sig?: string;
    value?: string;
    algorithm?: string;
    fingerprint?: string;
  } | null;
  manifest: {
    license?: string;
    compatibility?: string[];
    skills?: string[];
    secrets?: string[];
    mcp?: { config: string };
    endpoint?: { type: string; url: string; agentCard?: string };
    runtime?: { image?: string; dockerfile?: string; protocol?: string };
    metadata?: Record<string, string>;
  };
}

export interface HandoffEvidence {
  label: string;
  kind: "path" | "url" | "transcript" | "note";
  ref: string;
}

export interface ShareHandoff {
  id: string;
  title: string;
  goal: string;
  doneWhen?: string;
  context: { constraints: string[]; environment: string[]; sources: HandoffEvidence[] };
  decisions: Array<{ id: string; summary: string; rationale?: string; evidence: HandoffEvidence[] }>;
  tasks: Array<{
    id: string;
    summary: string;
    status: "in-progress" | "blocked" | "done";
    howToVerify?: string;
    notes?: string;
  }>;
  outcomes: HandoffEvidence[];
  authorizations: Array<{
    name: string;
    status: "inherited" | "reauthorize" | "unavailable";
    note?: string;
  }>;
  openQuestions: string[];
}

export interface ShareMeta {
  id: string;
  owner: string;
  title: string;
  mode?: "tunnel" | "endpoint";
  project?: string;
  status: "online" | "offline" | "revoked";
  url?: string;
  agent?: { name: string; description?: string; skills?: Array<{ id: string; name: string }> };
  handoff?: ShareHandoff;
  hasHandoff?: boolean;
  createdAt: string;
  lastSeenAt?: string;
}

export interface ChatMessage {
  id: number;
  sessionId: string;
  role: "visitor" | "agent" | "system";
  content: string;
  createdAt: string;
}

export interface SubmissionInput {
  summary: string;
  changes: string[];
  openQuestions: string[];
  authorName?: string;
  sessionId?: string;
}

export interface ShareSubmission {
  id: number;
  shareId: string;
  sessionId?: string;
  authorName?: string;
  summary: string;
  changes: string[];
  openQuestions: string[];
  status: "pending" | "accepted" | "rejected";
  ownerNote?: string;
  createdAt: string;
  decidedAt?: string;
}

export const TOKEN_STORAGE_KEY = "agentshare_token";

export function getStoredToken(): string | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const tok =
      localStorage.getItem(TOKEN_STORAGE_KEY) ?? localStorage.getItem("agentshare.token");
    return tok && tok.trim().length > 0 ? tok.trim() : null;
  } catch {
    return null;
  }
}

export function setStoredToken(token: string | null): void {
  try {
    if (typeof localStorage === "undefined") return;
    if (token && token.trim().length > 0) {
      const clean = token.trim();
      localStorage.setItem(TOKEN_STORAGE_KEY, clean);
      localStorage.setItem("agentshare.token", clean);
    } else {
      localStorage.removeItem(TOKEN_STORAGE_KEY);
      localStorage.removeItem("agentshare.token");
    }
  } catch {
    // ignore storage errors
  }
}

export function authHeaders(): Record<string, string> {
  const token = getStoredToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function get<T>(pathname: string): Promise<T> {
  const res = await fetch(pathname, {
    headers: { ...authHeaders() },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export function searchPacks(query: string): Promise<{ items: PackSummary[] }> {
  return get(`/api/v1/search?q=${encodeURIComponent(query)}`);
}

export function getPack(owner: string, name: string): Promise<PackDetail> {
  return get(`/api/v1/agents/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`);
}

export function getShare(id: string): Promise<ShareMeta> {
  return get(`/api/v1/shares/${encodeURIComponent(id)}`);
}

export async function postSubmission(id: string, body: SubmissionInput): Promise<ShareSubmission> {
  const res = await fetch(`/api/v1/shares/${encodeURIComponent(id)}/submissions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify({ spec: "submission/v0", ...body }),
  });
  if (!res.ok) {
    const payload = (await res.json().catch(() => ({}))) as { error?: string; details?: string };
    throw new Error(payload.details ?? payload.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as ShareSubmission;
}

export async function postShareMessage(
  id: string,
  body: { sessionId?: string; content: string; visitorName?: string },
): Promise<{ sessionId: string; message: ChatMessage }> {
  const res = await fetch(`/api/v1/shares/${encodeURIComponent(id)}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const payload = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as { sessionId: string; message: ChatMessage };
}

export interface PublishResult {
  ok: boolean;
  ref: string;
  digest: string;
  size: number;
}

export interface SessionInfo {
  owner: string;
  email?: string;
  name?: string;
}

export async function getSession(): Promise<SessionInfo | null> {
  const res = await fetch("/api/v1/me", {
    headers: { ...authHeaders() },
  });
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as SessionInfo | null;
  return body !== null && typeof body.owner === "string" ? body : null;
}

export interface AuthResponse {
  ok: boolean;
  owner: string;
  username: string;
  token: string;
}

export async function loginOrRegister(
  username: string,
  password: string,
  mode: "login" | "register",
): Promise<AuthResponse> {
  const endpoint = mode === "register" ? "/api/v1/auth/register" : "/api/v1/auth/login";
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    const payload = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error ?? `Authentication failed (HTTP ${res.status})`);
  }
  const data = (await res.json()) as AuthResponse;
  if (data.token) {
    setStoredToken(data.token);
  }
  return data;
}

export interface OrgInfo {
  name: string;
  display_name: string;
  description: string;
  created_at: string;
}

export interface UserOrgMembership {
  org: OrgInfo;
  role: "owner" | "admin" | "member" | "viewer";
}

export interface FederationPeer {
  id: string;
  name: string;
  url: string;
  status: "active" | "unreachable" | "pending";
  created_at: string;
  last_synced_at: string | null;
}

export function listOrgs(): Promise<{ organizations: UserOrgMembership[] }> {
  return get("/api/v1/orgs");
}

export function listFederationPeers(): Promise<{ peers: FederationPeer[] }> {
  return get("/api/v1/federation/peers");
}

export async function publishPack(
  token: string | undefined,
  manifest: unknown,
  bytes: Uint8Array,
  digest: string,
): Promise<PublishResult> {
  const form = new FormData();
  form.set("manifest", JSON.stringify(manifest));
  form.set("tarball", new Blob([new Uint8Array(bytes)], { type: "application/gzip" }), "pack.tgz");
  const headers: Record<string, string> = {
    ...authHeaders(),
    "x-pack-digest": digest,
  };
  if (token !== undefined && token.length > 0) headers.Authorization = `Bearer ${token}`;
  const res = await fetch("/api/v1/agents", { method: "POST", headers, body: form });
  if (!res.ok) {
    const payload = (await res.json().catch(() => ({}))) as { error?: string; details?: string };
    throw new Error(payload.details ?? payload.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as PublishResult;
}

export async function toggleStar(
  owner: string,
  name: string,
  starred: boolean,
): Promise<{ starred: boolean; stars: number }> {
  const res = await fetch(
    `/api/v1/agents/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/star`,
    {
      method: starred ? "DELETE" : "POST",
      headers: { ...authHeaders() },
    },
  );
  if (!res.ok) {
    const payload = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as { starred: boolean; stars: number };
}

export async function fetchPackReadme(
  owner: string,
  name: string,
  version: string,
): Promise<string | null> {
  const res = await fetch(
    `/api/v1/agents/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${encodeURIComponent(version)}/readme`,
    {
      headers: { ...authHeaders() },
    },
  );
  if (!res.ok) return null;
  const payload = (await res.json().catch(() => ({}))) as { readme?: string | null };
  return payload.readme ?? null;
}

export interface PlaygroundResult {
  ok: boolean;
  output: unknown;
  logs: string[];
  executionTimeMs: number;
  exitCode: number;
  sandboxed: boolean;
  error?: string;
}

export async function runPackPlayground(
  owner: string,
  name: string,
  version: string,
  input: unknown,
): Promise<PlaygroundResult> {
  const res = await fetch(
    `/api/v1/agents/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${encodeURIComponent(version)}/playground`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(),
      },
      body: JSON.stringify({ input }),
    },
  );
  if (!res.ok) {
    const payload = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error ?? `Playground execution failed (HTTP ${res.status})`);
  }
  return res.json() as Promise<PlaygroundResult>;
}

