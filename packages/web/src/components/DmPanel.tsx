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
  DmMessage,
  NodePresence,
  TransportMode,
} from "@agentshare/core/protocol";
import {
  ApiError,
  LocalNodeClient,
  loadLocalNodeConfig,
  saveLocalNodeConfig,
  type LocalNodeStatus,
  type PendingApproval,
} from "../api";
import { useI18n, type TranslationKey } from "../i18n";
import {
  ArrowLeftRightIcon,
  MenuIcon,
  RelayIcon,
  SendIcon,
  ShieldCheckIcon,
  ZapIcon,
  getAvatarMeta,
} from "./Icons";
import { MarkdownView } from "./MarkdownView";

export interface TransportBadgeMeta {
  mode: TransportMode;
  labelKey: TranslationKey;
  pillClass: string;
  miniPillClass: string;
  indicator: string;
}

export function transportBadgeMeta(transport: TransportMode): TransportBadgeMeta {
  switch (transport) {
    case "webrtc":
      return {
        mode: "webrtc",
        labelKey: "dm.transportWebrtc",
        pillClass: "status-pill status-pill-webrtc",
        miniPillClass: "mini-pill mini-pill-webrtc",
        indicator: "⇄",
      };
    case "relay":
      return {
        mode: "relay",
        labelKey: "dm.transportRelay",
        pillClass: "status-pill status-pill-warn",
        miniPillClass: "mini-pill mini-pill-warn",
        indicator: "⤴",
      };
    case "direct":
    default:
      return {
        mode: "direct",
        labelKey: "dm.transportDirect",
        pillClass: "status-pill status-pill-ok",
        miniPillClass: "mini-pill mini-pill-ok",
        indicator: "⚡",
      };
  }
}

interface DmPanelProps {
  peer: NodePresence;
  relayEnabled: boolean;
  onOpenMobileSidebar: () => void;
}

