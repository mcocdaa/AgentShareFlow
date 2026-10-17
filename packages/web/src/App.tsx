import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  type FederationPeer,
  type PackSummary,
  type SessionInfo,
  type UserOrgMembership,
  getSession,
  getStoredToken,
  listFederationPeers,
  listOrgs,
  loginOrRegister,
  searchPacks,
  setStoredToken,
} from "./api.js";
import { PackCard } from "./components.js";
import { PackDetailPage } from "./PackDetail.js";
import { PublishPage } from "./Publish.js";
import { SharePage } from "./SharePage.js";

function useHashRoute(): string {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return hash;
}

export function App() {
  const hash = useHashRoute();
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<PackSummary[]>([]);
  const [loading, setLoading] = useState(true);

  const [session, setSession] = useState<SessionInfo | null>(null);
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [authTab, setAuthTab] = useState<"credentials" | "token">("credentials");
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [tokenInput, setTokenInput] = useState(() => getStoredToken() ?? "");
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [copiedToken, setCopiedToken] = useState(false);
  const [orgs, setOrgs] = useState<UserOrgMembership[]>([]);
  const [peers, setPeers] = useState<FederationPeer[]>([]);

  const refreshIdentity = useCallback(async () => {
    const current = await getSession();
    setSession(current);
    if (current) {
      listOrgs()
        .then((r) => setOrgs(r.organizations))
        .catch(() => setOrgs([]));
      listFederationPeers()
        .then((r) => setPeers(r.peers))
        .catch(() => setPeers([]));
    } else {
      setOrgs([]);
    }
    return current;
  }, []);

  useEffect(() => {
    void refreshIdentity();
  }, [refreshIdentity]);

  const runSearch = useCallback((value: string) => {
    setLoading(true);
    searchPacks(value)
      .then((result) => setItems(result.items))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, []);

  const shareMatch = /^#\/share\/([a-f0-9]+)$/.exec(hash);
  const embedMatch = /^#\/embed\/([a-f0-9]+)$/.exec(hash);
  const detailMatch = /^#\/agents\/([^/]+)\/([^/]+)$/.exec(hash);
  const publishMatch = hash === "#/publish";

  useEffect(() => {
    if (!detailMatch && !shareMatch && !embedMatch && !publishMatch) runSearch(query);
  }, [hash, detailMatch, shareMatch, embedMatch, publishMatch, runSearch, session?.owner]);

  const handleCopyBearerToken = () => {
    const tok = getStoredToken();
    if (!tok) {
      setAuthModalOpen(true);
      return;
    }
    void navigator.clipboard.writeText(tok);
    setCopiedToken(true);
    window.setTimeout(() => setCopiedToken(false), 1800);
  };

  const handleSignOut = () => {
    setStoredToken(null);
    setTokenInput("");
    setSession(null);
    setOrgs([]);
  };

  const handleCredentialsSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) {
      setAuthError("Username and password are required.");
      return;
    }
    setAuthBusy(true);
    setAuthError(null);
    try {
      const res = await loginOrRegister(username.trim(), password, authMode);
      setTokenInput(res.token);
      await refreshIdentity();
      setPassword("");
      setAuthModalOpen(false);
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : String(err));
    } finally {
      setAuthBusy(false);
    }
  };

  const handlePasteTokenSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const cleaned = tokenInput.trim().replace(/^Bearer\s+/i, "");
    if (!cleaned) {
      setAuthError("Please paste a valid Bearer token.");
      return;
    }
    setAuthBusy(true);
    setAuthError(null);
    try {
      setStoredToken(cleaned);
      const verified = await refreshIdentity();
      if (!verified) {
        setStoredToken(null);
        setAuthError("Invalid access token.");
        return;
      }
      setTokenInput(cleaned);
      setAuthModalOpen(false);
    } catch (err) {
      setStoredToken(null);
      setAuthError(err instanceof Error ? err.message : String(err));
    } finally {
      setAuthBusy(false);
    }
  };

  if (embedMatch) {
    return (
      <div className="embed">
        <SharePage id={embedMatch[1] ?? ""} compact />
      </div>
    );
  }

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
            placeholder="Search packs…"
          />
          <button type="submit">Search</button>
        </form>
        <a className={`header-link${publishMatch ? " active" : ""}`} href="#/publish">
          Publish
        </a>

        <div className="identity-bar">
          {session ? (
            <div className="user-pill-group">
              <button
                type="button"
                className="user-profile-pill"
                onClick={() => {
                  setAuthError(null);
                  setAuthModalOpen(true);
                }}
                title="Account & Access Token"
              >
                <span className="user-status-dot">●</span>
                <span>@{session.owner}</span>
              </button>
              <button
                type="button"
                className={`nav-icon-btn${copiedToken ? " copied" : ""}`}
                onClick={handleCopyBearerToken}
                title={copiedToken ? "Access token copied" : "Copy access token"}
                aria-label="Copy access token"
              >
                {copiedToken ? (
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                ) : (
                  <span style={{ fontSize: "0.82rem", lineHeight: 1 }}>🔑</span>
                )}
              </button>
              <button
                type="button"
                className="nav-icon-btn signout"
                onClick={handleSignOut}
                title="Sign Out"
                aria-label="Sign Out"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                  <polyline points="16 17 21 12 16 7" />
                  <line x1="21" y1="12" x2="9" y2="12" />
                </svg>
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="signin-pill-btn"
              onClick={() => {
                setAuthError(null);
                setAuthModalOpen(true);
              }}
            >
              Sign In
            </button>
          )}
        </div>
      </header>

      {authModalOpen && (
        <div
          className="identity-modal-backdrop"
          onClick={() => setAuthModalOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            backgroundColor: "rgba(5, 7, 12, 0.78)",
            backdropFilter: "blur(4px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
            padding: "16px",
          }}
        >
          <div
            className="identity-modal"
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "100%",
              maxWidth: "480px",
              background: "var(--panel)",
              border: "1px solid var(--border-focus)",
              borderRadius: "14px",
              padding: "24px",
              boxShadow: "0 20px 50px rgba(0, 0, 0, 0.6)",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: "12px",
              }}
            >
              <h3 style={{ margin: 0, fontSize: "1.1rem" }}>
                🔑 Account &amp; Access Token
              </h3>
              <button
                type="button"
                onClick={() => setAuthModalOpen(false)}
                style={{ padding: "4px 10px", fontSize: "0.85rem" }}
              >
                ✕
              </button>
            </div>

            <p className="muted" style={{ fontSize: "0.85rem", marginTop: 0, marginBottom: "16px" }}>
              Manage your account session, organization memberships, and personal access token for
              CLI publishing and sandbox execution.
            </p>

            {session && (
              <div
                style={{
                  background: "var(--panel-2)",
                  border: "1px solid rgba(52, 211, 153, 0.3)",
                  borderRadius: "10px",
                  padding: "14px",
                  marginBottom: "16px",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: "8px",
                    marginBottom: "10px",
                  }}
                >
                  <div>
                    <span className="muted" style={{ fontSize: "0.75rem", display: "block" }}>
                      Signed in as
                    </span>
                    <strong style={{ color: "#34d399", fontSize: "1rem" }}>@{session.owner}</strong>
                  </div>
                  <div style={{ display: "flex", gap: "8px", flexShrink: 0 }}>
                    <button
                      type="button"
                      onClick={handleCopyBearerToken}
                      style={{ fontSize: "0.8rem", padding: "6px 10px", whiteSpace: "nowrap" }}
                    >
                      {copiedToken ? "✓ Copied" : "Copy Token"}
                    </button>
                    <button
                      type="button"
                      onClick={handleSignOut}
                      style={{
                        fontSize: "0.8rem",
                        padding: "6px 10px",
                        color: "var(--danger)",
                        whiteSpace: "nowrap",
                      }}
                    >
                      Sign Out
                    </button>
                  </div>
                </div>

                {getStoredToken() && (
                  <div style={{ fontSize: "0.78rem", color: "var(--muted)" }}>
                    <code
                      style={{
                        display: "block",
                        background: "var(--bg)",
                        padding: "8px 10px",
                        borderRadius: "6px",
                        overflowX: "auto",
                        whiteSpace: "nowrap",
                      }}
                    >
                      export AGENTSHARE_TOKEN=&quot;{getStoredToken()}&quot;
                    </code>
                  </div>
                )}

                <div
                  style={{
                    display: "flex",
                    gap: "12px",
                    marginTop: "10px",
                    fontSize: "0.78rem",
                    color: "var(--muted)",
                  }}
                >
                  <span>
                    Orgs:{" "}
                    {orgs.length > 0
                      ? orgs.map((o) => `${o.org.name} (${o.role})`).join(", ")
                      : "none"}
                  </span>
                  <span>Federation Peers: {peers.length}</span>
                </div>
              </div>
            )}

            <div style={{ display: "flex", gap: "8px", marginBottom: "14px" }}>
              <button
                type="button"
                onClick={() => {
                  setAuthTab("credentials");
                  setAuthError(null);
                }}
                style={{
                  flex: 1,
                  padding: "8px",
                  fontSize: "0.85rem",
                  borderColor: authTab === "credentials" ? "var(--accent)" : "var(--border)",
                  color: authTab === "credentials" ? "var(--accent)" : "var(--muted)",
                  fontWeight: authTab === "credentials" ? 600 : 400,
                }}
              >
                Sign In / Register
              </button>
              <button
                type="button"
                onClick={() => {
                  setAuthTab("token");
                  setAuthError(null);
                }}
                style={{
                  flex: 1,
                  padding: "8px",
                  fontSize: "0.85rem",
                  borderColor: authTab === "token" ? "var(--accent)" : "var(--border)",
                  color: authTab === "token" ? "var(--accent)" : "var(--muted)",
                  fontWeight: authTab === "token" ? 600 : 400,
                }}
              >
                Use Access Token
              </button>
            </div>

            {authError && (
              <div
                style={{
                  background: "rgba(248, 113, 113, 0.12)",
                  border: "1px solid rgba(248, 113, 113, 0.4)",
                  color: "var(--danger)",
                  borderRadius: "8px",
                  padding: "8px 12px",
                  fontSize: "0.85rem",
                  marginBottom: "12px",
                }}
              >
                {authError}
              </div>
            )}

            {authTab === "credentials" ? (
              <form
                onSubmit={(e) => void handleCredentialsSubmit(e)}
                style={{ display: "flex", flexDirection: "column", gap: "12px" }}
              >
                <div style={{ display: "flex", gap: "8px" }}>
                  <button
                    type="button"
                    onClick={() => setAuthMode("login")}
                    style={{
                      flex: 1,
                      fontSize: "0.8rem",
                      padding: "6px",
                      borderColor: authMode === "login" ? "var(--accent)" : "var(--border)",
                    }}
                  >
                    Sign In
                  </button>
                  <button
                    type="button"
                    onClick={() => setAuthMode("register")}
                    style={{
                      flex: 1,
                      fontSize: "0.8rem",
                      padding: "6px",
                      borderColor: authMode === "register" ? "var(--accent)" : "var(--border)",
                    }}
                  >
                    Create Account
                  </button>
                </div>
                <input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="Username (e.g. alice)"
                  autoComplete="username"
                />
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Password (min 4 characters)"
                  autoComplete={authMode === "register" ? "new-password" : "current-password"}
                />
                <button
                  type="submit"
                  disabled={authBusy}
                  style={{
                    background: "var(--accent)",
                    color: "#090c12",
                    fontWeight: 700,
                    border: "none",
                  }}
                >
                  {authBusy
                    ? "Signing in…"
                    : authMode === "register"
                      ? "Create Account"
                      : "Sign In"}
                </button>
              </form>
            ) : (
              <form
                onSubmit={(e) => void handlePasteTokenSubmit(e)}
                style={{ display: "flex", flexDirection: "column", gap: "12px" }}
              >
                <input
                  type="password"
                  value={tokenInput}
                  onChange={(e) => setTokenInput(e.target.value)}
                  placeholder="Paste personal access token"
                  autoComplete="off"
                />
                <button
                  type="submit"
                  disabled={authBusy}
                  style={{
                    background: "var(--accent)",
                    color: "#090c12",
                    fontWeight: 700,
                    border: "none",
                  }}
                >
                  {authBusy ? "Verifying…" : "Save Access Token"}
                </button>
              </form>
            )}
          </div>
        </div>
      )}

      <main>
        {shareMatch ? (
          <SharePage id={shareMatch[1] ?? ""} />
        ) : publishMatch ? (
          <PublishPage />
        ) : detailMatch ? (
          <PackDetailPage
            owner={decodeURIComponent(detailMatch[1] ?? "")}
            name={decodeURIComponent(detailMatch[2] ?? "")}
            session={session}
            onRequireAuth={() => {
              setAuthError(null);
              setAuthModalOpen(true);
            }}
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
