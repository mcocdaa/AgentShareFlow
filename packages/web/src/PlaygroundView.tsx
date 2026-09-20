import React, { useState } from "react";
import { type PackDetail, type PlaygroundResult, runPackPlayground } from "./api.js";

export function PlaygroundView({ detail }: { detail: PackDetail }) {
  const defaultPrompt =
    detail.mode === "runtime"
      ? JSON.stringify({ action: "execute", query: "Hello from AgentShare Playground" }, null, 2)
      : `Please execute the ${detail.title} skill for a project security audit.`;

  const [inputVal, setInputVal] = useState(defaultPrompt);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<PlaygroundResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showLogs, setShowLogs] = useState(true);

  const handleRun = async () => {
    setRunning(true);
    setError(null);
    try {
      let parsedInput: unknown = inputVal;
      try {
        parsedInput = JSON.parse(inputVal);
      } catch {
        // Use as raw string
      }
      const res = await runPackPlayground(detail.owner, detail.name, detail.version, parsedInput);
      setResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  const loadPreset = (type: "audit" | "json" | "ping") => {
    if (type === "audit") {
      setInputVal(`Review the following authentication logic for timing attacks and token leaks.`);
    } else if (type === "json") {
      setInputVal(JSON.stringify({ operation: "analyze", target: "auth_service.py", verbose: true }, null, 2));
    } else {
      setInputVal(JSON.stringify({ method: "ping", params: { timestamp: Date.now() } }, null, 2));
    }
  };

  return (
    <div className="playground-container" style={{ marginTop: "1.5rem" }}>
      <div className="playground-card" style={{
        backgroundColor: "var(--color-bg-subtle, #121620)",
        border: "1px solid var(--color-border, #2a324b)",
        borderRadius: "10px",
        padding: "1.5rem",
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem", flexWrap: "wrap", gap: "0.5rem" }}>
          <div>
            <h3 style={{ margin: 0, fontSize: "1.1rem", display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <span>⚡ Live Sandbox Playground</span>
              <span style={{
                fontSize: "0.75rem",
                padding: "2px 8px",
                borderRadius: "12px",
                backgroundColor: "rgba(56, 189, 248, 0.15)",
                color: "#38bdf8",
                border: "1px solid rgba(56, 189, 248, 0.3)",
              }}>
                🛡️ Isolated Node/Wasm Subprocess
              </span>
            </h3>
            <p style={{ margin: "4px 0 0 0", color: "#8892b0", fontSize: "0.85rem" }}>
              Test this pack directly in an ephemeral sandbox without local installation.
            </p>
          </div>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button
              type="button"
              onClick={() => loadPreset("audit")}
              style={{
                background: "transparent",
                border: "1px solid #3b4261",
                color: "#a9b1d6",
                padding: "4px 10px",
                borderRadius: "6px",
                fontSize: "0.8rem",
                cursor: "pointer",
              }}
            >
              Prompt Preset
            </button>
            <button
              type="button"
              onClick={() => loadPreset("json")}
              style={{
                background: "transparent",
                border: "1px solid #3b4261",
                color: "#a9b1d6",
                padding: "4px 10px",
                borderRadius: "6px",
                fontSize: "0.8rem",
                cursor: "pointer",
              }}
            >
              JSON Tool Call
            </button>
          </div>
        </div>

        <div style={{ marginBottom: "1rem" }}>
          <label style={{ display: "block", fontSize: "0.85rem", color: "#8892b0", marginBottom: "0.5rem" }}>
            Input Payload (Text prompt or JSON):
          </label>
          <textarea
            value={inputVal}
            onChange={(e) => setInputVal(e.target.value)}
            rows={5}
            style={{
              width: "100%",
              boxSizing: "border-box",
              fontFamily: "monospace",
              fontSize: "0.9rem",
              backgroundColor: "#0a0d14",
              color: "#c0caf5",
              border: "1px solid #283457",
              borderRadius: "6px",
              padding: "0.75rem",
              resize: "vertical",
            }}
          />
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "1.5rem" }}>
          <button
            type="button"
            onClick={handleRun}
            disabled={running}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
              padding: "8px 20px",
              backgroundColor: running ? "#414868" : "#8A2BE2",
              color: "#fff",
              border: "none",
              borderRadius: "6px",
              fontWeight: 600,
              fontSize: "0.9rem",
              cursor: running ? "not-allowed" : "pointer",
              transition: "all 0.2s ease",
            }}
          >
            {running ? (
              <>
                <span className="spinner small" />
                <span>Running in Sandbox…</span>
              </>
            ) : (
              <>
                <span>⚡ Execute in Sandbox</span>
              </>
            )}
          </button>
        </div>

        {error && (
          <div style={{
            backgroundColor: "rgba(247, 118, 142, 0.1)",
            border: "1px solid rgba(247, 118, 142, 0.4)",
            color: "#f7768e",
            padding: "0.75rem 1rem",
            borderRadius: "6px",
            marginBottom: "1rem",
            fontSize: "0.9rem",
          }}>
            <strong>Execution Error:</strong> {error}
          </div>
        )}

        {result && (
          <div style={{
            backgroundColor: "#0a0d14",
            border: "1px solid #24283b",
            borderRadius: "8px",
            overflow: "hidden",
          }}>
            <div style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              padding: "0.6rem 1rem",
              backgroundColor: "#16161e",
              borderBottom: "1px solid #24283b",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                <span style={{
                  fontSize: "0.75rem",
                  fontWeight: 700,
                  padding: "2px 8px",
                  borderRadius: "4px",
                  backgroundColor: result.ok ? "rgba(158, 206, 106, 0.2)" : "rgba(247, 118, 142, 0.2)",
                  color: result.ok ? "#9ece6a" : "#f7768e",
                }}>
                  {result.ok ? "✓ SUCCESS" : "✗ FAILED"}
                </span>
                <span style={{ fontSize: "0.8rem", color: "#7aa2f7" }}>
                  ⏱️ {result.executionTimeMs}ms
                </span>
                <span style={{ fontSize: "0.8rem", color: "#565f89" }}>
                  Exit Code: {result.exitCode}
                </span>
              </div>
              <div>
                <button
                  type="button"
                  onClick={() => setShowLogs(!showLogs)}
                  style={{
                    background: "none",
                    border: "none",
                    color: "#7aa2f7",
                    cursor: "pointer",
                    fontSize: "0.8rem",
                  }}
                >
                  {showLogs ? "Hide Console Logs" : "Show Console Logs"}
                </button>
              </div>
            </div>

            <div style={{ padding: "1rem" }}>
              <div style={{ marginBottom: "0.75rem" }}>
                <span style={{ fontSize: "0.8rem", color: "#565f89", textTransform: "uppercase", fontWeight: 700 }}>
                  Output Result:
                </span>
                <pre style={{
                  backgroundColor: "#10121a",
                  padding: "0.75rem",
                  borderRadius: "6px",
                  color: "#c0caf5",
                  fontSize: "0.85rem",
                  overflowX: "auto",
                  marginTop: "0.4rem",
                  whiteSpace: "pre-wrap",
                }}>
                  {typeof result.output === "object" && result.output !== null
                    ? JSON.stringify(result.output, null, 2)
                    : String(result.output ?? "(no output)")}
                </pre>
              </div>

              {showLogs && result.logs && result.logs.length > 0 && (
                <div>
                  <span style={{ fontSize: "0.8rem", color: "#565f89", textTransform: "uppercase", fontWeight: 700 }}>
                    Sandbox Logs:
                  </span>
                  <div style={{
                    backgroundColor: "#050608",
                    padding: "0.75rem",
                    borderRadius: "6px",
                    color: "#9aa5ce",
                    fontSize: "0.8rem",
                    fontFamily: "monospace",
                    maxHeight: "180px",
                    overflowY: "auto",
                    marginTop: "0.4rem",
                  }}>
                    {result.logs.map((log, i) => (
                      <div key={i} style={{ lineHeight: "1.4" }}>
                        {log}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
