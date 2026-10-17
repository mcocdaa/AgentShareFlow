import React, { useState } from "react";
import type { PackDetail } from "./api.js";
import { useI18n } from "./i18n.js";

interface TopologyProps {
  detail: PackDetail;
}

export function DependencyTopology({ detail }: TopologyProps) {
  const { t } = useI18n();
  const [activeNode, setActiveNode] = useState<string | null>(null);

  const rawCompat = detail.manifest.compatibility ?? [];
  const harnesses =
    rawCompat.length === 0 || (rawCompat.length === 1 && rawCompat[0] === "agents")
      ? ["agents", "claude", "codex", "opencode", "openclaw", "hermes"]
      : rawCompat;
  const skills = detail.manifest.skills && detail.manifest.skills.length > 0
    ? detail.manifest.skills
    : ["."];
  const mcpConfig = detail.manifest.mcp?.config;
  const secrets = detail.manifest.secrets ?? [];

  return (
    <div className="topology-card">
      <div className="topology-header">
        <div className="topology-title-row">
          <span className="topology-icon">⎇</span>
          <h4>{t("topologyTitle")}</h4>
        </div>
        <span className="topology-hint">{t("topologyHint")}</span>
      </div>

      <div className="topology-canvas">
        {/* Level 0: Pack Center */}
        <div className="topo-col root-col">
          <div className="topo-label">{t("topoAgentPack")}</div>
          <div
            className={`topo-node root-node ${activeNode === "root" ? "active" : ""}`}
            onClick={() => setActiveNode(activeNode === "root" ? null : "root")}
          >
            <div className="node-icon">📦</div>
            <div className="node-body">
              <div className="node-title">{detail.name}</div>
              <div className="node-sub">@{detail.owner} · v{detail.version} · {detail.mode}</div>
            </div>
          </div>
        </div>

        {/* Level 1: Tree Branches */}
        <div className="topo-col branches-col">
          {/* Branch 1: Harness Compatibility */}
          <div className="topo-branch">
            <div className="topo-label">{t("topoSupportedHarnesses")} ({harnesses.length})</div>
            <div className="topo-nodes-row">
              {harnesses.map((harness) => (
                <div
                  key={harness}
                  className={`topo-node harness-node ${activeNode === `h-${harness}` ? "active" : ""}`}
                  onClick={() => setActiveNode(activeNode === `h-${harness}` ? null : `h-${harness}`)}
                >
                  <span className="harness-dot" />
                  <span className="node-title">{harness}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Branch 2: Prompt Skills */}
          <div className="topo-branch">
            <div className="topo-label">{t("topoPromptSkills")} ({skills.length})</div>
            <div className="topo-nodes-row">
              {skills.map((skill, idx) => (
                <div
                  key={idx}
                  className={`topo-node skill-node ${activeNode === `s-${idx}` ? "active" : ""}`}
                  onClick={() => setActiveNode(activeNode === `s-${idx}` ? null : `s-${idx}`)}
                >
                  <span className="skill-glyph">✦</span>
                  <span className="node-title">{skill === "." ? t("topoSkillRoot") : skill}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Branch 3: MCP Tools (if present) */}
          <div className="topo-branch">
            <div className="topo-label">{t("topoToolIntegration")}</div>
            <div className="topo-nodes-row">
              {mcpConfig ? (
                <div
                  className={`topo-node mcp-node active-tool ${activeNode === "mcp" ? "active" : ""}`}
                  onClick={() => setActiveNode(activeNode === "mcp" ? null : "mcp")}
                >
                  <span className="mcp-badge">MCP</span>
                  <span className="node-title">{mcpConfig}</span>
                  <span className="status-live">JSON-RPC</span>
                </div>
              ) : detail.manifest.endpoint ? (
                <div
                  className={`topo-node mcp-node ${activeNode === "endpoint" ? "active" : ""}`}
                  onClick={() => setActiveNode(activeNode === "endpoint" ? null : "endpoint")}
                >
                  <span className="mcp-badge">A2A</span>
                  <span className="node-title">{detail.manifest.endpoint.type}</span>
                </div>
              ) : (
                <div className="topo-node empty-node">
                  <span className="node-sub">{t("topoNoExternalTools")}</span>
                </div>
              )}
            </div>
          </div>

          {/* Branch 4: Declarative Secrets */}
          <div className="topo-branch">
            <div className="topo-label">{t("topoDeclarativeSecrets")} ({secrets.length})</div>
            <div className="topo-nodes-row">
              {secrets.length > 0 ? (
                secrets.map((secret) => (
                  <div
                    key={secret}
                    className={`topo-node secret-node ${activeNode === `sec-${secret}` ? "active" : ""}`}
                    onClick={() => setActiveNode(activeNode === `sec-${secret}` ? null : `sec-${secret}`)}
                  >
                    <span className="lock-icon">🔒</span>
                    <span className="node-title">{secret}</span>
                  </div>
                ))
              ) : (
                <div className="topo-node clean-node">
                  <span className="check-glyph">✓</span>
                  <span className="node-sub">{t("topoZeroCredentials")}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {activeNode && (
        <div className="topology-inspector">
          {activeNode === "root" && (
            <div className="inspector-content">
              <strong>{t("inspectorRootTitle")}</strong>
              <p>{t("inspectorDigest")}: <code>{detail.digest}</code></p>
              <p>{t("inspectorSize")}: {detail.size} {t("inspectorBytes")} | {t("inspectorCreated")}: {new Date(detail.createdAt).toLocaleDateString()}</p>
            </div>
          )}
          {activeNode.startsWith("h-") && (
            <div className="inspector-content">
              <strong>{t("inspectorHarnessTitle")}: {activeNode.slice(2)}</strong>
              <p>{t("inspectorHarnessDescPrefix")} {activeNode.slice(2)} {t("inspectorHarnessDescSuffix")}</p>
            </div>
          )}
          {activeNode.startsWith("s-") && (
            <div className="inspector-content">
              <strong>{t("inspectorSkillTitle")}</strong>
              <p>{t("inspectorSkillDesc")}</p>
            </div>
          )}
          {activeNode === "mcp" && (
            <div className="inspector-content">
              <strong>{t("inspectorMcpTitle")}</strong>
              <p>{t("inspectorMcpDescPrefix")} <code>{mcpConfig}</code>. {t("inspectorMcpDescSuffix")}</p>
            </div>
          )}
          {activeNode === "endpoint" && detail.manifest.endpoint && (
            <div className="inspector-content">
              <strong>{t("inspectorEndpointTitle")}: {detail.manifest.endpoint.type}</strong>
              <p>{t("inspectorEndpointDescPrefix")} <code>{detail.manifest.endpoint.url}</code></p>
            </div>
          )}
          {activeNode.startsWith("sec-") && (
            <div className="inspector-content">
              <strong>{t("inspectorSecretTitle")}: {activeNode.slice(4)}</strong>
              <p>{t("inspectorSecretDesc")}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
