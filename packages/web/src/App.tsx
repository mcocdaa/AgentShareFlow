import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ChatMessage,
  type PackDetail,
  type PackSummary,
  type ShareMeta,
  getPack,
  getShare,
  postShareMessage,
  searchPacks,
} from "./api.js";

function useHashRoute(): string {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return hash;
}

function ModeBadge({ mode }: { mode: string }) {
  return <span className={`badge mode-${mode}`}>{mode}</span>;
}

function InstallCommand({ owner, name }: { owner: string; name: string }) {
  const command = `npx @agentshare/cli install ${owner}/${name} --target agents`;
  return (
    <div className="install">
      <code>{command}</code>
      <button onClick={() => void navigator.clipboard.writeText(command)}>copy</button>
    </div>
  );
}

function PackCard({ pack }: { pack: PackSummary }) {
  return (
    <a className="card" href={`#/agents/${pack.owner}/${pack.name}`}>
      <div className="card-head">
        <span className="ref">
          {pack.owner}/{pack.name}
        </span>
        <ModeBadge mode={pack.mode} />
      </div>
      <h3>{pack.title}</h3>
      <p>{pack.description}</p>
      <div className="card-foot">
        <span>v{pack.version}</span>
        <span>{pack.downloads} downloads</span>
      </div>
    </a>
  );
}

function Detail({ owner, name }: { owner: string; name: string }) {
  const [detail, setDetail] = useState<PackDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDetail(null);
    setError(null);
    getPack(owner, name).then(setDetail).catch((err: Error) => setError(err.message));
  }, [owner, name]);

  if (error) return <p className="error">{error}</p>;
  if (!detail) return <p className="muted">loading…</p>;

  return (
    <div className="detail">
      <a className="back" href="#/">
        ← back
      </a>
      <div className="card-head">
        <span className="ref">
          {detail.owner}/{detail.name}@{detail.version}
        </span>
        <ModeBadge mode={detail.mode} />
      </div>
      <h2>{detail.title}</h2>
      <p>{detail.description}</p>
      <InstallCommand owner={detail.owner} name={detail.name} />
      <dl>
        <dt>downloads</dt>
        <dd>{detail.downloads}</dd>
        <dt>versions</dt>
        <dd>{detail.versions.join(", ")}</dd>
        <dt>targets</dt>
        <dd>{(detail.manifest.compatibility ?? []).join(", ")}</dd>
        {detail.manifest.endpoint && (
          <>
            <dt>endpoint</dt>
            <dd>
              {detail.manifest.endpoint.type} {detail.manifest.endpoint.url}
            </dd>
          </>
        )}
        {detail.manifest.runtime && (
          <>
            <dt>runtime</dt>
            <dd>
              {detail.manifest.runtime.image ?? detail.manifest.runtime.dockerfile} (
              {detail.manifest.runtime.protocol})
            </dd>
          </>
        )}
        {(detail.manifest.secrets ?? []).length > 0 && (
          <>
            <dt>secrets</dt>
            <dd>{detail.manifest.secrets?.join(", ")}</dd>
          </>
        )}
        <dt>sha256</dt>
        <dd className="digest">{detail.digest}</dd>
      </dl>
    </div>
  );
}

function upsertMessage(list: ChatMessage[], incoming: ChatMessage): ChatMessage[] {
  const index = list.findIndex((message) => message.id === incoming.id);
  if (index === -1) return [...list, incoming];
  const next = [...list];
  next[index] = incoming;
  return next;
}

