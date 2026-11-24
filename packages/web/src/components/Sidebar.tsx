import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import type {
  FriendRecord,
  NodeKind,
  NodePresence,
  PairCodeRecord,
  RoomSummary,
  UserProfile,
  UserRole,
} from "@agentshare/core/protocol";
import {
  ApiError,
  serverApi,
  type InviteRecord,
  type WsConnectionState,
} from "../api";
import { useI18n } from "../i18n";
import { CopyButton } from "./CopyButton";
import {
  BrandIcon,
  GlobeIcon,
  HashIcon,
  KeyIcon,
  LogOutIcon,
  MoonIcon,
  PlusIcon,
  RelayIcon,
  SettingsIcon,
  ShieldCheckIcon,
  SunIcon,
  UserPlusIcon,
  getAvatarMeta,
} from "./Icons";
import { ModalDialog } from "./ModalDialog";

export type ActiveView =
  | { kind: "room"; roomId: string }
  | { kind: "dm"; peerHandle: string }
  | null;

interface SidebarProps {
  token: string;
  user: UserProfile;
  relayEnabled: boolean;
  wsState: WsConnectionState;
  rooms: RoomSummary[];
  friends: FriendRecord[];
  nodes: NodePresence[];
  activeView: ActiveView;
  theme: "dark" | "light";
  mobileOpen: boolean;
  onCloseMobile: () => void;
  onToggleTheme: () => void;
  onSignOut: () => void;
  onSelectRoom: (roomId: string) => void;
  onSelectDm: (peerHandle: string) => void;
  onRoomCreated: (room: RoomSummary) => void;
  onRelayChanged: (enabled: boolean) => void;
  onRefreshSocial: () => Promise<void>;
}

const KIND_LABELS: Record<NodeKind, string> = {
  mcp: "MCP",
  http: "HTTP",
  a2a: "A2A",
  cli: "CLI",
  "human-web": "WEB",
};

function formatShortTime(ts: number | null, locale: string): string {
  if (!ts) return "";
  try {
    return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(ts));
  } catch {
    return new Date(ts).toLocaleString();
  }
}

