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
        setAuthError("Invalid Bearer token: rejected by /api/v1/me");
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
            placeholder="search packs…"
          />
          <button type="submit">search</button>
        </form>
        <a className={`header-link${publishMatch ? " active" : ""}`} href="#/publish">
          publish
        </a>

        {/* Identity / API Token Bar (Human via UI, AI via API Symmetry) */}
        <div
          className="identity-bar"
          style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}
        >
          {session ? (
            <>
              <button
                type="button"
                onClick={() => {
                  setAuthError(null);
                  setAuthModalOpen(true);
                }}
                title="View identity, organizations, federation peers & API token"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                  padding: "7px 12px",
                  fontSize: "0.85rem",
                  borderColor: "rgba(52, 211, 153, 0.4)",
                  backgroundColor: "rgba(52, 211, 153, 0.08)",
                  color: "#34d399",
                  fontWeight: 600,
                }}
              >
                <span>●</span>
                <span>@{session.owner}</span>
              </button>
              <button
                type="button"
                onClick={handleCopyBearerToken}
                title="Copy Bearer Token for AI / CLI symmetry"
                style={{
                  padding: "7px 12px",
                  fontSize: "0.82rem",
                  whiteSpace: "nowrap",
                }}
              >
                {copiedToken ? "✓ Copied Bearer Token" : "Copy Bearer Token (for AI / CLI)"}
              </button>
              <button
                type="button"
                onClick={handleSignOut}
                style={{
                  padding: "7px 10px",
                  fontSize: "0.82rem",
                  color: "var(--muted)",
                }}
              >
                Sign Out
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => {
                setAuthError(null);
                setAuthModalOpen(true);
              }}
              style={{
                padding: "8px 14px",
                fontSize: "0.85rem",
                borderColor: "var(--accent)",
                color: "var(--accent)",
                fontWeight: 600,
                whiteSpace: "nowrap",
              }}
            >
              🔑 Sign In / API Token
            </button>
          )}
        </div>
      </header>

      {/* Interactive Identity & API Token Symmetry Modal */}
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
              maxWidth: "500px",
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
                marginBottom: "14px",
              }}
            >
              <h3 style={{ margin: 0, fontSize: "1.1rem" }}>
                🔑 Identity &amp; API Token Symmetry
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
              Human via WebUI and AI / CLI via API share the exact same Bearer token identity for
              Playground sandboxes, starring, publishing, and RBAC organizations.
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
                    <span className="muted" style={{ fontSize: "0.78rem", display: "block" }}>
                      Connected Owner Namespace
                    </span>
                    <strong style={{ color: "#34d399", fontSize: "1rem" }}>@{session.owner}</strong>
                  </div>
                  <div style={{ display: "flex", gap: "8px" }}>
                    <button
                      type="button"
                      onClick={handleCopyBearerToken}
                      style={{ fontSize: "0.8rem", padding: "6px 10px" }}
                    >
                      {copiedToken ? "✓ Copied" : "Copy Bearer Token (for AI / CLI)"}
                    </button>
                    <button
                      type="button"
                      onClick={handleSignOut}
                      style={{ fontSize: "0.8rem", padding: "6px 10px", color: "var(--danger)" }}
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
                Login / Register
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
                Paste Bearer Token
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
                    Sign In Existing User
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
                    Register New Namespace
                  </button>
                </div>
                <input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="Username / owner namespace (e.g. alice)"
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
                    ? "Authenticating…"
                    : authMode === "register"
                      ? "Register & Obtain Bearer Token"
                      : "Sign In & Obtain Bearer Token"}
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
                  placeholder="Paste Bearer token (from AGENTSHARE_TOKENS or CLI)"
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
                  {authBusy ? "Verifying Token…" : "Connect Bearer Token"}
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
