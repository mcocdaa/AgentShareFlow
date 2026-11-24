import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import type {
  FriendRecord,
  NodeKind,
  NodePresence,
  RoomMessage,
  RoomSummary,
  UserProfile,
} from "@agentshare/core/protocol";
import { ApiError, serverApi, type RoomMember } from "../api";
import { useI18n } from "../i18n";
import { MarkdownView } from "./MarkdownView";
import { ModalDialog } from "./ModalDialog";

export interface MentionCandidate {
  handle: string;
  displayName: string;
  kind: NodeKind | "human";
  online?: boolean;
}

export interface ActiveMentionMatch {
  query: string;
  startIndex: number;
}

export function extractActiveMentionQuery(
  text: string,
  cursorPos: number,
): ActiveMentionMatch | null {
  const safeCursor = Math.max(0, Math.min(cursorPos, text.length));
  const before = text.slice(0, safeCursor);
  const atIndex = before.lastIndexOf("@");
  if (atIndex === -1) return null;

  if (atIndex > 0) {
    const prevChar = before[atIndex - 1] ?? "";
    if (/[\w@.]/.test(prevChar)) return null;
  }

  const query = before.slice(atIndex + 1);
  if (!/^[a-zA-Z0-9_-]*$/.test(query)) return null;

  return { query, startIndex: atIndex };
}

export function filterMentionCandidates(
  candidates: readonly MentionCandidate[],
  query: string,
): MentionCandidate[] {
  const q = query.trim().toLowerCase();
  const seen = new Set<string>();
  const unique: MentionCandidate[] = [];

  for (const item of candidates) {
    const norm = item.handle.trim().toLowerCase();
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    unique.push(item);
  }

  const matched = q
    ? unique.filter(
        (c) =>
          c.handle.toLowerCase().includes(q) ||
          c.displayName.toLowerCase().includes(q),
      )
    : unique;

  return matched.sort((a, b) => {
    const ah = a.handle.toLowerCase();
    const bh = b.handle.toLowerCase();
    const ad = a.displayName.toLowerCase();
    const bd = b.displayName.toLowerCase();

    if (q) {
      const aRank =
        ah === q ? 0 : ah.startsWith(q) ? 1 : ad.startsWith(q) ? 2 : 3;
      const bRank =
        bh === q ? 0 : bh.startsWith(q) ? 1 : bd.startsWith(q) ? 2 : 3;
      if (aRank !== bRank) return aRank - bRank;
    }

    const aOnline = a.online ? 1 : 0;
    const bOnline = b.online ? 1 : 0;
    if (aOnline !== bOnline) return bOnline - aOnline;

    return ah.localeCompare(bh);
  });
}

export interface LoopBrokenState {
  hopCount: number;
  maxAgentHops: number;
  hopChainId: string;
}

interface RoomChatProps {
  token: string;
  user: UserProfile;
  room: RoomSummary;
  messages: RoomMessage[];
  loadingMessages: boolean;
  loopBrokenState: LoopBrokenState | null;
  nodes: NodePresence[];
  friends: FriendRecord[];
  onOpenMobileSidebar: () => void;
  onMessageSent: (message: RoomMessage) => void;
  onMarkRead: (roomId: string, seq: number) => void;
}

function formatMessageTime(ts: number, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", {
      hour: "2-digit",
      minute: "2-digit",
      month: "short",
      day: "numeric",
    }).format(new Date(ts));
  } catch {
    return new Date(ts).toLocaleTimeString();
  }
}

