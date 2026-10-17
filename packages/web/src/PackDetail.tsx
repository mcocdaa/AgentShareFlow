import React, { useEffect, useState } from "react";
import {
  type PackDetail,
  type SessionInfo,
  fetchPackReadme,
  getPack,
  getStoredToken,
  toggleStar,
} from "./api.js";
import { InstallCommand, ModeBadge } from "./components.js";
import { DependencyTopology } from "./DependencyTopology.js";
import { useI18n } from "./i18n.js";
import { MarkdownView } from "./MarkdownView.js";
import { PlaygroundView } from "./PlaygroundView.js";

export function PackDetailPage({
  owner,
  name,
  session,
  onRequireAuth,
}: {
  owner: string;
  name: string;
  session?: SessionInfo | null;
  onRequireAuth?: () => void;
}) {
  const { t, td } = useI18n();
  const [detail, setDetail] = useState<PackDetail | null>(null);
  const [readme, setReadme] = useState<string | null>(null);
  const [loadingReadme, setLoadingReadme] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [starring, setStarring] = useState(false);
  const [activeSubTab, setActiveSubTab] = useState<"skill" | "topology" | "playground" | "metadata">("skill");

  useEffect(() => {
    setDetail(null);
    setReadme(null);
    setError(null);
    getPack(owner, name)
      .then((pack) => {
        setDetail(pack);
        if (pack.readme) {
          setReadme(pack.readme);
        } else {
          setLoadingReadme(true);
          fetchPackReadme(owner, name, pack.version)
            .then((r) => setReadme(r))
            .catch(() => setReadme(null))
            .finally(() => setLoadingReadme(false));
        }
      })
      .catch((err: Error) => setError(err.message));
  }, [owner, name, session?.owner]);

  const onToggleStar = async () => {
    if (!detail || starring) return;
    if (!session?.owner && !getStoredToken()) {
      if (onRequireAuth) {
        onRequireAuth();
      }
      return;
    }
    setStarring(true);
    try {
      const res = await toggleStar(owner, name, detail.starred === true);
      setDetail({
        ...detail,
        starred: res.starred,
        stars: res.stars,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/unauthorized|401/i.test(msg) && onRequireAuth) {
        onRequireAuth();
      } else {
        alert(`${t("starFailedPrefix")} ${td(msg)}`);
      }
    } finally {
      setStarring(false);
    }
  };

  if (error) return <div className="error-card"><p className="error">{td(error)}</p><a className="back" href="#/">{t("backToCatalogLower")}</a></div>;
  if (!detail) return <div className="loading-container"><div className="spinner" /><p className="muted">{t("loadingPackSpec")}</p></div>;

  return (
    <div className="detail-container">
      <div className="detail-top-bar">
        <a className="back-link" href="#/">
          {t("backToCatalog")}
        </a>
        <div className="detail-top-actions">
          <button
            type="button"
            className={`star-btn ${detail.starred ? "active" : ""}`}
            onClick={onToggleStar}
            disabled={starring}
          >
            <span className="star-icon">★</span>
            <span className="star-text">{detail.starred ? t("starred") : t("star")}</span>
            <span className="star-count">{detail.stars}</span>
          </button>
          <a
            className="download-btn"
            href={detail.downloadUrl}
            download={`${detail.name}-${detail.version}.tgz`}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            <span>{t("downloadTgz")}</span>
          </a>
        </div>
      </div>

      <div className="pack-header-card">
        <div className="pack-meta-lead">
          <span className="pack-ref-badge">
            {detail.owner}/{detail.name}
          </span>
          <span className="pack-ver-badge">v{detail.version}</span>
          <ModeBadge mode={detail.mode} />
          {detail.manifest.license && (
            <span className="license-badge">{detail.manifest.license}</span>
          )}
        </div>
        <h1 className="pack-title">{td(detail.title)}</h1>
        <p className="pack-description">{td(detail.description)}</p>

        {detail.tags && detail.tags.length > 0 && (
          <div className="pack-tags-row">
            {detail.tags.map((tag) => (
              <span key={tag} className="tag-pill">#{td(tag)}</span>
            ))}
          </div>
        )}
      </div>

      {/* Harness Smart Switch Install Box */}
      <InstallCommand
        owner={detail.owner}
        name={detail.name}
        version={detail.version}
        supportedHarnesses={detail.manifest.compatibility}
      />

      {/* Detail Navigation Tabs */}
      <div className="pack-subtabs">
        <button
          type="button"
          className={`subtab-btn ${activeSubTab === "skill" ? "active" : ""}`}
          onClick={() => setActiveSubTab("skill")}
        >
          <span>{t("tabSkillDoc")}</span>
          {readme && <span className="subtab-count">{t("tabSkillReady")}</span>}
        </button>
        <button
          type="button"
          className={`subtab-btn ${activeSubTab === "topology" ? "active" : ""}`}
          onClick={() => setActiveSubTab("topology")}
        >
          <span>{t("tabTopology")}</span>
          <span className="subtab-count">{t("tabTopologyVisual")}</span>
        </button>
        <button
          type="button"
          className={`subtab-btn ${activeSubTab === "playground" ? "active" : ""}`}
          onClick={() => setActiveSubTab("playground")}
        >
          <span>{t("tabPlayground")}</span>
          <span className="subtab-count">{t("tabPlaygroundBadge")}</span>
        </button>
        <button
          type="button"
          className={`subtab-btn ${activeSubTab === "metadata" ? "active" : ""}`}
          onClick={() => setActiveSubTab("metadata")}
        >
          <span>{t("tabManifestSecurity")}</span>
        </button>
      </div>

      {/* Tab 1: In-Place SKILL.md Rich Text Render */}
      {activeSubTab === "skill" && (
        <div className="skill-section">
          <div className="skill-card">
            <div className="skill-card-header">
              <div className="skill-card-title">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                <span>{t("skillCardTitle")}</span>
              </div>
              <span className="skill-render-badge">{t("skillRenderBadge")}</span>
            </div>
            <div className="skill-card-content">
              {loadingReadme ? (
                <div className="loading-box">
                  <div className="spinner small" />
                  <span>{t("parsingSkillMd")}</span>
                </div>
              ) : readme ? (
                <MarkdownView content={td(readme)} />
              ) : (
                <div className="empty-readme">
                  <p>{t("emptySkillMdTitle")}</p>
                  <p className="muted small">{t("emptySkillMdSub")}</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Tab 2: Dependency Topology Visualizer */}
      {activeSubTab === "topology" && (
        <DependencyTopology detail={detail} />
      )}

      {/* Tab 3: Live Interactive Playground */}
      {activeSubTab === "playground" && (
        <PlaygroundView detail={detail} session={session} onRequireAuth={onRequireAuth} />
      )}

      {/* Tab 4: Manifest & Security Details */}
      {activeSubTab === "metadata" && (
        <div className="metadata-grid">
          <div className="meta-card">
            <h3>{t("distAttributesTitle")}</h3>
            <dl className="meta-dl">
              <dt>{t("metaDownloads")}</dt>
              <dd>{detail.downloads.toLocaleString()}</dd>
              <dt>{t("metaStars")}</dt>
              <dd>{detail.stars}</dd>
              <dt>{t("metaAvailableVersions")}</dt>
              <dd className="versions-list">
                {detail.versions.map((ver) => (
                  <span key={ver} className={`ver-chip ${ver === detail.version ? "current" : ""}`}>
                    v{ver}
                  </span>
                ))}
              </dd>
              <dt>{t("metaPackageSize")}</dt>
              <dd>{(detail.size / 1024).toFixed(1)} KiB ({detail.size} {t("inspectorBytes")})</dd>
              <dt>{t("metaSha256Digest")}</dt>
              <dd className="digest-val">
                <code>{detail.digest}</code>
              </dd>
            </dl>
          </div>

          <div className="meta-card">
            <h3>{t("securityVerificationTitle")}</h3>
            <dl className="meta-dl">
              <dt>{t("metaCompatibleHarnesses")}</dt>
              <dd className="versions-list">
                {(detail.manifest.compatibility && detail.manifest.compatibility.length > 0
                  ? detail.manifest.compatibility
                  : ["agents"]
                ).map((h) => (
                  <span key={h} className="ver-chip">
                    {h}
                  </span>
                ))}
              </dd>
              <dt>{t("metaMode")}</dt>
              <dd><ModeBadge mode={detail.mode} /></dd>
              {detail.manifest.endpoint && (
                <>
                  <dt>{t("metaA2aEndpoint")}</dt>
                  <dd>{detail.manifest.endpoint.type} ({detail.manifest.endpoint.url})</dd>
                </>
              )}
              {detail.manifest.mcp && (
                <>
                  <dt>{t("metaMcpConfig")}</dt>
                  <dd><code>{detail.manifest.mcp.config}</code></dd>
                </>
              )}
              {(detail.manifest.secrets ?? []).length > 0 && (
                <>
                  <dt>{t("metaRequiredSecrets")}</dt>
                  <dd>
                    {detail.manifest.secrets?.map((sec) => (
                      <span key={sec} className="secret-chip">{sec}</span>
                    ))}
                  </dd>
                </>
              )}
              <dt>{t("metaSignature")}</dt>
              <dd>
                {detail.signature ? (
                  <span className="signature-badge verified">{t("signatureVerified")}</span>
                ) : (
                  <span className="signature-badge unsigned">{t("signatureUnsigned")}</span>
                )}
              </dd>
            </dl>
          </div>
        </div>
      )}
    </div>
  );
}