function SharePage({ id }: { id: string }) {
  const [meta, setMeta] = useState<ShareMeta | null>(null);
  const [status, setStatus] = useState<ShareMeta["status"]>("offline");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streamText, setStreamText] = useState("");
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);
  const [draft, setDraft] = useState("");
  const [name, setName] = useState(() => localStorage.getItem("agentshare.visitorName") ?? "");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setMeta(null);
    setError(null);
    getShare(id)
      .then((share) => {
        setMeta(share);
        setStatus(share.status);
      })
      .catch((err: Error) => setError(err.message));
  }, [id]);

  useEffect(() => {
    if (!meta) return;
    const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
    const source = new EventSource(`/api/v1/shares/${encodeURIComponent(id)}/events${query}`);
    source.addEventListener("status", (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as { status: ShareMeta["status"] };
      setStatus(payload.status);
    });
    source.addEventListener("message", (event) => {
      const message = JSON.parse((event as MessageEvent).data) as ChatMessage;
      setMessages((prev) => upsertMessage(prev, message));
      if (message.role === "agent") setStreamText("");
    });
    source.addEventListener("delta", (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as { content: string };
      setStreamText((prev) => prev + payload.content);
    });
    source.addEventListener("done", () => setStreamText(""));
    return () => source.close();
  }, [meta, id, sessionId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamText]);

  const send = useCallback(async () => {
    const content = draft.trim();
    if (!content || sending) return;
    setSending(true);
    setError(null);
    try {
      if (name.trim()) localStorage.setItem("agentshare.visitorName", name.trim());
      const result = await postShareMessage(id, {
        ...(sessionId === undefined ? {} : { sessionId }),
        content,
        ...(name.trim() === "" ? {} : { visitorName: name.trim() }),
      });
      setSessionId(result.sessionId);
      setMessages((prev) => upsertMessage(prev, result.message));
      setDraft("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }, [draft, sending, id, sessionId, name]);

  if (error && !meta) return <p className="error">{error}</p>;
  if (!meta) return <p className="muted">loading…</p>;

  const disabled = status !== "online" || sending;

  return (
    <div className="share">
      <a className="back" href="#/">
        ← back
      </a>
      <div className="card-head">
        <span className="ref">
          {meta.owner} · {meta.title}
        </span>
        <span className={`badge status-${status}`}>{status}</span>
      </div>
      <p className="muted small">
        {status === "online"
          ? "You are talking to a live agent session on the owner's machine. Read-only."
          : status === "revoked"
            ? "This share has been revoked."
            : "The owner is offline. The link works again when their agent is sharing."}
      </p>

      <div className="chat">
        {messages.map((message) => (
          <div key={message.id} className={`bubble ${message.role}`}>
            {message.content}
          </div>
        ))}
        {streamText && <div className="bubble agent streaming">{streamText}</div>}
        {messages.length === 0 && !streamText && (
          <p className="muted">no messages yet — say hi</p>
        )}
        <div ref={bottomRef} />
      </div>

      {error && <p className="error">{error}</p>}

      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <input
          className="name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="your name"
          maxLength={40}
        />
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={disabled ? "offline" : "ask the agent…"}
          disabled={disabled}
        />
        <button type="submit" disabled={disabled}>
          send
        </button>
      </form>
    </div>
  );
}

export function App() {
  const hash = useHashRoute();
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<PackSummary[]>([]);
  const [loading, setLoading] = useState(true);

  const runSearch = useCallback((value: string) => {
    setLoading(true);
    searchPacks(value)
      .then((result) => setItems(result.items))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, []);

  const shareMatch = /^#\/share\/([a-f0-9]+)$/.exec(hash);
  const detailMatch = /^#\/agents\/([^/]+)\/([^/]+)$/.exec(hash);

  useEffect(() => {
    if (!detailMatch && !shareMatch) runSearch("");
  }, [hash, detailMatch, shareMatch, runSearch]);

  return (
    <div className="app">
      <header>
        <a className="logo" href="#/">
          AgentShareFlow
        </a>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            runSearch(query);
          }}
        >
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="search packs…"
          />
          <button type="submit">search</button>
        </form>
      </header>
      <main>
        {shareMatch ? (
          <SharePage id={shareMatch[1] ?? ""} />
        ) : detailMatch ? (
          <Detail
            owner={decodeURIComponent(detailMatch[1] ?? "")}
            name={decodeURIComponent(detailMatch[2] ?? "")}
          />
        ) : loading ? (
          <p className="muted">loading…</p>
        ) : items.length === 0 ? (
          <p className="muted">no packs yet — publish one with the CLI</p>
        ) : (
          <div className="grid">
            {items.map((pack) => (
              <PackCard key={`${pack.owner}/${pack.name}`} pack={pack} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
