import { useCallback, useEffect, useRef, useState } from "react";
import { type ChatMessage, type ShareMeta, getShare, postShareMessage } from "./api.js";

function upsertMessage(list: ChatMessage[], incoming: ChatMessage): ChatMessage[] {
  const index = list.findIndex((message) => message.id === incoming.id);
  if (index === -1) return [...list, incoming];
  const next = [...list];
  next[index] = incoming;
  return next;
}

export function SharePage({ id }: { id: string }) {
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
