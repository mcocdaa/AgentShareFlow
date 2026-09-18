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
  versions: string[];
  starred?: boolean;
  manifest: {
    license?: string;
    compatibility?: string[];
    skills?: string[];
    secrets?: string[];
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

async function get<T>(pathname: string): Promise<T> {
  const res = await fetch(pathname);
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
    headers: { "content-type": "application/json" },
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
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const payload = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as { sessionId: string; message: ChatMessage };
}