export function RoomChat({
  token,
  user,
  room,
  messages,
  loadingMessages,
  loopBrokenState,
  nodes,
  friends,
  onOpenMobileSidebar,
  onMessageSent,
  onMarkRead,
}: RoomChatProps) {
  const { t, locale } = useI18n();
  const [draft, setDraft] = useState("");
  const [cursorPos, setCursorPos] = useState(0);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const [membersOpen, setMembersOpen] = useState(false);
  const [members, setMembers] = useState<RoomMember[]>([]);
  const [inviteUsername, setInviteUsername] = useState("");
  const [inviting, setInviting] = useState(false);
  const [inviteMsg, setInviteMsg] = useState<string | null>(null);
  const [inviteErr, setInviteErr] = useState<string | null>(null);

  const [showJumpButton, setShowJumpButton] = useState(false);

  const streamRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const pinnedBottomRef = useRef(true);
  const lastReadSeqRef = useRef(0);

  const loadMembers = useCallback(async () => {
    try {
      const res = await serverApi.listRoomMembers(token, room.id);
      setMembers(res.members);
    } catch {
      // Leave current members state
    }
  }, [token, room.id]);

  useEffect(() => {
    setMembers([]);
    setDraft("");
    setSendError(null);
    setShowJumpButton(false);
    pinnedBottomRef.current = true;
    lastReadSeqRef.current = 0;
    void loadMembers();
  }, [room.id, loadMembers]);

  useEffect(() => {
    if (membersOpen) {
      setInviteMsg(null);
      setInviteErr(null);
      void loadMembers();
    }
  }, [membersOpen, loadMembers]);

  const selfHandles = useMemo(() => {
    const set = new Set<string>([user.username.toLowerCase()]);
    for (const node of nodes) {
      if (node.ownerUserId === user.id) {
        set.add(node.handle.toLowerCase());
      }
    }
    return set;
  }, [user.id, user.username, nodes]);

  const mentionCandidates = useMemo<MentionCandidate[]>(() => {
    const list: MentionCandidate[] = [];
    const memberUserIds = new Set(members.map((m) => m.userId));

    for (const node of nodes) {
      if (
        memberUserIds.size === 0 ||
        memberUserIds.has(node.ownerUserId) ||
        node.ownerUserId === user.id
      ) {
        list.push({
          handle: node.handle,
          displayName: node.displayName,
          kind: node.kind,
          online: node.online,
        });
      }
    }

    for (const member of members) {
      list.push({
        handle: member.username,
        displayName: member.displayName,
        kind: "human",
        online: true,
      });
    }

    return list;
  }, [nodes, members, user.id]);

  const activeMention = useMemo(() => {
    if (mentionDismissed) return null;
    return extractActiveMentionQuery(draft, cursorPos);
  }, [draft, cursorPos, mentionDismissed]);

  const filteredMentions = useMemo(() => {
    if (!activeMention) return [];
    return filterMentionCandidates(mentionCandidates, activeMention.query).slice(0, 8);
  }, [activeMention, mentionCandidates]);

  useEffect(() => {
    setMentionIndex(0);
  }, [activeMention?.query]);

  const lastMessage = messages[messages.length - 1];
  const isLoopBroken = Boolean(loopBrokenState) || Boolean(lastMessage?.loopBroken);
  const brokenHops =
    loopBrokenState?.maxAgentHops ?? room.maxAgentHops;

  // Smart auto-scroll and read receipt tracking
  useEffect(() => {
    const container = streamRef.current;
    if (!container) return;

    if (pinnedBottomRef.current) {
      container.scrollTop = container.scrollHeight;
      setShowJumpButton(false);
    } else if (messages.length > 0) {
      setShowJumpButton(true);
    }

    const latestSeq = lastMessage?.seq ?? 0;
    if (latestSeq > lastReadSeqRef.current) {
      lastReadSeqRef.current = latestSeq;
      onMarkRead(room.id, latestSeq);
    }
  }, [messages, lastMessage?.seq, room.id, onMarkRead]);

  const handleStreamScroll = () => {
    const container = streamRef.current;
    if (!container) return;
    const distance =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    const nearBottom = distance < 80;
    pinnedBottomRef.current = nearBottom;
    if (nearBottom) {
      setShowJumpButton(false);
    }
  };

  const scrollToLatest = () => {
    const container = streamRef.current;
    if (!container) return;
    pinnedBottomRef.current = true;
    container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
    setShowJumpButton(false);
  };

  const applyMention = (candidate: MentionCandidate) => {
    if (!activeMention) return;
    const before = draft.slice(0, activeMention.startIndex);
    const after = draft.slice(cursorPos);
    const inserted = `@${candidate.handle} `;
    const nextDraft = `${before}${inserted}${after}`;
    const nextCursor = before.length + inserted.length;
    setDraft(nextDraft);
    setCursorPos(nextCursor);
    setMentionDismissed(false);

    window.requestAnimationFrame(() => {
      const el = composerRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(nextCursor, nextCursor);
      }
    });
  };

  const insertQuickMention = (handle: string) => {
    const prefix = draft.length > 0 && !draft.endsWith(" ") ? " " : "";
    const next = `${draft}${prefix}@${handle} `;
    setDraft(next);
    setCursorPos(next.length);
    setMembersOpen(false);
    window.requestAnimationFrame(() => {
      composerRef.current?.focus();
    });
  };

  const submitMessage = async (content: string, resetLoop?: boolean) => {
    const trimmed = content.trim();
    if (!trimmed || sending) return;
    setSending(true);
    setSendError(null);
    try {
      const res = await serverApi.sendRoomMessage(token, room.id, {
        content: trimmed,
        resetLoop,
      });
      onMessageSent(res.message);
      pinnedBottomRef.current = true;
    } catch (err) {
      setSendError(err instanceof ApiError ? err.message : t("error.generic"));
    } finally {
      setSending(false);
    }
  };

  const handleFormSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const content = draft;
    if (!content.trim()) return;
    setDraft("");
    setCursorPos(0);
    await submitMessage(content, isLoopBroken ? true : undefined);
  };

  const handleComposerKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (filteredMentions.length > 0 && activeMention) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionIndex((idx) => (idx + 1) % filteredMentions.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionIndex(
          (idx) => (idx - 1 + filteredMentions.length) % filteredMentions.length,
        );
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMentionDismissed(true);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
        const chosen = filteredMentions[mentionIndex];
        if (chosen) {
          e.preventDefault();
          applyMention(chosen);
          return;
        }
      }
    }

    if (e.key === "Enter" && !e.shiftKey) {
      if (e.nativeEvent.isComposing || e.keyCode === 229) {
        return;
      }
      e.preventDefault();
      formRef.current?.requestSubmit();
    }
  };

  const handleInviteMember = async (usernameToInvite: string) => {
    const target = usernameToInvite.trim().toLowerCase();
    if (!target) return;
    setInviting(true);
    setInviteErr(null);
    setInviteMsg(null);
    try {
      await serverApi.addRoomMember(token, room.id, target);
      setInviteMsg(t("room.memberInvited", { username: target }));
      setInviteUsername("");
      await loadMembers();
    } catch (err) {
      setInviteErr(err instanceof ApiError ? err.message : t("error.generic"));
    } finally {
      setInviting(false);
    }
  };

  const invitableFriends = useMemo(() => {
    const memberUsernames = new Set(members.map((m) => m.username.toLowerCase()));
    return friends.filter(
      (f) =>
        f.status === "accepted" &&
        !memberUsernames.has(f.friendUsername.toLowerCase()),
    );
  }, [friends, members]);

  return (
    <section className="workspace-pane" aria-label={`#${room.name}`}>
      <header className="pane-header">
        <div className="pane-header-left">
          <button
            type="button"
            className="icon-btn mobile-menu-btn"
            aria-label={t("app.openMenu")}
            onClick={onOpenMobileSidebar}
          >
            <span aria-hidden="true">☰</span>
          </button>
          <div className="pane-title-group">
            <h1 className="pane-title">
              <span className="room-hash" aria-hidden="true">
                #
              </span>
              {room.name}
            </h1>
            {room.topic ? <p className="pane-subtitle">{room.topic}</p> : null}
          </div>
        </div>

        <div className="pane-header-right">
          <span className="meta-chip">
            {t("room.maxHopsTag", { hops: room.maxAgentHops })}
          </span>
          <button
            type="button"
            className="ghost-btn"
            onClick={() => setMembersOpen(true)}
          >
            {t("room.membersButton")} ({members.length})
          </button>
        </div>
      </header>

      <div
        ref={streamRef}
        className="message-stream"
        onScroll={handleStreamScroll}
        role="log"
        aria-live="polite"
        aria-relevant="additions"
      >
        {loadingMessages ? (
          <div className="stream-empty">{t("room.loadingMessages")}</div>
        ) : messages.length === 0 ? (
          <div className="stream-empty">{t("room.empty")}</div>
        ) : (
          messages.map((msg) => {
            const mentionsSelf = msg.mentions.some((m) =>
              selfHandles.has(m.toLowerCase()),
            );
            const senderLabel =
              msg.senderType === "agent"
                ? t("room.senderAgent")
                : msg.senderType === "system"
                  ? t("room.senderSystem")
                  : t("room.senderHuman");
            return (
              <article
                key={msg.id}
                className={`msg-row ${mentionsSelf ? "msg-row-mentioned" : ""} ${msg.loopBroken ? "msg-row-loop-broken" : ""}`.trim()}
              >
                <span
                  className={`msg-avatar msg-avatar-${msg.senderType}`}
                  aria-hidden="true"
                >
                  {msg.senderHandle.slice(0, 2).toUpperCase()}
                </span>
                <div className="msg-body">
                  <div className="msg-meta">
                    <span className="msg-sender">@{msg.senderHandle}</span>
                    <span className={`sender-pill sender-pill-${msg.senderType}`}>
                      {senderLabel}
                    </span>
                    {msg.hopCount > 0 ? (
                      <span className="mini-pill">
                        {t("room.hopBadge", { count: msg.hopCount })}
                      </span>
                    ) : null}
                    {msg.loopBroken ? (
                      <span className="mini-pill mini-pill-warn">
                        {t("room.loopBrokenBadge")}
                      </span>
                    ) : null}
                    <time
                      className="msg-time"
                      dateTime={new Date(msg.createdAt).toISOString()}
                    >
                      {formatMessageTime(msg.createdAt, locale)}
                    </time>
                  </div>
                  <div className="msg-content">
                    <MarkdownView
                      content={msg.content}
                      highlightHandles={selfHandles}
                    />
                  </div>
                </div>
              </article>
            );
          })
        )}
      </div>

      {showJumpButton ? (
        <div className="jump-bar">
          <button type="button" className="jump-btn" onClick={scrollToLatest}>
            ↓ {t("room.jumpToLatest")}
          </button>
        </div>
      ) : null}

      {isLoopBroken ? (
        <div className="loop-warning-banner" role="status">
          <div className="loop-warning-text">
            <strong>{t("room.loopWarningTitle")}</strong>
            <p>{t("room.loopWarningBody", { hops: brokenHops })}</p>
          </div>
          <button
            type="button"
            className="primary-btn"
            disabled={sending}
            onClick={() =>
              void submitMessage(t("room.loopContinueMessage"), true)
            }
          >
            {t("room.loopContinue")}
          </button>
        </div>
      ) : null}

      {sendError ? (
        <div className="composer-error banner banner-error" role="alert">
          {sendError}
        </div>
      ) : null}

      <div className="composer-shell">
        {filteredMentions.length > 0 && activeMention ? (
          <ul
            className="mention-popover"
            role="listbox"
            aria-label={t("room.mentionListLabel")}
          >
            {filteredMentions.map((candidate, idx) => (
              <li
                key={candidate.handle}
                role="option"
                aria-selected={idx === mentionIndex}
              >
                <button
                  type="button"
                  className={
                    idx === mentionIndex
                      ? "mention-option mention-option-active"
                      : "mention-option"
                  }
                  onMouseDown={(e) => {
                    e.preventDefault();
                    applyMention(candidate);
                  }}
                >
                  <span
                    className={
                      candidate.online
                        ? "status-dot dot-online"
                        : "status-dot dot-offline"
                    }
                    aria-hidden="true"
                  />
                  <span className="mention-handle">@{candidate.handle}</span>
                  <span className="mention-name">{candidate.displayName}</span>
                  <span className={`kind-pill kind-${candidate.kind}`}>
                    {candidate.kind === "human"
                      ? t("room.senderHuman")
                      : candidate.kind.toUpperCase()}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        <form ref={formRef} className="composer-form" onSubmit={handleFormSubmit}>
          <label htmlFor="room-composer" className="visually-hidden">
            {t("room.composerLabel", { room: room.name })}
          </label>
          <textarea
            ref={composerRef}
            id="room-composer"
            className="composer-textarea"
            rows={1}
            placeholder={t("room.composerPlaceholder", { room: room.name })}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setCursorPos(e.target.selectionStart ?? e.target.value.length);
              setMentionDismissed(false);
            }}
            onClick={(e) => {
              setCursorPos(e.currentTarget.selectionStart ?? draft.length);
            }}
            onKeyUp={(e) => {
              setCursorPos(e.currentTarget.selectionStart ?? draft.length);
            }}
            onKeyDown={handleComposerKeyDown}
          />
          <button
            type="submit"
            className="primary-btn composer-send-btn"
            disabled={sending || !draft.trim()}
          >
            {sending ? t("room.sending") : t("room.send")}
          </button>
        </form>
      </div>

      <ModalDialog
        open={membersOpen}
        onClose={() => setMembersOpen(false)}
        title={t("room.membersDrawerTitle")}
        variant="drawer"
      >
        <div className="modal-stack">
          <form
            className="inline-invite-form"
            onSubmit={(e) => {
              e.preventDefault();
              void handleInviteMember(inviteUsername);
            }}
          >
            <label htmlFor="room-invite-input" className="visually-hidden">
              {t("room.inviteMemberLabel")}
            </label>
            <input
              id="room-invite-input"
              type="text"
              required
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="none"
              placeholder={t("room.inviteMemberPlaceholder")}
              value={inviteUsername}
              onChange={(e) => setInviteUsername(e.target.value)}
            />
            <button type="submit" className="primary-btn" disabled={inviting}>
              {inviting ? t("room.inviting") : t("room.inviteMemberButton")}
            </button>
          </form>

          {inviteMsg ? (
            <div className="banner banner-ok" role="status">
              {inviteMsg}
            </div>
          ) : null}
          {inviteErr ? (
            <div className="banner banner-error" role="alert">
              {inviteErr}
            </div>
          ) : null}

          {invitableFriends.length > 0 ? (
            <div className="panel-box">
              <h2 className="panel-box-title">{t("room.quickInviteFriends")}</h2>
              <div className="chip-row">
                {invitableFriends.map((fr) => (
                  <button
                    key={fr.id}
                    type="button"
                    className="ghost-btn compact-btn"
                    disabled={inviting}
                    onClick={() => void handleInviteMember(fr.friendUsername)}
                  >
                    + @{fr.friendUsername}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {members.length === 0 ? (
            <p className="muted-meta">{t("room.noMembers")}</p>
          ) : (
            <ul className="member-drawer-list">
              {members.map((member) => {
                const memberNodes = nodes.filter(
                  (n) => n.ownerUserId === member.userId,
                );
                return (
                  <li key={member.userId || member.username} className="member-card">
                    <div className="member-card-top">
                      <div>
                        <strong>{member.displayName}</strong>
                        <span className="muted-meta"> @{member.username}</span>
                      </div>
                      <button
                        type="button"
                        className="ghost-btn compact-btn"
                        onClick={() => insertQuickMention(member.username)}
                      >
                        {t("room.mentionAction")}
                      </button>
                    </div>
                    {memberNodes.length > 0 ? (
                      <div className="member-nodes">
                        <span className="muted-sub">{t("room.memberAgents")}:</span>
                        <div className="chip-row">
                          {memberNodes.map((node) => (
                            <button
                              key={node.nodeId}
                              type="button"
                              className="node-mention-chip"
                              onClick={() => insertQuickMention(node.handle)}
                            >
                              <span
                                className={
                                  node.online
                                    ? "status-dot dot-online"
                                    : "status-dot dot-offline"
                                }
                                aria-hidden="true"
                              />
                              @{node.handle}
                              <span className={`kind-pill kind-${node.kind}`}>
                                {node.kind.toUpperCase()}
                              </span>
                            </button>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </ModalDialog>
    </section>
  );
}
