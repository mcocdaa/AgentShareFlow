import { useEffect, useState, type FormEvent } from "react";
import { HANDLE_PATTERN, type UserProfile } from "@agentshare/core/protocol";
import {
  ApiError,
  saveStoredServerUrl,
  serverApi,
  validateServerBaseUrl,
  type ServerInfo,
} from "../api";
import { useI18n } from "../i18n";

interface AuthViewProps {
  serverUrl: string;
  onChangeServerUrl: (nextUrl: string) => void;
  serverInfo: ServerInfo | null;
  serverInfoError: boolean;
  notice?: string | null;
  theme: "dark" | "light";
  onToggleTheme: () => void;
  onAuthenticated: (token: string, user: UserProfile) => void;
}

export function AuthView({
  serverUrl,
  onChangeServerUrl,
  serverInfo,
  serverInfoError,
  notice,
  theme,
  onToggleTheme,
  onAuthenticated,
}: AuthViewProps) {
  const { t, toggleLocale } = useI18n();
  const [tab, setTab] = useState<"login" | "register">(
    serverInfo?.needsBootstrap ? "register" : "login",
  );
  const [serverDraft, setServerDraft] = useState(serverUrl);
  const [serverUrlInvalid, setServerUrlInvalid] = useState(false);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setServerDraft(serverUrl);
    setServerUrlInvalid(false);
  }, [serverUrl]);

  useEffect(() => {
    if (serverInfo?.needsBootstrap) {
      setTab("register");
    }
  }, [serverInfo?.needsBootstrap]);

  const handleConnectServer = () => {
    const checked = validateServerBaseUrl(serverDraft);
    if (!checked.ok) {
      setServerUrlInvalid(true);
      return;
    }
    setServerUrlInvalid(false);
    setError(null);
    onChangeServerUrl(checked.url);
  };

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);

    const checkedServer = validateServerBaseUrl(serverDraft);
    if (!checkedServer.ok) {
      setServerUrlInvalid(true);
      return;
    }
    setServerUrlInvalid(false);
    if (checkedServer.url !== serverUrl) {
      saveStoredServerUrl(checkedServer.url || null);
    }

    const trimmedUser = username.trim().toLowerCase();
    if (tab === "register") {
      if (!HANDLE_PATTERN.test(trimmedUser)) {
        setError(t("auth.usernameInvalid"));
        return;
      }
      if (password.length < 8) {
        setError(t("auth.passwordInvalid"));
        return;
      }
    }

    setSubmitting(true);
    try {
      if (tab === "login") {
        const res = await serverApi.login({
          username: trimmedUser,
          password,
        });
        onAuthenticated(res.token, res.user);
      } else {
        const res = await serverApi.register({
          username: trimmedUser,
          password,
          displayName: displayName.trim() || undefined,
          inviteCode: inviteCode.trim(),
        });
        onAuthenticated(res.token, res.user);
      }
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError(t("error.generic"));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const activeServerLabel = serverUrl || t("auth.serverUrlSameOrigin");

  return (
    <main className="auth-shell">
      <div className="auth-card">
        <div className="auth-top-bar">
          <div className="brand-lockup">
            <span className="brand-mark" aria-hidden="true">
              AS
            </span>
            <div>
              <h1 className="brand-title">{t("app.name")}</h1>
              <p className="brand-subtitle">{t("app.tagline")}</p>
            </div>
          </div>

          <div className="auth-controls">
            <button
              type="button"
              className="ghost-btn"
              onClick={onToggleTheme}
              aria-label={theme === "dark" ? t("theme.toLight") : t("theme.toDark")}
            >
              {theme === "dark" ? t("theme.light") : t("theme.dark")}
            </button>
            <button
              type="button"
              className="ghost-btn"
              onClick={toggleLocale}
              aria-label={t("lang.toggle")}
            >
              {t("lang.short")}
            </button>
          </div>
        </div>

        <form
          className="server-url-box"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            handleConnectServer();
          }}
        >
          <div className="field">
            <label htmlFor="auth-server-url">{t("auth.serverUrl")}</label>
            <span id="auth-server-url-hint" className="field-hint">
              {t("auth.serverUrlHint")}
            </span>
            <div className="server-url-row">
              <input
                id="auth-server-url"
                name="serverUrl"
                type="url"
                spellCheck={false}
                autoCorrect="off"
                autoCapitalize="none"
                enterKeyHint="go"
                aria-invalid={serverUrlInvalid}
                aria-describedby="auth-server-url-hint"
                placeholder={t("auth.serverUrlPlaceholder")}
                value={serverDraft}
                onChange={(e) => {
                  setServerDraft(e.target.value);
                  if (serverUrlInvalid) setServerUrlInvalid(false);
                }}
              />
              <button
                type="submit"
                className="ghost-btn server-url-connect"
                disabled={submitting}
              >
                {t("auth.serverUrlConnect")}
              </button>
            </div>
            {serverUrlInvalid ? (
              <span className="field-error" role="alert">
                {t("auth.serverUrlInvalid")}
              </span>
            ) : null}
          </div>
        </form>

        {notice ? (
          <div className="banner banner-warn" role="status">
            {notice}
          </div>
        ) : null}

        {serverInfo?.needsBootstrap ? (
          <div className="banner banner-info" role="status">
            <strong>{t("auth.bootstrapTitle")}</strong>
            <p>{t("auth.bootstrapHint")}</p>
          </div>
        ) : null}

        {serverInfoError ? (
          <div className="banner banner-error" role="alert">
            {t("auth.serverOffline")}
          </div>
        ) : null}

        <div className="segmented-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "login"}
            className={tab === "login" ? "tab-btn tab-btn-active" : "tab-btn"}
            onClick={() => {
              setTab("login");
              setError(null);
            }}
          >
            {t("auth.signInTab")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "register"}
            className={tab === "register" ? "tab-btn tab-btn-active" : "tab-btn"}
            onClick={() => {
              setTab("register");
              setError(null);
            }}
          >
            {t("auth.registerTab")}
          </button>
        </div>

        <h2 className="auth-heading">
          {tab === "login" ? t("auth.signInHeading") : t("auth.registerHeading")}
        </h2>

        <form className="stack-form" onSubmit={handleSubmit}>
          <div className="field">
            <label htmlFor="auth-username">{t("auth.username")}</label>
            {tab === "register" ? (
              <span id="auth-username-hint" className="field-hint">
                {t("auth.usernameHint")}
              </span>
            ) : null}
            <input
              id="auth-username"
              name="username"
              type="text"
              required
              pattern={tab === "register" ? "^[a-z0-9][a-z0-9_-]{1,31}$" : undefined}
              autoComplete="username"
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="none"
              enterKeyHint="next"
              aria-describedby={tab === "register" ? "auth-username-hint" : undefined}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>

          {tab === "register" ? (
            <div className="field">
              <label htmlFor="auth-display-name">{t("auth.displayName")}</label>
              <input
                id="auth-display-name"
                name="displayName"
                type="text"
                autoComplete="name"
                enterKeyHint="next"
                placeholder={t("auth.displayNamePlaceholder")}
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </div>
          ) : null}

          <div className="field">
            <label htmlFor="auth-password">{t("auth.password")}</label>
            {tab === "register" ? (
              <span id="auth-password-hint" className="field-hint">
                {t("auth.passwordHint")}
              </span>
            ) : null}
            <div className="password-input-row">
              <input
                id="auth-password"
                name="password"
                type={showPassword ? "text" : "password"}
                required
                minLength={tab === "register" ? 8 : undefined}
                autoComplete={tab === "login" ? "current-password" : "new-password"}
                enterKeyHint={tab === "login" ? "done" : "next"}
                aria-describedby={tab === "register" ? "auth-password-hint" : undefined}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <button
                type="button"
                className="ghost-btn password-toggle"
                onClick={() => setShowPassword((prev) => !prev)}
                aria-pressed={showPassword}
              >
                {showPassword ? t("auth.hidePassword") : t("auth.showPassword")}
              </button>
            </div>
          </div>

          {tab === "register" ? (
            <div className="field">
              <label htmlFor="auth-invite-code">{t("auth.inviteCode")}</label>
              <span id="auth-invite-hint" className="field-hint">
                {t("auth.inviteCodeHint")}
              </span>
              <input
                id="auth-invite-code"
                name="inviteCode"
                type="text"
                required
                autoComplete="one-time-code"
                spellCheck={false}
                autoCorrect="off"
                autoCapitalize="none"
                enterKeyHint="done"
                aria-describedby="auth-invite-hint"
                placeholder={t("auth.inviteCodePlaceholder")}
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value)}
              />
            </div>
          ) : null}

          {error ? (
            <div className="banner banner-error" role="alert">
              {error}
            </div>
          ) : null}

          <button type="submit" className="primary-btn full-width" disabled={submitting}>
            {tab === "login"
              ? submitting
                ? t("auth.signingIn")
                : t("auth.signInButton")
              : submitting
                ? t("auth.registering")
                : t("auth.registerButton")}
          </button>
        </form>

        <footer className="auth-footer">
          <div className="auth-footer-target">
            <span className="auth-footer-url truncate" title={activeServerLabel}>
              {activeServerLabel}
            </span>
            {serverInfo ? (
              <span className="auth-footer-version">
                {t("auth.serverVersion", { version: serverInfo.version })}
              </span>
            ) : null}
          </div>
          {serverInfo ? (
            <span
              className={
                serverInfo.relayEnabled
                  ? "status-pill status-pill-warn"
                  : "status-pill status-pill-ok"
              }
            >
              {serverInfo.relayEnabled ? t("sidebar.relayOn") : t("sidebar.relayOff")}
            </span>
          ) : null}
        </footer>
      </div>
    </main>
  );
}