function formatTime(ts: number, locale: string): string {
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

function TransportSvg({ mode, size = 12 }: { mode: TransportMode; size?: number }) {
  if (mode === "webrtc") return <ArrowLeftRightIcon size={size} />;
  if (mode === "relay") return <RelayIcon size={size} />;
  return <ZapIcon size={size} />;
}

export function DmPanel({
  peer,
  relayEnabled,
  onOpenMobileSidebar,
}: DmPanelProps) {
  const { t, locale } = useI18n();

  const initialConfig = useMemo(() => loadLocalNodeConfig(), []);
  const [urlInput, setUrlInput] = useState(
    initialConfig?.url ?? "http://127.0.0.1:4101",
  );
  const [tokenInput, setTokenInput] = useState(initialConfig?.token ?? "");
  const [client, setClient] = useState<LocalNodeClient | null>(() => {
    if (!initialConfig?.url || !initialConfig?.token) return null;
    try {
      return new LocalNodeClient(initialConfig);
    } catch {
      return null;
    }
  });
  const [showConfigForm, setShowConfigForm] = useState(!initialConfig);
  const [localStatus, setLocalStatus] = useState<LocalNodeStatus | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);

  const [messages, setMessages] = useState<DmMessage[]>([]);
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [lastTransport, setLastTransport] = useState<TransportMode | null>(null);

  const [draft, setDraft] = useState("");
  const [forceRelay, setForceRelay] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [approvalBusyId, setApprovalBusyId] = useState<string | null>(null);
  const [approvalNotice, setApprovalNotice] = useState<string | null>(null);

  const streamRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const pinnedBottomRef = useRef(true);

  const syncFromLocalNode = useCallback(
    async (activeClient: LocalNodeClient, signal?: AbortSignal) => {
      const [statusRes, dmsRes, approvalsRes] = await Promise.all([
        activeClient.status(signal),
        activeClient.listDms(peer.handle, 50, signal),
        activeClient.listApprovals("pending", signal),
      ]);
      setLocalStatus(statusRes);
      setMessages(dmsRes.messages);
      setApprovals(approvalsRes.approvals);
      const latest = dmsRes.messages[dmsRes.messages.length - 1];
      if (latest) {
        setLastTransport(latest.transport);
      }
      setConnectionError(null);
    },
    [peer.handle],
  );

  useEffect(() => {
    setMessages([]);
    setLastTransport(null);
    setSendError(null);
    setApprovalNotice(null);
    pinnedBottomRef.current = true;
  }, [peer.handle]);

  useEffect(() => {
    if (!client) {
      setLocalStatus(null);
      return;
    }

    const controller = new AbortController();
    let active = true;

    const run = async () => {
      try {
        await syncFromLocalNode(client, controller.signal);
      } catch (err) {
        if (!active || controller.signal.aborted) return;
        setLocalStatus(null);
        setConnectionError(
          err instanceof Error ? err.message : t("error.generic"),
        );
      }
    };

    void run();
    const timer = window.setInterval(() => {
      void run();
    }, 3500);

    return () => {
      active = false;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [client, syncFromLocalNode, t]);

  useEffect(() => {
    const container = streamRef.current;
    if (container && pinnedBottomRef.current) {
      container.scrollTop = container.scrollHeight;
    }
  }, [messages]);

  const handleConnect = async (e: FormEvent) => {
    e.preventDefault();
    setConnectionError(null);
    setConnecting(true);
    try {
      const nextConfig = { url: urlInput.trim(), token: tokenInput.trim() };
      const nextClient = new LocalNodeClient(nextConfig);
      await syncFromLocalNode(nextClient);
      saveLocalNodeConfig(nextConfig);
      setClient(nextClient);
      setShowConfigForm(false);
    } catch (err) {
      setConnectionError(
        err instanceof ApiError || err instanceof Error
          ? err.message
          : t("error.generic"),
      );
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnect = () => {
    saveLocalNodeConfig(null);
    setClient(null);
    setLocalStatus(null);
    setMessages([]);
    setApprovals([]);
    setShowConfigForm(true);
  };

  const handleSendDm = async (e: FormEvent) => {
    e.preventDefault();
    if (!client || !draft.trim() || sending) return;
    const content = draft.trim();
    setSending(true);
    setSendError(null);
    try {
      const res = await client.sendDm(
        peer.handle,
        content,
        relayEnabled && forceRelay ? true : undefined,
      );
      setDraft("");
      setLastTransport(res.transport);
      setMessages((prev) =>
        prev.some((m) => m.id === res.message.id)
          ? prev
          : [...prev, res.message],
      );
      pinnedBottomRef.current = true;
    } catch (err) {
      setSendError(
        err instanceof ApiError || err instanceof Error
          ? err.message
          : t("error.generic"),
      );
    } finally {
      setSending(false);
    }
  };

  const handleComposerKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      if (e.nativeEvent.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      formRef.current?.requestSubmit();
    }
  };

  const handleApprove = async (id: string) => {
    if (!client) return;
    setApprovalBusyId(id);
    setApprovalNotice(null);
    setSendError(null);
    try {
      await client.approve(id);
      setApprovalNotice(t("dm.approvalDone"));
      await syncFromLocalNode(client);
    } catch (err) {
      setSendError(
        err instanceof ApiError || err instanceof Error
          ? err.message
          : t("error.generic"),
      );
    } finally {
      setApprovalBusyId(null);
    }
  };

  const handleReject = async (id: string) => {
    if (!client) return;
    setApprovalBusyId(id);
    setApprovalNotice(null);
    setSendError(null);
    try {
      await client.reject(id);
      setApprovalNotice(t("dm.rejectionDone"));
      await syncFromLocalNode(client);
    } catch (err) {
      setSendError(
        err instanceof ApiError || err instanceof Error
          ? err.message
          : t("error.generic"),
      );
    } finally {
      setApprovalBusyId(null);
    }
  };

  const effectiveTransport: TransportMode =
    lastTransport ??
    (peer.directUrl
      ? "direct"
      : localStatus?.webrtcEnabled !== false
        ? "webrtc"
        : relayEnabled
          ? "relay"
          : "direct");

  const headerTransport = transportBadgeMeta(effectiveTransport);
  const localWebrtcEnabled = localStatus?.webrtcEnabled !== false;

  const dmStatusLabel = (status: DmMessage["status"]): string => {
    switch (status) {
      case "delivered":
        return t("dm.statusDelivered");
      case "pending_approval":
        return t("dm.statusPending");
      case "rejected":
        return t("dm.statusRejected");
      case "failed":
        return t("dm.statusFailed");
    }
  };

  return (
    <section className="workspace-pane" aria-label={`DM @${peer.handle}`}>
      <header className="pane-header">
        <div className="pane-header-left">
          <button
            type="button"
            className="icon-btn ghost-icon-btn mobile-menu-btn"
            aria-label={t("app.openMenu")}
            onClick={onOpenMobileSidebar}
          >
            <MenuIcon size={18} />
          </button>
          <div className="pane-title-group">
            <div className="pane-title-inline">
              <span
                className={
                  peer.online ? "status-dot dot-online" : "status-dot dot-offline"
                }
                aria-hidden="true"
              />
              <h1 className="pane-title">@{peer.handle}</h1>
              <span className={`kind-pill kind-${peer.kind}`}>
                {peer.kind.toUpperCase()}
              </span>
              <span className="pane-title-sep" aria-hidden="true" />
              <p className="pane-subtitle">
                {peer.displayName} ·{" "}
                {peer.directUrl
                  ? `${t("dm.directUrlActive")} (${peer.directUrl})`
                  : t("dm.directUrlNone")}
              </p>
            </div>
          </div>
        </div>

        <div className="pane-header-right">
          <span
            className={headerTransport.pillClass}
            data-transport={headerTransport.mode}
          >
            <TransportSvg mode={headerTransport.mode} size={12} />
            <span>{t(headerTransport.labelKey)}</span>
          </span>
        </div>
      </header>

      <div className="dm-top-banners">
        <div className="dm-top-inner">
          <div className="privacy-banner" role="note">
            <ShieldCheckIcon size={15} className="privacy-banner-icon" />
            <span>
              <strong>{t("dm.privacyTitle")}:</strong> {t("dm.privacyBody")}
            </span>
          </div>

          <div className="local-node-bar">
            <div className="local-node-summary">
              <div className="local-node-status">
                <span
                  className={
                    localStatus
                      ? "status-dot dot-online"
                      : "status-dot dot-offline"
                  }
                  aria-hidden="true"
                />
                <span className="local-node-status-text">
                  <strong>{t("dm.localNodeTitle")}:</strong>{" "}
                  {localStatus
                    ? t("dm.localNodeConnected", { handle: localStatus.handle })
                    : t("dm.localNodeDisconnected")}
                </span>
                {localStatus ? (
                  <span
                    className={
                      localWebrtcEnabled
                        ? "mini-pill mini-pill-webrtc local-webrtc-pill"
                        : "mini-pill local-webrtc-pill"
                    }
                    data-webrtc={localWebrtcEnabled ? "on" : "off"}
                  >
                    <ArrowLeftRightIcon size={11} />
                    <span>
                      {localWebrtcEnabled
                        ? t("dm.localNodeWebrtcOn")
                        : t("dm.localNodeWebrtcOff")}
                    </span>
                  </span>
                ) : null}
              </div>
              <div className="local-node-actions">
                <button
                  type="button"
                  className="ghost-btn compact-btn"
                  aria-expanded={showConfigForm}
                  aria-controls="local-node-config-form"
                  onClick={() => setShowConfigForm((v) => !v)}
                >
                  {t("dm.localNodeConfigure")}
                </button>
                {client ? (
                  <button
                    type="button"
                    className="ghost-btn compact-btn danger-text"
                    onClick={handleDisconnect}
                  >
                    {t("dm.localNodeDisconnect")}
                  </button>
                ) : null}
              </div>
            </div>

            {showConfigForm ? (
              <form
                id="local-node-config-form"
                className="local-node-form"
                onSubmit={handleConnect}
              >
                <p id="local-node-setup-hint" className="field-hint">
                  {t("dm.localNodeSetupHint")}
                </p>
                <div className="local-node-inputs">
                  <div className="field">
                    <label htmlFor="local-node-url">{t("dm.localNodeUrl")}</label>
                    <input
                      id="local-node-url"
                      type="url"
                      required
                      spellCheck={false}
                      aria-describedby="local-node-setup-hint"
                      placeholder={t("dm.localNodeUrlPlaceholder")}
                      value={urlInput}
                      onChange={(e) => setUrlInput(e.target.value)}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="local-node-token">{t("dm.localNodeToken")}</label>
                    <input
                      id="local-node-token"
                      type="password"
                      required
                      autoComplete="off"
                      placeholder={t("dm.localNodeTokenPlaceholder")}
                      value={tokenInput}
                      onChange={(e) => setTokenInput(e.target.value)}
                    />
                  </div>
                  <button
                    type="submit"
                    className="primary-btn"
                    disabled={connecting}
                  >
                    {connecting
                      ? t("dm.localNodeConnecting")
                      : t("dm.localNodeConnect")}
                  </button>
                </div>
              </form>
            ) : null}

            {connectionError ? (
              <div className="banner banner-error" role="alert">
                {connectionError}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {approvals.length > 0 ? (
        <section className="approvals-panel" aria-label={t("dm.approvalsHeading", { count: approvals.length })}>
          <div className="dm-top-inner">
            <h2 className="approvals-heading">
              {t("dm.approvalsHeading", { count: approvals.length })}
            </h2>
            {approvalNotice ? (
              <div className="banner banner-ok" role="status">
                {approvalNotice}
              </div>
            ) : null}
            <ul className="approval-list">
              {approvals.map((item) => (
                <li key={item.id} className="approval-card">
                  <div className="approval-meta">
                    <strong>{t("dm.approvalFrom", { handle: item.fromHandle })}</strong>
                    <span className="mini-pill">{item.kind}</span>
                    <time className="msg-time">
                      {formatTime(item.createdAt, locale)}
                    </time>
                  </div>
                  <div className="approval-content">
                    <MarkdownView content={item.content} />
                  </div>
                  <div className="approval-actions">
                    <button
                      type="button"
                      className="primary-btn compact-btn"
                      disabled={approvalBusyId === item.id}
                      onClick={() => void handleApprove(item.id)}
                    >
                      {approvalBusyId === item.id
                        ? t("dm.approving")
                        : t("dm.approve")}
                    </button>
                    <button
                      type="button"
                      className="ghost-btn compact-btn danger-text"
                      disabled={approvalBusyId === item.id}
                      onClick={() => void handleReject(item.id)}
                    >
                      {approvalBusyId === item.id
                        ? t("dm.rejecting")
                        : t("dm.reject")}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </section>
      ) : null}

      <div
        ref={streamRef}
        className="message-stream"
        onScroll={() => {
          const el = streamRef.current;
          if (!el) return;
          pinnedBottomRef.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        role="log"
        aria-live="polite"
      >
        <div className="stream-inner">
          {!localStatus ? (
            <div className="stream-empty">
              {showConfigForm ? t("dm.localNodeDisconnected") : t("dm.localNodeSetupHint")}
            </div>
          ) : messages.length === 0 ? (
            <div className="stream-empty">
              {t("dm.empty", { handle: peer.handle })}
            </div>
          ) : (
            messages.map((msg) => {
              const isOut = msg.direction === "out";
              const msgTransport = transportBadgeMeta(msg.transport);
              const senderHandle = isOut ? localStatus.handle : msg.peerHandle;
              const avatar = getAvatarMeta(senderHandle);
              return (
                <article
                  key={msg.id}
                  className={isOut ? "msg-row msg-row-out" : "msg-row"}
                >
                  <span
                    className={`msg-avatar ${isOut ? "msg-avatar-human" : "msg-avatar-agent"} avatar-tone-${avatar.tone}`}
                    aria-hidden="true"
                  >
                    {avatar.initials}
                  </span>
                  <div className="msg-body">
                    <div className="msg-meta">
                      <span className="msg-sender">
                        {isOut ? `${t("dm.you")} (@${localStatus.handle})` : `@${msg.peerHandle}`}
                      </span>
                      <span
                        className={msgTransport.miniPillClass}
                        data-transport={msgTransport.mode}
                      >
                        <TransportSvg mode={msgTransport.mode} size={11} />
                        <span>{t(msgTransport.labelKey)}</span>
                      </span>
                      {msg.encrypted ? (
                        <span className="mini-pill">{t("dm.encryptedBadge")}</span>
                      ) : null}
                      <span className={`mini-pill dm-status-${msg.status}`}>
                        {dmStatusLabel(msg.status)}
                      </span>
                      <time
                        className="msg-time"
                        dateTime={new Date(msg.createdAt).toISOString()}
                      >
                        {formatTime(msg.createdAt, locale)}
                      </time>
                    </div>
                    <div className="msg-content">
                      <MarkdownView content={msg.content} />
                    </div>
                  </div>
                </article>
              );
            })
          )}
        </div>
      </div>

      {sendError ? (
        <div className="composer-error-wrap">
          <div className="composer-error banner banner-error" role="alert">
            {sendError}
          </div>
        </div>
      ) : null}

      <div className="composer-shell">
        <div className="composer-inner">
          <div className="dm-composer-options">
            <label className="toggle-row compact-toggle">
              <input
                type="checkbox"
                checked={relayEnabled && forceRelay}
                disabled={!relayEnabled || !localStatus}
                onChange={(e) => setForceRelay(e.target.checked)}
              />
              <span>
                {t("dm.forceRelay")}
                {!relayEnabled ? ` (${t("dm.forceRelayDisabledHint")})` : ""}
              </span>
            </label>
          </div>

          <form ref={formRef} className="composer-box" onSubmit={handleSendDm}>
            <label htmlFor="dm-composer" className="visually-hidden">
              {t("dm.composerLabel", { handle: peer.handle })}
            </label>
            <textarea
              id="dm-composer"
              className="composer-textarea"
              rows={1}
              disabled={!localStatus}
              placeholder={t("dm.composerPlaceholder", { handle: peer.handle })}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={handleComposerKeyDown}
            />
            <button
              type="submit"
              className="primary-btn composer-send-btn"
              disabled={!localStatus || sending || !draft.trim()}
            >
              <SendIcon size={14} />
              <span>{sending ? t("dm.sending") : t("dm.send")}</span>
            </button>
          </form>
        </div>
      </div>
    </section>
  );
}
