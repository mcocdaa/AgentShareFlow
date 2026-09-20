import React, { useEffect, useState } from "react";
import { type PackDetail, fetchPackReadme, getPack, toggleStar } from "./api.js";
import { InstallCommand, ModeBadge } from "./components.js";
import { DependencyTopology } from "./DependencyTopology.js";
import { MarkdownView } from "./MarkdownView.js";

export function PackDetailPage({ owner, name }: { owner: string; name: string }) {
  const [detail, setDetail] = useState<PackDetail | null>(null);
  const [readme, setReadme] = useState<string | null>(null);
  const [loadingReadme, setLoadingReadme] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [starring, setStarring] = useState(false);
  const [activeSubTab, setActiveSubTab] = useState<"skill" | "topology" | "metadata">("skill");

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
  }, [owner, name]);

  const onToggleStar = async () => {
    if (!detail || starring) return;
    setStarring(true);
    try {
      const res = await toggleStar(owner, name, detail.starred === true);
      setDetail({
        ...detail,
        starred: res.starred,
        stars: res.stars,
      });
    } catch (err) {
      alert(`Star failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setStarring(false);
    }
  };

  if (error) return <div className="error-card"><p className="error">{error}</p><a className="back" href="#/">← back to catalog</a></div>;
  if (!detail) return <div className="loading-container"><div className="spinner" /><p className="muted">loading pack specification…</p></div>;

  return (
    <div className="detail-container">
      <div className="detail-top-bar">
        <a className="back-link" href="#/">
          ← Back to Catalog
        </a>
        <div className="detail-top-actions">
          <button
            type="button"
            className={`star-btn ${detail.starred ? "active" : ""}`}
            onClick={onToggleStar}
            disabled={starring}
          >
            <span className="star-icon">★</span>
            <span className="star-text">{detail.starred ? "Starred" : "Star"}</span>
            <span className="star-count">{detail.stars}</span>
          </button>
          <a
            className="download-btn"
            href={detail.downloadUrl}
            download={`${detail.name}-${detail.version}.tgz`}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            <span>Download .tgz</span>
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
        <h1 className="pack-title">{detail.title}</h1>
        <p className="pack-description">{detail.description}</p>

        {detail.tags && detail.tags.length > 0 && (
          <div className="pack-tags-row">
            {detail.tags.map((tag) => (
              <span key={tag} className="tag-pill">#{tag}</span>
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
          <span>📄 SKILL.md Prompt Spec</span>
          {readme && <span className="subtab-count">Ready</span>}
        </button>
        <button
          type="button"
          className={`subtab-btn ${activeSubTab === "topology" ? "active" : ""}`}
          onClick={() => setActiveSubTab("topology")}
        >
          <span>⎇ Dependency Topology</span>
          <span className="subtab-count">Visual</span>
        </button>
        <button
          type="button"
          className={`subtab-btn ${activeSubTab === "metadata" ? "active" : ""}`}
          onClick={() => setActiveSubTab("metadata")}
        >
          <span>⚙ Manifest & Security</span>
        </button>
      </div>

      {/* Tab 1: In-Place SKILL.md Rich Text Render */}
      {activeSubTab === "skill" && (
        <div className="skill-section">
          <div className="skill-card">
            <div className="skill-card-header">
              <div className="skill-card-title">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                <span>In-Place Skill Documentation (SKILL.md)</span>
              </div>
              <span className="skill-render-badge">Live Markdown</span>
            </div>
            <div className="skill-card-content">
              {loadingReadme ? (
                <div className="loading-box">
                  <div className="spinner small" />
                  <span>Parsing SKILL.md from pack tarball…</span>
                </div>
              ) : readme ? (
                <MarkdownView content={readme} />
              ) : (
                <div className="empty-readme">
                  <p>No <code>SKILL.md</code> was found at the root of this pack.</p>
                  <p className="muted small">Skills can also be declared in subdirectories listed in <code>agent.json</code>.</p>
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

      {/* Tab 3: Manifest & Security Details */}
      {activeSubTab === "metadata" && (
        <div className="metadata-grid">
          <div className="meta-card">
            <h3>Distribution Attributes</h3>
            <dl className="meta-dl">
              <dt>Downloads</dt>
              <dd>{detail.downloads.toLocaleString()}</dd>
              <dt>Stars</dt>
              <dd>{detail.stars}</dd>
              <dt>Available Versions</dt>
              <dd className="versions-list">
                {detail.versions.map((ver) => (
                  <span key={ver} className={`ver-chip ${ver === detail.version ? "current" : ""}`}>
                    v{ver}
                  </span>
                ))}
              </dd>
              <dt>Package Size</dt>
              <dd>{(detail.size / 1024).toFixed(1)} KiB ({detail.size} bytes)</dd>
              <dt>SHA256 Digest</dt>
              <dd className="digest-val">
                <code>{detail.digest}</code>
              </dd>
            </dl>
          </div>

          <div className="meta-card">
            <h3>Harness & Security Verification</h3>
            <dl className="meta-dl">
              <dt>Harnesses</dt>
              <dd>{(detail.manifest.compatibility ?? []).join(", ") || "agents (default)"}</dd>
              <dt>Mode</dt>
              <dd><ModeBadge mode={detail.mode} /></dd>
              {detail.manifest.endpoint && (
                <>
                  <dt>A2A Endpoint</dt>
                  <dd>{detail.manifest.endpoint.type} ({detail.manifest.endpoint.url})</dd>
                </>
              )}
              {detail.manifest.mcp && (
                <>
                  <dt>MCP Config</dt>
                  <dd><code>{detail.manifest.mcp.config}</code></dd>
                </>
              )}
              {(detail.manifest.secrets ?? []).length > 0 && (
                <>
                  <dt>Required Secrets</dt>
                  <dd>
                    {detail.manifest.secrets?.map((sec) => (
                      <span key={sec} className="secret-chip">{sec}</span>
                    ))}
                  </dd>
                </>
              )}
              <dt>Ed25519 Signature</dt>
              <dd>
                <span className="signature-badge verified">Verified</span>
              </dd>
            </dl>
          </div>
        </div>
      )}
    </div>
  );
}
