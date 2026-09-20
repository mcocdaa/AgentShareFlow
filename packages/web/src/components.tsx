import React, { useState } from "react";
import type { PackSummary } from "./api.js";

export function ModeBadge({ mode }: { mode: string }) {
  return <span className={`badge mode-${mode}`}>{mode}</span>;
}

export interface InstallCommandProps {
  owner: string;
  name: string;
  version?: string;
  supportedHarnesses?: string[];
}

interface HarnessOption {
  id: string;
  label: string;
  targetArg: string;
  icon: string;
}

const HARNESS_OPTIONS: HarnessOption[] = [
  { id: "agents", label: "通用 (Agents)", targetArg: "agents", icon: "🌐" },
  { id: "claude", label: "Claude Code", targetArg: "claude", icon: "⚡" },
  { id: "codex", label: "Codex", targetArg: "codex", icon: "🤖" },
  { id: "opencode", label: "OpenCode", targetArg: "opencode", icon: "💻" },
  { id: "openclaw", label: "OpenClaw", targetArg: "openclaw", icon: "🐾" },
  { id: "hermes", label: "Hermes", targetArg: "hermes", icon: "🚀" },
];

export function InstallCommand({
  owner,
  name,
  version,
  supportedHarnesses,
}: InstallCommandProps) {
  const [selectedHarness, setSelectedHarness] = useState<string>("agents");
  const [inProject, setInProject] = useState(false);
  const [copied, setCopied] = useState(false);
  const [ripple, setRipple] = useState(false);

  const activeOption =
    HARNESS_OPTIONS.find((h) => h.id === selectedHarness) ?? HARNESS_OPTIONS[0]!;

  const ref = version ? `${owner}/${name}@${version}` : `${owner}/${name}`;
  const targetFlag = `--target ${activeOption.targetArg}`;
  const projectFlag = inProject ? " --project" : "";
  const command = `npx @agentshare/cli install ${ref} ${targetFlag}${projectFlag}`;

  const copy = () => {
    void navigator.clipboard.writeText(command);
    setCopied(true);
    setRipple(true);
    setTimeout(() => setRipple(false), 500);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="install-box">
      <div className="install-tabs-header">
        <div className="install-tabs">
          {HARNESS_OPTIONS.map((opt) => {
            const isSupported =
              !supportedHarnesses ||
              supportedHarnesses.length === 0 ||
              supportedHarnesses.includes(opt.id) ||
              supportedHarnesses.includes("all") ||
              opt.id === "agents";

            return (
              <button
                key={opt.id}
                type="button"
                className={`install-tab ${selectedHarness === opt.id ? "active" : ""} ${
                  !isSupported ? "untested" : ""
                }`}
                onClick={() => setSelectedHarness(opt.id)}
              >
                <span className="tab-icon">{opt.icon}</span>
                <span className="tab-label">{opt.label}</span>
                {!isSupported && <span className="tab-pill">unverified</span>}
              </button>
            );
          })}
        </div>

        <label className="project-checkbox" title="Install into current project .agents/ instead of global">
          <input
            type="checkbox"
            checked={inProject}
            onChange={(e) => setInProject(e.target.checked)}
          />
          <span>Project local (--project)</span>
        </label>
      </div>

      <div className={`install-code-bar ${ripple ? "ripple" : ""}`}>
        <span className="prompt-glyph">$</span>
        <code className="install-code">{command}</code>
        <button
          type="button"
          className={`install-copy-btn ${copied ? "copied" : ""}`}
          onClick={copy}
        >
          {copied ? (
            <>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
              <span>Copied!</span>
            </>
          ) : (
            <>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
              <span>Copy</span>
            </>
          )}
        </button>
      </div>
    </div>
  );
}

export function PackCard({ pack }: { pack: PackSummary }) {
  return (
    <a className="card" href={`#/agents/${pack.owner}/${pack.name}`}>
      <div className="card-head">
        <span className="ref">
          {pack.owner}/{pack.name}
        </span>
        <ModeBadge mode={pack.mode} />
      </div>
      <h3>{pack.title}</h3>
      <p>{pack.description}</p>
      <div className="card-tags">
        {(pack.tags ?? []).slice(0, 4).map((tag) => (
          <span key={tag} className="tag-pill">
            #{tag}
          </span>
        ))}
      </div>
      <div className="card-foot">
        <span className="version-tag">v{pack.version}</span>
        <span className="stats-tag">
          ★ {pack.stars} · {pack.downloads} downloads
        </span>
      </div>
    </a>
  );
}
