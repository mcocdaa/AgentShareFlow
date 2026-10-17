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
import { type TranslationKey, translateEvidenceKind, useI18n } from "./i18n.js";
import { MarkdownView } from "./MarkdownView.js";

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
  const { locale, td } = useI18n();
  const href = item.kind === "url" ? safeHref(item.ref) : undefined;
  return (
    <li className="evidence">
      <span className="muted small">[{translateEvidenceKind(item.kind, locale)}]</span> {td(item.label)}{" "}
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

const AUTH_TAG_KEY: Record<ShareHandoff["authorizations"][number]["status"], TranslationKey> = {
  inherited: "authInherited",
  reauthorize: "authReauthorize",
  unavailable: "authUnavailable",
};

function HandoffPanel({ handoff }: { handoff: ShareHandoff }) {
  const { t, td } = useI18n();
  const openCount = handoff.tasks.filter((task) => task.status !== "done").length;
  return (
    <details className="handoff">
      <summary>
        {t("handoffContextPrefix")} · {td(handoff.title)}
        {openCount > 0
          ? ` (${openCount} ${t("handoffOpenTasksSuffix")})`
          : ` (${t("handoffComplete")})`}
      </summary>
      <div className="handoff-body">
        <p>{td(handoff.goal)}</p>
        {handoff.doneWhen && (
          <p className="muted small">{t("handoffDoneWhen")} {td(handoff.doneWhen)}</p>
        )}
        {handoff.tasks.length > 0 && (
          <>
            <h4>{t("handoffTasksTitle")}</h4>
            <ul className="tasks">
              {handoff.tasks.map((task) => (
                <li key={task.id}>
                  <span className="muted">{TASK_MARK[task.status]}</span> {td(task.summary)}
                  {task.status === "blocked" && <span className="warn">{t("handoffBlocked")}</span>}
                  {task.howToVerify && (
                    <div className="muted small">{t("handoffVerify")} {td(task.howToVerify)}</div>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
        {handoff.decisions.length > 0 && (
          <>
            <h4>{t("handoffDecisionsTitle")}</h4>
            {handoff.decisions.map((decision) => (
              <div key={decision.id} className="decision">
                <p>
                  <strong>{td(decision.summary)}</strong>
                </p>
                {decision.rationale && <p className="muted small">{td(decision.rationale)}</p>}
                {decision.evidence.length > 0 && (
                  <ul>{decision.evidence.map((item, index) => <EvidenceLine key={index} item={item} />)}</ul>
                )}
              </div>
            ))}
          </>
        )}
        {handoff.context.sources.length > 0 && (
          <>
            <h4>{t("handoffSourcesTitle")}</h4>
            <ul>
              {handoff.context.sources.map((item, index) => <EvidenceLine key={index} item={item} />)}
            </ul>
          </>
        )}
        {handoff.outcomes.length > 0 && (
          <>
            <h4>{t("handoffOutcomesTitle")}</h4>
            <ul>
              {handoff.outcomes.map((item, index) => <EvidenceLine key={index} item={item} />)}
            </ul>
          </>
        )}
        {handoff.authorizations.length > 0 && (
          <>
            <h4>{t("handoffAuthTitle")}</h4>
            <ul>
              {handoff.authorizations.map((authorization) => (
                <li key={authorization.name}>
                  <span className={authorization.status === "inherited" ? "muted" : "warn"}>
                    {t(AUTH_TAG_KEY[authorization.status])}
                  </span>
                  : {authorization.name}
                  {authorization.note ? ` — ${td(authorization.note)}` : ""}
                </li>
              ))}
            </ul>
          </>
        )}
        {(handoff.context.constraints.length > 0 || handoff.context.environment.length > 0) && (
          <>
            <h4>{t("handoffConstraintsTitle")}</h4>
            <ul>
              {[...handoff.context.constraints, ...handoff.context.environment].map((item, index) => (
                <li key={index}>{td(item)}</li>
              ))}
            </ul>
          </>
        )}
        {handoff.openQuestions.length > 0 && (
          <>
            <h4>{t("handoffQuestionsTitle")}</h4>
            <ul>
              {handoff.openQuestions.map((question, index) => <li key={index}>{td(question)}</li>)}
            </ul>
          </>
        )}
        <p className="muted small">
          {t("handoffFooterNote")}
        </p>
      </div>
    </details>
  );
}

export function SharePage({ id, compact = false }: { id: string; compact?: boolean }) {
  const { t, td } = useI18n();
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
  const [submissionState, setSubmissionState] = useState<{
    id: number;
    hasSession: boolean;
  } | null>(null);
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
      setSubmissionState({ id: created.id, hasSession: sessionId !== undefined });
      setSummary("");
      setChanges("");
      setOpenQuestions("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }, [summary, changes, openQuestions, submitting, id, name, sessionId]);

  if (error && !meta) return <p className="error">{td(error)}</p>;
  if (!meta) return <p className="muted">{t("loadingCatalog")}</p>;

  const disabled = status !== "online" || sending;

  return (
    <div className={`share${compact ? " compact" : ""}`}>
      {!compact && (
        <a className="back" href="#/">
          {t("backLink")}
        </a>
      )}
      <div className="card-head">
        <span className="ref">
          {meta.owner} · {td(meta.title)}
        </span>
        <span className={`badge status-${status}`}>
          {t(`shareStatus_${status}`)}
        </span>
      </div>
      <p className="muted small">
        {status === "revoked"
          ? t("shareRevoked")
          : meta.mode === "endpoint"
            ? `${t("shareEndpointPrefix")}${meta.agent?.name ? `: ${meta.agent.name}` : ""}.`
            : status === "online"
              ? t("shareOnlineDesc")
              : t("shareOfflineDesc")}
      </p>

      {meta.handoff && <HandoffPanel handoff={meta.handoff} />}

      <div className="chat">
        {messages.map((message) => (
          <div key={message.id} className={`bubble ${message.role}`}>
            <div className="bubble-author">
              {message.role === "visitor"
                ? (name || t("roleVisitor"))
                : message.role === "agent"
                  ? (meta.agent?.name ?? t("roleAgent"))
                  : t("roleSystem")}
            </div>
            {message.role === "system" ? (
              <div className="bubble-system-text">{message.content}</div>
            ) : (
              <MarkdownView content={message.content} />
            )}
          </div>
        ))}
        {streamText && (
          <div className="bubble agent streaming">
            <div className="bubble-author">{meta.agent?.name ?? t("roleAgent")}</div>
            <MarkdownView content={streamText} />
            <span className="typing-cursor" />
          </div>
        )}
        {messages.length === 0 && !streamText && (
          <div className="chat-empty">
            <span className="chat-empty-icon">💬</span>
            <p>{t("chatEmpty")}</p>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {error && <p className="error">{td(error)}</p>}

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
          placeholder={t("yourNamePlaceholder")}
          maxLength={40}
        />
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={disabled ? t("offlinePlaceholder") : t("askAgentPlaceholder")}
          disabled={disabled}
        />
        <button type="submit" disabled={disabled}>
          {t("sendBtn")}
        </button>
      </form>

      {meta.handoff && (
        <details className="submission">
          <summary>{t("submitOutcomeSummary")}</summary>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submitOutcome();
            }}
          >
            <textarea
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
              placeholder={t("submitSummaryPlaceholder")}
              maxLength={4000}
              rows={3}
              required
            />
            <textarea
              value={changes}
              onChange={(event) => setChanges(event.target.value)}
              placeholder={t("submitChangesPlaceholder")}
              maxLength={8000}
              rows={3}
            />
            <textarea
              value={openQuestions}
              onChange={(event) => setOpenQuestions(event.target.value)}
              placeholder={t("submitQuestionsPlaceholder")}
              maxLength={4000}
              rows={2}
            />
            <button type="submit" disabled={submitting || summary.trim() === ""}>
              {submitting ? t("submittingBtn") : t("submitBtn")}
            </button>
          </form>
          {submissionState && (
            <p className="muted small">
              {`${t("submittedPrefix")}${submissionState.id}${
                submissionState.hasSession ? "" : t("submittedNoSessionHint")
              }`}
            </p>
          )}
        </details>
      )}
    </div>
  );
}
