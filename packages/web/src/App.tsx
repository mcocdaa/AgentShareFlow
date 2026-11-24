import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  FriendRecord,
  NodePresence,
  RoomMessage,
  RoomSummary,
  ServerToClientFrame,
  UserProfile,
} from "@agentshare/core/protocol";
import {
  ApiError,
  ServerWsClient,
  loadStoredToken,
  saveStoredToken,
  serverApi,
  type ServerInfo,
  type WsConnectionState,
} from "./api";
import { AuthView } from "./components/AuthView";
import { DmPanel } from "./components/DmPanel";
import {
  RoomChat,
  type LoopBrokenState,
} from "./components/RoomChat";
import { Sidebar, type ActiveView } from "./components/Sidebar";
import { useI18n } from "./i18n";

const THEME_STORAGE_KEY = "agentshare_theme";

function readInitialTheme(): "dark" | "light" {
  try {
    const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    // Ignore storage restriction
  }
  return "dark";
}

function applyThemeToDocument(theme: "dark" | "light"): void {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]');
  if (meta) {
    meta.content = theme;
  }
  document.documentElement.dataset.theme = theme;
}

function mergeRoomMessage(
  existing: RoomMessage[],
  incoming: RoomMessage,
): RoomMessage[] {
  if (existing.some((m) => m.id === incoming.id)) {
    return existing;
  }
  const next = [...existing, incoming];
  next.sort((a, b) => a.seq - b.seq || a.createdAt - b.createdAt);
  return next;
}

interface ToastItem {
  id: string;
  kind: "info" | "error";
  text: string;
}

