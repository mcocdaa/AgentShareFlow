import React, { useState } from "react";
import type { PackDetail } from "./api.js";

interface TopologyProps {
  detail: PackDetail;
}

export function DependencyTopology({ detail }: TopologyProps) {
  const [activeNode, setActiveNode] = useState<string | null>(null);

  const harnesses = detail.manifest.compatibility && detail.manifest.compatibility.length > 0
    ? detail.manifest.compatibility
    : ["agents"];
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
          <h4>Dependency & Environment Topology</h4>
        </div>
        <span className="topology-hint">Click nodes to inspect runtime bindings</span>
      </div>

      <div className="topology-canvas">
        {/* Level 0: Pack Center */}
        <div className="topo-col root-col">
          <div className="topo-label">AGENT PACK</div>
          <div
            className={`topo-node root-node ${activeNode === "root" ? "active" : ""}`}
            onClick={() => setActiveNode(activeNode === "root" ? null : "root")}
          >
            <div className="node-icon">📦</div>
            <div className="node-body">
              <div className="node-title">{detail.name}</div>
              <div className="node-sub">v{detail.version} · {detail.mode}</div>
            </div>
            <span className="node-badge">{detail.owner}</span>
          </div>
        </div>

        {/* Level 1: Tree Branches */}
        <div className="topo-col branches-col">
          {/* Branch 1: Harness Compatibility */}
          <div className="topo-branch">
            <div className="topo-label">SUPPORTED HARNESSES ({harnesses.length})</div>
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
            <div className="topo-label">PROMPT SKILLS & INSTRUCTIONS ({skills.length})</div>
            <div className="topo-nodes-row">
              {skills.map((skill, idx) => (
                <div
                  key={idx}
                  className={`topo-node skill-node ${activeNode === `s-${idx}` ? "active" : ""}`}
                  onClick={() => setActiveNode(activeNode === `s-${idx}` ? null : `s-${idx}`)}
                >
                  <span className="skill-glyph">✦</span>
                  <span className="node-title">{skill === "." ? "SKILL.md (Root)" : skill}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Branch 3: MCP Tools (if present) */}
          <div className="topo-branch">
            <div className="topo-label">TOOL INTEGRATION</div>
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
                  <span className="node-sub">No external tools required (Pure prompt skill)</span>
                </div>
              )}
            </div>
          </div>

          {/* Branch 4: Declarative Secrets */}
          <div className="topo-branch">
            <div className="topo-label">DECLARATIVE SECRETS ({secrets.length})</div>
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
                  <span className="node-sub">Zero credentials required (Zero-trust safe)</span>
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
              <strong>Root Pack Manifest</strong>
              <p>Digest: <code>{detail.digest}</code></p>
              <p>Size: {detail.size} bytes | Created: {new Date(detail.createdAt).toLocaleDateString()}</p>
            </div>
          )}
          {activeNode.startsWith("h-") && (
            <div className="inspector-content">
              <strong>Harness Compatibility: {activeNode.slice(2)}</strong>
              <p>This skill pack is verified to execute within the {activeNode.slice(2)} coding agent runtime.</p>
            </div>
          )}
          {activeNode.startsWith("s-") && (
            <div className="inspector-content">
              <strong>Skill Definition</strong>
              <p>Standardized prompt instructions packaged according to agent-pack/v0.</p>
            </div>
          )}
          {activeNode === "mcp" && (
            <div className="inspector-content">
              <strong>Model Context Protocol (MCP) Server</strong>
              <p>Configured in <code>{mcpConfig}</code>. Tools are sandboxed with read-only guards.</p>
            </div>
          )}
          {activeNode.startsWith("sec-") && (
            <div className="inspector-content">
              <strong>Declared Environment Secret: {activeNode.slice(4)}</strong>
              <p>Host agent will prompt for this environment variable upon installation or inherit safely.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
