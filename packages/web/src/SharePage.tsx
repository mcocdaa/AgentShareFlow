import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ChatMessage,
  type HandoffEvidence,
  type ShareHandoff,
  type ShareMeta,
  getShare,
  postShareMessage,
  postSubmission,
} from "./api.js";

function upsertMessage(list: ChatMessage[], incoming: ChatMessage): ChatMessage[] {
  const index = list.findIndex((message) => message.id === incoming.id);
  if (index === -1) return [...list, incoming];
  const next = [...list];
  next[index] = incoming;
  return next;
}

function safeHref(ref: string): string | undefined {
  try {
    const url = new URL(ref);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function EvidenceLine({ item }: { item: HandoffEvidence }) {
  const href = item.kind === "url" ? safeHref(item.ref) : undefined;
  return (
    <li className="evidence">
      <span className="muted small">[{item.kind}]</span> {item.label}{" "}
      {href ? (
        <a href={href} target="_blank" rel="noreferrer">
          {item.ref}
        </a>
      ) : (
        <code>{item.ref}</code>
      )}
    </li>
  );
}

const TASK_MARK: Record<ShareHandoff["tasks"][number]["status"], string> = {
  done: "[x]",
  blocked: "[!]",
  "in-progress": "[ ]",
};

const AUTH_TAG: Record<ShareHandoff["authorizations"][number]["status"], string> = {
  inherited: "可继承",
  reauthorize: "需重新授权",
  unavailable: "不可用",
};

function HandoffPanel({ handoff }: { handoff: ShareHandoff }) {
  return (
    <details className="handoff" open>
      <summary>
        Handoff · {handoff.title}
        {handoff.tasks.filter((task) => task.status !== "done").length > 0
          ? ` · ${handoff.tasks.filter((task) => task.status !== "done").length} open`
          : ""}
      </summary>
      <div className="handoff-body">
        <p>{handoff.goal}</p>
        {handoff.doneWhen && (
          <p className="muted small">完成标准：{handoff.doneWhen}</p>
        )}
        {handoff.tasks.length > 0 && (
          <>
            <h4>进度与待办</h4>
            <ul className="tasks">
              {handoff.tasks.map((task) => (
                <li key={task.id}>
                  <span className="muted">{TASK_MARK[task.status]}</span> {task.summary}
                  {task.status === "blocked" && <span className="warn">（阻塞）</span>}
                  {task.howToVerify && (
                    <div className="muted small">验证：{task.howToVerify}</div>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
        {handoff.decisions.length > 0 && (
          <>
            <h4>关键决策</h4>
            {handoff.decisions.map((decision) => (
              <div key={decision.id} className="decision">
                <p>
                  <strong>{decision.summary}</strong>
                </p>
                {decision.rationale && <p className="muted small">{decision.rationale}</p>}
                {decision.evidence.length > 0 && (
                  <ul>{decision.evidence.map((item, index) => <EvidenceLine key={index} item={item} />)}</ul>
                )}
              </div>
            ))}
          </>
        )}
        {handoff.context.sources.length > 0 && (
          <>
            <h4>资料来源</h4>
            <ul>
              {handoff.context.sources.map((item, index) => <EvidenceLine key={index} item={item} />)}
            </ul>
          </>
        )}
        {handoff.outcomes.length > 0 && (
          <>
            <h4>成果</h4>
            <ul>
              {handoff.outcomes.map((item, index) => <EvidenceLine key={index} item={item} />)}
            </ul>
          </>
        )}
        {handoff.authorizations.length > 0 && (
          <>
            <h4>授权（不会自动继承）</h4>
            <ul>
              {handoff.authorizations.map((authorization) => (
                <li key={authorization.name}>
                  <span className={authorization.status === "inherited" ? "muted" : "warn"}>
                    {AUTH_TAG[authorization.status]}
                  </span>
                  ：{authorization.name}
                  {authorization.note ? ` — ${authorization.note}` : ""}
                </li>
              ))}
            </ul>
          </>
        )}
        {(handoff.context.constraints.length > 0 || handoff.context.environment.length > 0) && (
          <>
            <h4>约束与环境</h4>
            <ul>
              {[...handoff.context.constraints, ...handoff.context.environment].map((item, index) => (
                <li key={index}>{item}</li>
              ))}
            </ul>
          </>
        )}
        {handoff.openQuestions.length > 0 && (
          <>
            <h4>待解决问题</h4>
            <ul>
              {handoff.openQuestions.map((question, index) => <li key={index}>{question}</li>)}
            </ul>
          </>
        )}
        <p className="muted small">
          资料来源未经过验证；权限不会自动继承。可以在下面追问某个决策的依据。
        </p>
      </div>
    </details>
  );
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
  const [summary, setSummary] = useState("");
  const [changes, setChanges] = useState("");
  const [openQuestions, setOpenQuestions] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submissionNote, setSubmissionNote] = useState<string | null>(null);
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

  const submitOutcome = useCallback(async () => {
    const text = summary.trim();
    if (!text || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      if (name.trim()) localStorage.setItem("agentshare.visitorName", name.trim());
      const toLines = (value: string): string[] =>
        value.split("\n").map((line) => line.trim()).filter(Boolean);
      const created = await postSubmission(id, {
        summary: text,
        changes: toLines(changes),
        openQuestions: toLines(openQuestions),
        ...(name.trim() === "" ? {} : { authorName: name.trim() }),
        ...(sessionId === undefined ? {} : { sessionId }),
      });
      setSubmissionNote(
        `已提交 #${created.id}，等待原任务人接收${
          sessionId === undefined ? "（先在对话里发一条消息，结果会通知到会话）" : ""
        }`,
      );
      setSummary("");
      setChanges("");
      setOpenQuestions("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }, [summary, changes, openQuestions, submitting, id, name, sessionId]);

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
        {status === "revoked"
          ? "This share has been revoked."
          : meta.mode === "endpoint"
            ? `You are talking to a remote agent over A2A${meta.agent?.name ? `: ${meta.agent.name}` : ""}.`
            : status === "online"
              ? "You are talking to a live agent session on the owner's machine. Read-only."
              : "The owner is offline. The link works again when their agent is sharing."}
      </p>

      {meta.handoff && <HandoffPanel handoff={meta.handoff} />}

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

      {meta.handoff && (
        <details className="submission">
          <summary>提交成果</summary>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submitOutcome();
            }}
          >
            <textarea
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
              placeholder="这次续做完成了什么？"
              maxLength={4000}
              rows={3}
              required
            />
            <textarea
              value={changes}
              onChange={(event) => setChanges(event.target.value)}
              placeholder="变更说明，每行一条（可选）"
              maxLength={8000}
              rows={3}
            />
            <textarea
              value={openQuestions}
              onChange={(event) => setOpenQuestions(event.target.value)}
              placeholder="未解决的问题，每行一条（可选）"
              maxLength={4000}
              rows={2}
            />
            <button type="submit" disabled={submitting || summary.trim() === ""}>
              {submitting ? "提交中…" : "提交"}
            </button>
          </form>
          {submissionNote && <p className="muted small">{submissionNote}</p>}
        </details>
      )}
    </div>
  );
}