export function App() {
  const { t } = useI18n();

  const [theme, setTheme] = useState<"dark" | "light">(readInitialTheme);
  const [booting, setBooting] = useState(true);
  const [serverInfo, setServerInfo] = useState<ServerInfo | null>(null);
  const [serverInfoError, setServerInfoError] = useState(false);

  const [token, setToken] = useState<string | null>(loadStoredToken);
  const [user, setUser] = useState<UserProfile | null>(null);
  const [authNotice, setAuthNotice] = useState<string | null>(null);

  const [relayEnabled, setRelayEnabled] = useState(false);
  const [wsState, setWsState] = useState<WsConnectionState>("disconnected");

  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [friends, setFriends] = useState<FriendRecord[]>([]);
  const [nodes, setNodes] = useState<NodePresence[]>([]);
  const [activeView, setActiveView] = useState<ActiveView>(null);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

  const [roomMessages, setRoomMessages] = useState<Record<string, RoomMessage[]>>({});
  const [loadingRoomId, setLoadingRoomId] = useState<string | null>(null);
  const [loopBrokenByRoom, setLoopBrokenByRoom] = useState<
    Record<string, LoopBrokenState | null>
  >({});
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const wsRef = useRef<ServerWsClient | null>(null);
  const activeViewRef = useRef<ActiveView>(activeView);
  activeViewRef.current = activeView;
  const roomsRef = useRef<RoomSummary[]>(rooms);
  roomsRef.current = rooms;

  const pushToast = useCallback((kind: "info" | "error", text: string) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setToasts((prev) => [...prev.slice(-2), { id, kind, text }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((item) => item.id !== id));
    }, 5000);
  }, []);

  // Keep DOM meta + data-theme synchronized and listen for cross-tab changes
  useEffect(() => {
    applyThemeToDocument(theme);
  }, [theme]);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === THEME_STORAGE_KEY && (e.newValue === "light" || e.newValue === "dark")) {
        setTheme(e.newValue);
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next = prev === "dark" ? "light" : "dark";
      try {
        window.localStorage.setItem(THEME_STORAGE_KEY, next);
      } catch {
        // Ignore storage restriction
      }
      return next;
    });
  }, []);

  // Bootstrap server info and stored session
  useEffect(() => {
    let active = true;
    const bootstrap = async () => {
      try {
        const info = await serverApi.serverInfo();
        if (!active) return;
        setServerInfo(info);
        setRelayEnabled(info.relayEnabled);
        setServerInfoError(false);
      } catch {
        if (!active) return;
        setServerInfoError(true);
      }

      const savedToken = loadStoredToken();
      if (savedToken) {
        try {
          const meRes = await serverApi.me(savedToken);
          if (!active) return;
          setToken(savedToken);
          setUser(meRes.user);
        } catch (err) {
          if (!active) return;
          if (err instanceof ApiError && err.status === 401) {
            saveStoredToken(null);
            setToken(null);
            setUser(null);
            setAuthNotice(t("app.sessionExpired"));
          }
        }
      }

      if (active) setBooting(false);
    };

    void bootstrap();
    return () => {
      active = false;
    };
  }, [t]);

  const refreshSocial = useCallback(async () => {
    if (!token) return;
    try {
      const [friendsRes, nodesRes] = await Promise.all([
        serverApi.listFriends(token),
        serverApi.listNodes(token),
      ]);
      setFriends(friendsRes.friends);
      setNodes(nodesRes.nodes);
    } catch {
      // Non-fatal refresh error
    }
  }, [token]);

  const loadWorkspaceData = useCallback(async (authToken: string) => {
    const [roomsRes, friendsRes, nodesRes] = await Promise.all([
      serverApi.listRooms(authToken),
      serverApi.listFriends(authToken),
      serverApi.listNodes(authToken),
    ]);
    // Also prime unread inbox check (server tracks mention counts on rooms too)
    void serverApi.listInbox(authToken, { unreadOnly: true }).catch(() => {});

    setRooms(roomsRes.rooms);
    setFriends(friendsRes.friends);
    setNodes(nodesRes.nodes);

    setActiveView((prev) => {
      if (prev) return prev;
      const firstRoom = roomsRes.rooms[0];
      return firstRoom ? { kind: "room", roomId: firstRoom.id } : null;
    });
  }, []);

  const handleWsFrame = useCallback(
    (frame: ServerToClientFrame) => {
      switch (frame.type) {
        case "presence.update": {
          setNodes((prev) => {
            const idx = prev.findIndex((n) => n.nodeId === frame.node.nodeId);
            if (idx === -1) return [...prev, frame.node];
            const copy = [...prev];
            copy[idx] = frame.node;
            return copy;
          });
          break;
        }

        case "room.message": {
          const msg = frame.message;
          setRoomMessages((prev) => ({
            ...prev,
            [msg.roomId]: mergeRoomMessage(prev[msg.roomId] ?? [], msg),
          }));

          if (msg.senderType === "human" || !msg.loopBroken) {
            setLoopBrokenByRoom((prev) =>
              prev[msg.roomId] ? { ...prev, [msg.roomId]: null } : prev,
            );
          }

          const current = activeViewRef.current;
          const isViewing =
            current?.kind === "room" && current.roomId === msg.roomId;
          if (!isViewing) {
            setRooms((prev) =>
              prev.map((r) =>
                r.id === msg.roomId
                  ? { ...r, unreadCount: (r.unreadCount ?? 0) + 1 }
                  : r,
              ),
            );
          }
          break;
        }

        case "inbox.mention": {
          const { item, message } = frame;
          setRoomMessages((prev) => ({
            ...prev,
            [message.roomId]: mergeRoomMessage(prev[message.roomId] ?? [], message),
          }));

          const current = activeViewRef.current;
          const isViewing =
            current?.kind === "room" && current.roomId === message.roomId;
          if (!isViewing) {
            setRooms((prev) =>
              prev.map((r) =>
                r.id === message.roomId
                  ? { ...r, mentionCount: (r.mentionCount ?? 0) + 1 }
                  : r,
              ),
            );
            const roomName =
              item.roomName ??
              roomsRef.current.find((r) => r.id === message.roomId)?.name ??
              message.roomId;
            pushToast(
              "info",
              t("toast.mentionReceived", {
                from: item.fromHandle,
                room: roomName,
              }),
            );
          }
          break;
        }

        case "room.loop_broken": {
          setRoomMessages((prev) => ({
            ...prev,
            [frame.roomId]: mergeRoomMessage(prev[frame.roomId] ?? [], frame.message),
          }));
          setLoopBrokenByRoom((prev) => ({
            ...prev,
            [frame.roomId]: {
              hopCount: frame.hopCount,
              maxAgentHops: frame.maxAgentHops,
              hopChainId: frame.hopChainId,
            },
          }));
          break;
        }

        case "settings.update": {
          setRelayEnabled(frame.relayEnabled);
          setServerInfo((prev) =>
            prev ? { ...prev, relayEnabled: frame.relayEnabled } : prev,
          );
          break;
        }

        case "error": {
          pushToast("error", frame.message);
          break;
        }

        default:
          break;
      }
    },
    [pushToast, t],
  );

  // Connect WS & load initial workspace data whenever authenticated
  useEffect(() => {
    if (!token || !user) return;
    let active = true;

    void loadWorkspaceData(token).catch((err) => {
      if (!active) return;
      if (err instanceof ApiError && err.status === 401) {
        saveStoredToken(null);
        setToken(null);
        setUser(null);
        setAuthNotice(t("app.sessionExpired"));
      }
    });

    const ws = new ServerWsClient(token, {
      onFrame: handleWsFrame,
      onStateChange: setWsState,
      onAuthFailure: () => {
        saveStoredToken(null);
        setToken(null);
        setUser(null);
        setAuthNotice(t("app.sessionExpired"));
      },
    });
    wsRef.current = ws;
    ws.connect();

    return () => {
      active = false;
      ws.close();
      if (wsRef.current === ws) {
        wsRef.current = null;
      }
    };
  }, [token, user, loadWorkspaceData, handleWsFrame, t]);

  // Subscribe WS to every joined room
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws) return;
    for (const room of rooms) {
      ws.subscribeRoom(room.id);
    }
  }, [rooms]);

  // Fetch room messages when switching active room
  useEffect(() => {
    if (!token || activeView?.kind !== "room") return;
    const roomId = activeView.roomId;
    let active = true;

    wsRef.current?.subscribeRoom(roomId);
    setLoadingRoomId(roomId);
    serverApi
      .listRoomMessages(token, roomId, { sinceSeq: 0, limit: 50 })
      .then((res) => {
        if (!active) return;
        setRoomMessages((prev) => ({
          ...prev,
          [roomId]: res.messages,
        }));
      })
      .catch(() => {
        // Keep existing cache on transient error
      })
      .finally(() => {
        if (active) setLoadingRoomId((curr) => (curr === roomId ? null : curr));
      });

    return () => {
      active = false;
    };
  }, [token, activeView]);

  const handleAuthenticated = useCallback((newToken: string, newUser: UserProfile) => {
    saveStoredToken(newToken);
    setAuthNotice(null);
    setToken(newToken);
    setUser(newUser);
    setServerInfo((prev) => (prev ? { ...prev, needsBootstrap: false } : prev));
  }, []);

  const handleSignOut = useCallback(async () => {
    const currentToken = token;
    wsRef.current?.close();
    wsRef.current = null;
    saveStoredToken(null);
    setToken(null);
    setUser(null);
    setRooms([]);
    setFriends([]);
    setNodes([]);
    setRoomMessages({});
    setLoopBrokenByRoom({});
    setActiveView(null);
    setMobileSidebarOpen(false);
    if (currentToken) {
      await serverApi.logout(currentToken).catch(() => {});
    }
  }, [token]);

  const handleSelectRoom = useCallback((roomId: string) => {
    setActiveView({ kind: "room", roomId });
    setRooms((prev) =>
      prev.map((r) =>
        r.id === roomId ? { ...r, unreadCount: 0, mentionCount: 0 } : r,
      ),
    );
  }, []);

  const handleSelectDm = useCallback((peerHandle: string) => {
    setActiveView({ kind: "dm", peerHandle });
  }, []);

  const handleRoomCreated = useCallback((room: RoomSummary) => {
    setRooms((prev) =>
      prev.some((r) => r.id === room.id) ? prev : [...prev, room],
    );
    wsRef.current?.subscribeRoom(room.id);
    setActiveView({ kind: "room", roomId: room.id });
  }, []);

  const handleMessageSent = useCallback((message: RoomMessage) => {
    setRoomMessages((prev) => ({
      ...prev,
      [message.roomId]: mergeRoomMessage(prev[message.roomId] ?? [], message),
    }));
    if (message.senderType === "human" || !message.loopBroken) {
      setLoopBrokenByRoom((prev) => ({ ...prev, [message.roomId]: null }));
    }
  }, []);

  const handleMarkRead = useCallback(
    (roomId: string, seq: number) => {
      if (!token || seq <= 0) return;
      setRooms((prev) =>
        prev.map((r) =>
          r.id === roomId ? { ...r, unreadCount: 0, mentionCount: 0 } : r,
        ),
      );
      void serverApi.markRoomRead(token, roomId, seq).catch(() => {});
    },
    [token],
  );

  const activeRoom = useMemo(() => {
    if (activeView?.kind !== "room") return null;
    return rooms.find((r) => r.id === activeView.roomId) ?? null;
  }, [activeView, rooms]);

  const activePeer = useMemo(() => {
    if (activeView?.kind !== "dm") return null;
    return nodes.find((n) => n.handle === activeView.peerHandle) ?? null;
  }, [activeView, nodes]);

  if (booting) {
    return (
      <main className="boot-screen">
        <div className="boot-card">
          <span className="brand-mark" aria-hidden="true">
            AS
          </span>
          <p>{t("app.loading")}</p>
        </div>
      </main>
    );
  }

  if (!token || !user) {
    return (
      <AuthView
        serverInfo={serverInfo}
        serverInfoError={serverInfoError}
        notice={authNotice}
        theme={theme}
        onToggleTheme={toggleTheme}
        onAuthenticated={handleAuthenticated}
      />
    );
  }

  return (
    <div className="app-shell">
      <Sidebar
        token={token}
        user={user}
        relayEnabled={relayEnabled}
        wsState={wsState}
        rooms={rooms}
        friends={friends}
        nodes={nodes}
        activeView={activeView}
        theme={theme}
        mobileOpen={mobileSidebarOpen}
        onCloseMobile={() => setMobileSidebarOpen(false)}
        onToggleTheme={toggleTheme}
        onSignOut={() => void handleSignOut()}
        onSelectRoom={handleSelectRoom}
        onSelectDm={handleSelectDm}
        onRoomCreated={handleRoomCreated}
        onRelayChanged={setRelayEnabled}
        onRefreshSocial={refreshSocial}
      />

      <main className="workspace-main">
        {activeRoom ? (
          <RoomChat
            token={token}
            user={user}
            room={activeRoom}
            messages={roomMessages[activeRoom.id] ?? []}
            loadingMessages={
              loadingRoomId === activeRoom.id &&
              (roomMessages[activeRoom.id]?.length ?? 0) === 0
            }
            loopBrokenState={loopBrokenByRoom[activeRoom.id] ?? null}
            nodes={nodes}
            friends={friends}
            onOpenMobileSidebar={() => setMobileSidebarOpen(true)}
            onMessageSent={handleMessageSent}
            onMarkRead={handleMarkRead}
          />
        ) : activePeer ? (
          <DmPanel
            peer={activePeer}
            relayEnabled={relayEnabled}
            onOpenMobileSidebar={() => setMobileSidebarOpen(true)}
          />
        ) : (
          <section className="welcome-pane">
            <div className="welcome-mobile-bar">
              <button
                type="button"
                className="icon-btn mobile-menu-btn"
                aria-label={t("app.openMenu")}
                onClick={() => setMobileSidebarOpen(true)}
              >
                <span aria-hidden="true">☰</span>
              </button>
            </div>
            <div className="welcome-card">
              <span className="brand-mark brand-mark-lg" aria-hidden="true">
                AS
              </span>
              <h1>{t("app.welcomeTitle")}</h1>
              <p>{t("app.welcomeSubtitle")}</p>
            </div>
          </section>
        )}
      </main>

      {toasts.length > 0 ? (
        <div className="toast-stack" aria-live="polite">
          {toasts.map((toast) => (
            <div
              key={toast.id}
              className={
                toast.kind === "error" ? "toast toast-error" : "toast toast-info"
              }
            >
              <span>{toast.text}</span>
              <button
                type="button"
                className="icon-btn toast-close"
                aria-label={t("app.dismiss")}
                onClick={() =>
                  setToasts((prev) => prev.filter((item) => item.id !== toast.id))
                }
              >
                ×
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