export function Sidebar({
  token,
  user,
  relayEnabled,
  wsState,
  rooms,
  friends,
  nodes,
  activeView,
  theme,
  mobileOpen,
  onCloseMobile,
  onToggleTheme,
  onSignOut,
  onSelectRoom,
  onSelectDm,
  onRoomCreated,
  onRelayChanged,
  onRefreshSocial,
}: SidebarProps) {
  const { t, locale, toggleLocale } = useI18n();

  const [adminOpen, setAdminOpen] = useState(false);
  const [newRoomOpen, setNewRoomOpen] = useState(false);
  const [addFriendOpen, setAddFriendOpen] = useState(false);
  const [pairCodeOpen, setPairCodeOpen] = useState(false);

  // Admin modal state
  const [invites, setInvites] = useState<InviteRecord[]>([]);
  const [inviteRole, setInviteRole] = useState<UserRole>("member");
  const [inviteMaxUses, setInviteMaxUses] = useState("5");
  const [inviteExpiryHours, setInviteExpiryHours] = useState("168");
  const [adminBusy, setAdminBusy] = useState(false);
  const [adminMsg, setAdminMsg] = useState<string | null>(null);
  const [adminErr, setAdminErr] = useState<string | null>(null);

  // New room modal state
  const [roomName, setRoomName] = useState("");
  const [roomSlug, setRoomSlug] = useState("");
  const [roomTopic, setRoomTopic] = useState("");
  const [roomMaxHops, setRoomMaxHops] = useState("5");
  const [roomBusy, setRoomBusy] = useState(false);
  const [roomErr, setRoomErr] = useState<string | null>(null);

  // Add friend modal state
  const [friendUsername, setFriendUsername] = useState("");
  const [friendBusy, setFriendBusy] = useState(false);
  const [friendMsg, setFriendMsg] = useState<string | null>(null);
  const [friendErr, setFriendErr] = useState<string | null>(null);

  // Pair code modal state
  const [pairTab, setPairTab] = useState<"create" | "redeem">("create");
  const [pairNodeId, setPairNodeId] = useState("");
  const [pairMaxUses, setPairMaxUses] = useState("1");
  const [pairExpiresMin, setPairExpiresMin] = useState("30");
  const [createdPair, setCreatedPair] = useState<PairCodeRecord | null>(null);
  const [redeemInput, setRedeemInput] = useState("");
  const [pairBusy, setPairBusy] = useState(false);
  const [pairMsg, setPairMsg] = useState<string | null>(null);
  const [pairErr, setPairErr] = useState<string | null>(null);

  const [friendActionId, setFriendActionId] = useState<string | null>(null);

  const incomingRequests = useMemo(
    () => friends.filter((f) => f.status === "pending" && f.direction === "incoming"),
    [friends],
  );
  const outgoingRequests = useMemo(
    () => friends.filter((f) => f.status === "pending" && f.direction === "outgoing"),
    [friends],
  );
  const acceptedFriends = useMemo(
    () => friends.filter((f) => f.status === "accepted"),
    [friends],
  );
  const myNodes = useMemo(
    () => nodes.filter((n) => n.ownerUserId === user.id),
    [nodes, user.id],
  );
  const sortedNodes = useMemo(() => {
    return [...nodes].sort((a, b) => {
      if (a.online !== b.online) return a.online ? -1 : 1;
      return a.handle.localeCompare(b.handle);
    });
  }, [nodes]);

  const loadInvites = useCallback(async () => {
    if (user.role !== "admin") return;
    try {
      const res = await serverApi.listInvites(token);
      setInvites(res.invites);
    } catch (err) {
      setAdminErr(err instanceof ApiError ? err.message : t("error.generic"));
    }
  }, [token, user.role, t]);

  useEffect(() => {
    if (adminOpen && user.role === "admin") {
      setAdminMsg(null);
      setAdminErr(null);
      void loadInvites();
    }
  }, [adminOpen, user.role, loadInvites]);

  const handleToggleRelay = async () => {
    setAdminBusy(true);
    setAdminErr(null);
    setAdminMsg(null);
    try {
      const res = await serverApi.updateSettings(token, {
        enableRelay: !relayEnabled,
      });
      onRelayChanged(res.relayEnabled);
      setAdminMsg(t("admin.relaySaved"));
    } catch (err) {
      setAdminErr(err instanceof ApiError ? err.message : t("error.generic"));
    } finally {
      setAdminBusy(false);
    }
  };

  const handleCreateInvite = async (e: FormEvent) => {
    e.preventDefault();
    setAdminBusy(true);
    setAdminErr(null);
    setAdminMsg(null);
    try {
      const maxUses = Math.max(1, Number.parseInt(inviteMaxUses, 10) || 1);
      const expiresInHours = Math.max(1, Number.parseInt(inviteExpiryHours, 10) || 24);
      const res = await serverApi.createInvite(token, {
        role: inviteRole,
        maxUses,
        expiresInHours,
      });
      setInvites((prev) => [res.invite, ...prev]);
    } catch (err) {
      setAdminErr(err instanceof ApiError ? err.message : t("error.generic"));
    } finally {
      setAdminBusy(false);
    }
  };

  const handleCreateRoom = async (e: FormEvent) => {
    e.preventDefault();
    if (!roomName.trim()) return;
    setRoomBusy(true);
    setRoomErr(null);
    try {
      const maxAgentHops = Math.max(1, Number.parseInt(roomMaxHops, 10) || 5);
      const res = await serverApi.createRoom(token, {
        name: roomName.trim(),
        slug: roomSlug.trim() || undefined,
        topic: roomTopic.trim() || undefined,
        maxAgentHops,
      });
      onRoomCreated(res.room);
      setRoomName("");
      setRoomSlug("");
      setRoomTopic("");
      setRoomMaxHops("5");
      setNewRoomOpen(false);
      onCloseMobile();
    } catch (err) {
      setRoomErr(err instanceof ApiError ? err.message : t("error.generic"));
    } finally {
      setRoomBusy(false);
    }
  };

  const handleAddFriend = async (e: FormEvent) => {
    e.preventDefault();
    const target = friendUsername.trim().toLowerCase();
    if (!target) return;
    setFriendBusy(true);
    setFriendErr(null);
    setFriendMsg(null);
    try {
      await serverApi.requestFriend(token, target);
      setFriendMsg(t("friendModal.sent", { username: target }));
      setFriendUsername("");
      await onRefreshSocial();
    } catch (err) {
      setFriendErr(err instanceof ApiError ? err.message : t("error.generic"));
    } finally {
      setFriendBusy(false);
    }
  };

  const handleAcceptFriend = async (id: string) => {
    setFriendActionId(id);
    try {
      await serverApi.acceptFriend(token, id);
      await onRefreshSocial();
    } finally {
      setFriendActionId(null);
    }
  };

  const handleDeleteFriend = async (id: string) => {
    setFriendActionId(id);
    try {
      await serverApi.deleteFriend(token, id);
      await onRefreshSocial();
    } finally {
      setFriendActionId(null);
    }
  };

  const handleCreatePairCode = async (e: FormEvent) => {
    e.preventDefault();
    setPairBusy(true);
    setPairErr(null);
    setPairMsg(null);
    try {
      const maxUses = Math.max(1, Number.parseInt(pairMaxUses, 10) || 1);
      const expiresInMinutes = Math.max(1, Number.parseInt(pairExpiresMin, 10) || 30);
      const res = await serverApi.createPairCode(token, {
        nodeId: pairNodeId || undefined,
        maxUses,
        expiresInMinutes,
      });
      setCreatedPair(res.pairCode);
    } catch (err) {
      setPairErr(err instanceof ApiError ? err.message : t("error.generic"));
    } finally {
      setPairBusy(false);
    }
  };

  const handleRedeemPairCode = async (e: FormEvent) => {
    e.preventDefault();
    const code = redeemInput.trim();
    if (!code) return;
    setPairBusy(true);
    setPairErr(null);
    setPairMsg(null);
    try {
      const res = await serverApi.redeemPairCode(token, code);
      setPairMsg(t("pairModal.redeemed", { count: res.nodes.length }));
      setRedeemInput("");
      await onRefreshSocial();
    } catch (err) {
      setPairErr(err instanceof ApiError ? err.message : t("error.generic"));
    } finally {
      setPairBusy(false);
    }
  };

  const wsLabel =
    wsState === "connected"
      ? t("ws.connected")
      : wsState === "connecting"
        ? t("ws.connecting")
        : wsState === "unauthorized"
          ? t("ws.unauthorized")
          : t("ws.disconnected");

  return (
    <>
      {mobileOpen ? (
        <button
          type="button"
          className="sidebar-backdrop"
          aria-label={t("app.closeMenu")}
          onClick={onCloseMobile}
        />
      ) : null}

      <aside
        className={mobileOpen ? "sidebar sidebar-open" : "sidebar"}
        aria-label={t("app.name")}
      >
        <div className="sidebar-brand-bar">
          <div className="sidebar-brand">
            <span className="brand-mark brand-mark-sm" aria-hidden="true">
              <BrandIcon size={15} />
            </span>
            <span className="sidebar-brand-name truncate">{t("app.name")}</span>
          </div>

          <div className="sidebar-top-actions">
            <button
              type="button"
              className="icon-btn ghost-icon-btn"
              onClick={onToggleTheme}
              aria-label={theme === "dark" ? t("theme.toLight") : t("theme.toDark")}
              title={theme === "dark" ? t("theme.toLight") : t("theme.toDark")}
            >
              {theme === "dark" ? <SunIcon size={15} /> : <MoonIcon size={15} />}
            </button>
            <button
              type="button"
              className="ghost-btn locale-toggle-btn"
              data-action="toggle-locale"
              data-testid="locale-toggle"
              onClick={toggleLocale}
              aria-label={t("lang.toggle")}
              title={t("lang.toggle")}
            >
              <GlobeIcon size={14} />
              <span>{t("lang.short")}</span>
            </button>
          </div>
        </div>

        <div className="sidebar-scroll">
          <section className="sidebar-section">
            <div className="sidebar-section-header">
              <h2>{t("sidebar.rooms")}</h2>
              <button
                type="button"
                className="icon-btn section-icon-btn"
                aria-label={t("sidebar.newRoom")}
                title={t("sidebar.newRoom")}
                onClick={() => {
                  setRoomErr(null);
                  setNewRoomOpen(true);
                }}
              >
                <PlusIcon size={14} />
              </button>
            </div>

            {rooms.length === 0 ? (
              <p className="sidebar-empty">{t("sidebar.noRooms")}</p>
            ) : (
              <ul className="nav-list">
                {rooms.map((room) => {
                  const isActive =
                    activeView?.kind === "room" && activeView.roomId === room.id;
                  const mentions = room.mentionCount ?? 0;
                  const unread = room.unreadCount ?? 0;
                  return (
                    <li key={room.id}>
                      <button
                        type="button"
                        className={isActive ? "nav-item nav-item-active" : "nav-item"}
                        aria-current={isActive ? "page" : undefined}
                        onClick={() => {
                          onSelectRoom(room.id);
                          onCloseMobile();
                        }}
                      >
                        <span className="nav-item-label">
                          <HashIcon size={15} className="room-hash-icon" />
                          <span className="truncate">{room.name}</span>
                        </span>
                        <span className="nav-badges">
                          {mentions > 0 ? (
                            <span
                              className="badge-mention"
                              aria-label={t("sidebar.unreadMentions", {
                                count: mentions,
                              })}
                            >
                              {mentions}
                            </span>
                          ) : unread > 0 ? (
                            <span
                              className="badge-unread"
                              aria-label={t("sidebar.unreadMessages", {
                                count: unread,
                              })}
                            >
                              {unread}
                            </span>
                          ) : null}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className="sidebar-section">
            <div className="sidebar-section-header">
              <h2>{t("sidebar.friendsAndAgents")}</h2>
              <div className="section-actions">
                <button
                  type="button"
                  className="icon-btn section-icon-btn"
                  aria-label={t("sidebar.addFriend")}
                  title={t("sidebar.addFriend")}
                  onClick={() => {
                    setFriendErr(null);
                    setFriendMsg(null);
                    setAddFriendOpen(true);
                  }}
                >
                  <UserPlusIcon size={14} />
                </button>
                <button
                  type="button"
                  className="icon-btn section-icon-btn"
                  aria-label={t("sidebar.pairCode")}
                  title={t("sidebar.pairCode")}
                  onClick={() => {
                    setPairErr(null);
                    setPairMsg(null);
                    setCreatedPair(null);
                    setPairCodeOpen(true);
                  }}
                >
                  <KeyIcon size={14} />
                </button>
              </div>
            </div>

            {incomingRequests.length > 0 ? (
              <div className="sub-group">
                <h3 className="sub-group-title">{t("sidebar.incomingRequests")}</h3>
                <ul className="request-list">
                  {incomingRequests.map((req) => (
                    <li key={req.id} className="request-card">
                      <div className="request-info">
                        <span className="truncate">{req.friendDisplayName}</span>
                        <span className="muted-meta">@{req.friendUsername}</span>
                      </div>
                      <div className="request-actions">
                        <button
                          type="button"
                          className="primary-btn compact-btn"
                          disabled={friendActionId === req.id}
                          onClick={() => void handleAcceptFriend(req.id)}
                        >
                          {t("sidebar.accept")}
                        </button>
                        <button
                          type="button"
                          className="ghost-btn compact-btn"
                          disabled={friendActionId === req.id}
                          onClick={() => void handleDeleteFriend(req.id)}
                        >
                          {t("sidebar.decline")}
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {sortedNodes.length === 0 && acceptedFriends.length === 0 ? (
              <p className="sidebar-empty">{t("sidebar.noContacts")}</p>
            ) : null}

            {sortedNodes.length > 0 ? (
              <ul className="nav-list">
                {sortedNodes.map((node) => {
                  const isActive =
                    activeView?.kind === "dm" && activeView.peerHandle === node.handle;
                  const nodeAvatar = getAvatarMeta(node.handle);
                  return (
                    <li key={node.nodeId}>
                      <button
                        type="button"
                        className={isActive ? "nav-item nav-item-active" : "nav-item"}
                        aria-current={isActive ? "page" : undefined}
                        aria-label={t("sidebar.openDm", { handle: node.handle })}
                        onClick={() => {
                          onSelectDm(node.handle);
                          onCloseMobile();
                        }}
                      >
                        <span className="nav-item-label">
                          <span className="nav-avatar-wrap" aria-hidden="true">
                            <span className={`nav-avatar avatar-tone-${nodeAvatar.tone}`}>
                              {nodeAvatar.initials}
                            </span>
                            <span
                              className={
                                node.online
                                  ? "nav-avatar-dot dot-online"
                                  : "nav-avatar-dot dot-offline"
                              }
                            />
                          </span>
                          <span className="contact-text">
                            <span className="truncate contact-handle">@{node.handle}</span>
                            {node.directUrl ? (
                              <span className="muted-sub">
                                {t("sidebar.directReady")}
                              </span>
                            ) : null}
                          </span>
                        </span>
                        <span className={`kind-pill kind-${node.kind}`}>
                          {KIND_LABELS[node.kind]}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : null}

            {acceptedFriends.length > 0 ? (
              <div className="sub-group">
                <h3 className="sub-group-title">{t("sidebar.friends")}</h3>
                <ul className="friend-list">
                  {acceptedFriends.map((fr) => {
                    const friendHasOnlineNode = nodes.some(
                      (n) => n.ownerUserId === fr.friendUserId && n.online,
                    );
                    return (
                      <li key={fr.id} className="friend-row">
                        <span className="friend-row-info">
                          <span
                            className={
                              friendHasOnlineNode
                                ? "status-dot dot-online"
                                : "status-dot dot-offline"
                            }
                            aria-hidden="true"
                          />
                          <span className="truncate">
                            {fr.friendDisplayName}{" "}
                            <span className="muted-meta">@{fr.friendUsername}</span>
                          </span>
                        </span>
                        <button
                          type="button"
                          className="ghost-btn compact-btn danger-text"
                          disabled={friendActionId === fr.id}
                          onClick={() => void handleDeleteFriend(fr.id)}
                        >
                          {t("sidebar.remove")}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : null}

            {outgoingRequests.length > 0 ? (
              <div className="sub-group">
                <h3 className="sub-group-title">{t("sidebar.outgoingRequests")}</h3>
                <ul className="friend-list">
                  {outgoingRequests.map((req) => (
                    <li key={req.id} className="friend-row">
                      <span className="muted-meta truncate">@{req.friendUsername}</span>
                      <button
                        type="button"
                        className="ghost-btn compact-btn"
                        disabled={friendActionId === req.id}
                        onClick={() => void handleDeleteFriend(req.id)}
                      >
                        {t("sidebar.cancel")}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </section>
        </div>

        <footer className="sidebar-footer">
          <div className="sidebar-conn-bar">
            <span className={`ws-indicator ws-${wsState}`}>
              <span className="status-dot" aria-hidden="true" />
              <span>{wsLabel}</span>
            </span>
            {user.role === "admin" ? (
              <button
                type="button"
                className={
                  relayEnabled
                    ? "relay-chip relay-chip-warn"
                    : "relay-chip relay-chip-ok"
                }
                onClick={() => setAdminOpen(true)}
                title={t("sidebar.adminSettings")}
              >
                {relayEnabled ? <RelayIcon size={12} /> : <ShieldCheckIcon size={12} />}
                <span className="truncate">
                  {relayEnabled ? t("sidebar.relayOn") : t("sidebar.relayOff")}
                </span>
              </button>
            ) : (
              <span
                className={
                  relayEnabled
                    ? "relay-chip relay-chip-warn"
                    : "relay-chip relay-chip-ok"
                }
              >
                {relayEnabled ? <RelayIcon size={12} /> : <ShieldCheckIcon size={12} />}
                <span className="truncate">
                  {relayEnabled ? t("sidebar.relayOn") : t("sidebar.relayOff")}
                </span>
              </span>
            )}
          </div>

          <div className="sidebar-user-dock">
            <div className="user-badge">
              <span className="avatar-circle" aria-hidden="true">
                {getAvatarMeta(user.displayName || user.username).initials}
              </span>
              <div className="user-badge-text">
                <div className="user-badge-name-row">
                  <span className="user-display-name">{user.displayName}</span>
                  {user.role === "admin" ? (
                    <span className="mini-pill mini-pill-accent">
                      {t("sidebar.roleAdmin")}
                    </span>
                  ) : null}
                </div>
                <span className="user-handle truncate">@{user.username}</span>
              </div>
            </div>
            <div className="sidebar-user-actions">
              {user.role === "admin" ? (
                <button
                  type="button"
                  className="icon-btn ghost-icon-btn"
                  onClick={() => setAdminOpen(true)}
                  aria-label={t("sidebar.adminSettings")}
                  title={t("sidebar.adminSettings")}
                >
                  <SettingsIcon size={15} />
                </button>
              ) : null}
              <button
                type="button"
                className="icon-btn ghost-icon-btn danger-hover"
                onClick={onSignOut}
                aria-label={t("sidebar.signOut")}
                title={t("sidebar.signOut")}
              >
                <LogOutIcon size={15} />
              </button>
            </div>
          </div>
        </footer>
      </aside>

      {/* Admin Settings Modal */}
      {user.role === "admin" ? (
        <ModalDialog
          open={adminOpen}
          onClose={() => setAdminOpen(false)}
          title={t("admin.title")}
        >
          <div className="modal-stack">
            <section className="panel-box">
              <h2 className="panel-box-title">{t("admin.relayHeading")}</h2>
              <p className="panel-box-desc">{t("admin.relayDescription")}</p>
              <label className="toggle-row">
                <input
                  type="checkbox"
                  checked={relayEnabled}
                  disabled={adminBusy}
                  onChange={() => void handleToggleRelay()}
                />
                <span>{t("admin.relayToggleLabel")}</span>
              </label>
            </section>

            <section className="panel-box">
              <h2 className="panel-box-title">{t("admin.invitesHeading")}</h2>
              <form className="inline-grid-form" onSubmit={handleCreateInvite}>
                <div className="field">
                  <label htmlFor="invite-role">{t("admin.inviteRole")}</label>
                  <select
                    id="invite-role"
                    value={inviteRole}
                    onChange={(e) => setInviteRole(e.target.value as UserRole)}
                  >
                    <option value="member">{t("admin.roleMember")}</option>
                    <option value="admin">{t("admin.roleAdmin")}</option>
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="invite-max-uses">{t("admin.maxUses")}</label>
                  <input
                    id="invite-max-uses"
                    type="number"
                    min={1}
                    max={1000}
                    value={inviteMaxUses}
                    onChange={(e) => setInviteMaxUses(e.target.value)}
                  />
                </div>
                <div className="field">
                  <label htmlFor="invite-hours">{t("admin.expiresInHours")}</label>
                  <input
                    id="invite-hours"
                    type="number"
                    min={1}
                    max={8760}
                    value={inviteExpiryHours}
                    onChange={(e) => setInviteExpiryHours(e.target.value)}
                  />
                </div>
                <button
                  type="submit"
                  className="primary-btn"
                  disabled={adminBusy}
                >
                  {adminBusy ? t("admin.creating") : t("admin.createInvite")}
                </button>
              </form>

              {adminMsg ? (
                <div className="banner banner-ok" role="status">
                  {adminMsg}
                </div>
              ) : null}
              {adminErr ? (
                <div className="banner banner-error" role="alert">
                  {adminErr}
                </div>
              ) : null}

              {invites.length === 0 ? (
                <p className="muted-meta">{t("admin.noInvites")}</p>
              ) : (
                <ul className="code-list">
                  {invites.map((inv) => (
                    <li key={inv.code} className="code-list-item">
                      <div className="code-item-main">
                        <code className="code-token">{inv.code}</code>
                        <div className="code-item-meta">
                          <span className="mini-pill">{inv.role}</span>
                          <span>
                            {t("admin.usesCount", {
                              used: inv.usedCount,
                              max: inv.maxUses,
                            })}
                          </span>
                          <span>
                            {inv.expiresAt
                              ? t("admin.expiresAt", {
                                  time: formatShortTime(inv.expiresAt, locale),
                                })
                              : t("admin.neverExpires")}
                          </span>
                        </div>
                      </div>
                      <CopyButton
                        text={inv.code}
                        ariaLabel={t("admin.copyInvite", { code: inv.code })}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </ModalDialog>
      ) : null}

      {/* New Room Modal */}
      <ModalDialog
        open={newRoomOpen}
        onClose={() => setNewRoomOpen(false)}
        title={t("roomModal.title")}
      >
        <form className="stack-form" onSubmit={handleCreateRoom}>
          <div className="field">
            <label htmlFor="new-room-name">{t("roomModal.name")}</label>
            <input
              id="new-room-name"
              type="text"
              required
              autoFocus
              placeholder={t("roomModal.namePlaceholder")}
              value={roomName}
              onChange={(e) => setRoomName(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="new-room-slug">{t("roomModal.slug")}</label>
            <span id="new-room-slug-hint" className="field-hint">
              {t("roomModal.slugHint")}
            </span>
            <input
              id="new-room-slug"
              type="text"
              spellCheck={false}
              autoCapitalize="none"
              aria-describedby="new-room-slug-hint"
              value={roomSlug}
              onChange={(e) => setRoomSlug(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="new-room-topic">{t("roomModal.topic")}</label>
            <input
              id="new-room-topic"
              type="text"
              placeholder={t("roomModal.topicPlaceholder")}
              value={roomTopic}
              onChange={(e) => setRoomTopic(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="new-room-hops">{t("roomModal.maxAgentHops")}</label>
            <span id="new-room-hops-hint" className="field-hint">
              {t("roomModal.maxAgentHopsHint")}
            </span>
            <input
              id="new-room-hops"
              type="number"
              min={1}
              max={50}
              aria-describedby="new-room-hops-hint"
              value={roomMaxHops}
              onChange={(e) => setRoomMaxHops(e.target.value)}
            />
          </div>
          {roomErr ? (
            <div className="banner banner-error" role="alert">
              {roomErr}
            </div>
          ) : null}
          <button type="submit" className="primary-btn full-width" disabled={roomBusy}>
            {roomBusy ? t("roomModal.creating") : t("roomModal.create")}
          </button>
        </form>
      </ModalDialog>

      {/* Add Friend Modal */}
      <ModalDialog
        open={addFriendOpen}
        onClose={() => setAddFriendOpen(false)}
        title={t("friendModal.title")}
      >
        <form className="stack-form" onSubmit={handleAddFriend}>
          <div className="field">
            <label htmlFor="friend-username-input">{t("friendModal.username")}</label>
            <input
              id="friend-username-input"
              type="text"
              required
              autoFocus
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="none"
              placeholder={t("friendModal.usernamePlaceholder")}
              value={friendUsername}
              onChange={(e) => setFriendUsername(e.target.value)}
            />
          </div>
          {friendMsg ? (
            <div className="banner banner-ok" role="status">
              {friendMsg}
            </div>
          ) : null}
          {friendErr ? (
            <div className="banner banner-error" role="alert">
              {friendErr}
            </div>
          ) : null}
          <button type="submit" className="primary-btn full-width" disabled={friendBusy}>
            {friendBusy ? t("friendModal.sending") : t("friendModal.send")}
          </button>
        </form>
      </ModalDialog>

      {/* Pair Code Modal */}
      <ModalDialog
        open={pairCodeOpen}
        onClose={() => setPairCodeOpen(false)}
        title={t("pairModal.title")}
      >
        <div className="modal-stack">
          <div className="segmented-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={pairTab === "create"}
              className={pairTab === "create" ? "tab-btn tab-btn-active" : "tab-btn"}
              onClick={() => {
                setPairTab("create");
                setPairErr(null);
                setPairMsg(null);
              }}
            >
              {t("pairModal.createTab")}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={pairTab === "redeem"}
              className={pairTab === "redeem" ? "tab-btn tab-btn-active" : "tab-btn"}
              onClick={() => {
                setPairTab("redeem");
                setPairErr(null);
                setPairMsg(null);
              }}
            >
              {t("pairModal.redeemTab")}
            </button>
          </div>

          {pairTab === "create" ? (
            <form className="stack-form" onSubmit={handleCreatePairCode}>
              <div className="field">
                <label htmlFor="pair-node-select">{t("pairModal.nodeSelect")}</label>
                <select
                  id="pair-node-select"
                  value={pairNodeId}
                  onChange={(e) => setPairNodeId(e.target.value)}
                >
                  <option value="">{t("pairModal.allNodes")}</option>
                  {myNodes.map((n) => (
                    <option key={n.nodeId} value={n.nodeId}>
                      @{n.handle} ({KIND_LABELS[n.kind]})
                    </option>
                  ))}
                </select>
              </div>
              <div className="two-col-grid">
                <div className="field">
                  <label htmlFor="pair-max-uses">{t("pairModal.maxUses")}</label>
                  <input
                    id="pair-max-uses"
                    type="number"
                    min={1}
                    max={100}
                    value={pairMaxUses}
                    onChange={(e) => setPairMaxUses(e.target.value)}
                  />
                </div>
                <div className="field">
                  <label htmlFor="pair-expires-min">{t("pairModal.expiresInMinutes")}</label>
                  <input
                    id="pair-expires-min"
                    type="number"
                    min={1}
                    max={10080}
                    value={pairExpiresMin}
                    onChange={(e) => setPairExpiresMin(e.target.value)}
                  />
                </div>
              </div>
              <button type="submit" className="primary-btn full-width" disabled={pairBusy}>
                {pairBusy ? t("pairModal.generating") : t("pairModal.generate")}
              </button>

              {createdPair ? (
                <div className="panel-box">
                  <p className="panel-box-desc">{t("pairModal.generatedHint")}</p>
                  <div className="code-list-item">
                    <code className="code-token">{createdPair.code}</code>
                    <CopyButton
                      text={createdPair.code}
                      ariaLabel={t("pairModal.copyCode")}
                    />
                  </div>
                </div>
              ) : null}
            </form>
          ) : (
            <form className="stack-form" onSubmit={handleRedeemPairCode}>
              <div className="field">
                <label htmlFor="pair-redeem-input">{t("pairModal.codeLabel")}</label>
                <input
                  id="pair-redeem-input"
                  type="text"
                  required
                  autoFocus
                  spellCheck={false}
                  autoCorrect="off"
                  autoCapitalize="none"
                  placeholder={t("pairModal.codePlaceholder")}
                  value={redeemInput}
                  onChange={(e) => setRedeemInput(e.target.value)}
                />
              </div>
              <button type="submit" className="primary-btn full-width" disabled={pairBusy}>
                {pairBusy ? t("pairModal.redeeming") : t("pairModal.redeem")}
              </button>
            </form>
          )}

          {pairMsg ? (
            <div className="banner banner-ok" role="status">
              {pairMsg}
            </div>
          ) : null}
          {pairErr ? (
            <div className="banner banner-error" role="alert">
              {pairErr}
            </div>
          ) : null}
        </div>
      </ModalDialog>
    </>
  );
}
