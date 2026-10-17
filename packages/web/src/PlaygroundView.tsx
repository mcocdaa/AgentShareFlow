import React, { useEffect, useState } from "react";
import {
  type PackDetail,
  type PlaygroundResult,
  type SessionInfo,
  getStoredToken,
  runPackPlayground,
} from "./api.js";
import { type Locale, translatePackText, translations, useI18n } from "./i18n.js";

function buildDefaultPrompt(detail: PackDetail, loc: Locale): string {
  const dict = translations[loc];
  const localizedTitle = translatePackText(detail.title, loc);
  return detail.mode === "runtime"
    ? JSON.stringify({ action: "execute", query: dict.defaultRuntimeQuery }, null, 2)
    : `${dict.defaultSkillPromptPrefix}${localizedTitle}${dict.defaultSkillPromptSuffix}`;
}

function swapPromptText(str: string, loc: Locale, detail: PackDetail): string {
  const zhDefault = buildDefaultPrompt(detail, "zh");
  const enDefault = buildDefaultPrompt(detail, "en");
  const rawZhDefault = `${translations.zh.defaultSkillPromptPrefix}${detail.title}${translations.zh.defaultSkillPromptSuffix}`;
  const zhPreset = translations.zh.presetAuditPromptText;
  const enPreset = translations.en.presetAuditPromptText;
  const zhRuntime = translations.zh.defaultRuntimeQuery;
  const enRuntime = translations.en.defaultRuntimeQuery;
  if (loc === "zh") {
    return str
      .replace(enDefault, zhDefault)
      .replace(rawZhDefault, zhDefault)
      .replace(enPreset, zhPreset)
      .replace(enRuntime, zhRuntime);
  }
  return str
    .replace(zhDefault, enDefault)
    .replace(rawZhDefault, enDefault)
    .replace(zhPreset, enPreset)
    .replace(zhRuntime, enRuntime);
}

function formatPlaygroundLog(log: string, loc: Locale, detail: PackDetail): string {
  const swapped = swapPromptText(log, loc, detail);
  if (loc === "en") {
    return translatePackText(
      swapped
        .replace(
          /^(\[stdout\]\s*)?\[编排器\] 已加载技能包: (.+)$/,
          "$1[Orchestrator] Loaded pack: $2",
        )
        .replace(
          /^(\[stdout\]\s*)?\[编排器\] 输入指令: (.+)$/,
          "$1[Orchestrator] Input prompt: $2",
        )
        .replace("编排预演已成功完成", "Orchestration dry-run completed successfully"),
      "en",
    );
  }
  if (swapped === "[Sandbox Runtime] Initialized offline skill emulation sandbox.") {
    return "[沙箱运行时] 已初始化离线技能仿真沙箱环境。";
  }
  const loadedMatch = /^\[Sandbox Runtime\] Loaded (.+) \((\d+) bytes\)\.$/.exec(swapped);
  if (loadedMatch) {
    return `[沙箱运行时] 已加载 ${loadedMatch[1]} (${loadedMatch[2]} 字节)。`;
  }
  const queryMatch = /^\[Sandbox Runtime\] Processing input query: "([\s\S]*)"$/.exec(swapped);
  if (queryMatch) {
    const inner = swapPromptText(translatePackText(queryMatch[1] ?? "", "zh"), "zh", detail);
    return `[沙箱运行时] 正在处理输入指令: "${inner}"`;
  }
  if (swapped === "[Sandbox Runtime] Execution successfully concluded with status: completed.") {
    return "[沙箱运行时] 执行已成功完成，状态: 已完成。";
  }
  const orchLoadedMatch = /^(\[stdout\]\s*)?\[Orchestrator\] Loaded pack: (.+)$/.exec(swapped);
  if (orchLoadedMatch) {
    return `${orchLoadedMatch[1] ?? ""}[编排器] 已加载技能包: ${orchLoadedMatch[2]}`;
  }
  const orchPromptMatch = /^(\[stdout\]\s*)?\[Orchestrator\] Input prompt: (.+)$/.exec(swapped);
  if (orchPromptMatch) {
    return `${orchPromptMatch[1] ?? ""}[编排器] 输入指令: ${swapPromptText(orchPromptMatch[2] ?? "", "zh", detail)}`;
  }
  const sbMountMatch = /^(\[stdout\]\s*)?\[Sandbox\] Mounting pack (.+) \(read-only\)\.\.\.$/.exec(
    swapped,
  );
  if (sbMountMatch) {
    return `${sbMountMatch[1] ?? ""}[沙箱] 正在挂载技能包 ${sbMountMatch[2]} (只读)...`;
  }
  const sbVerifyMatch =
    /^(\[stdout\]\s*)?\[Sandbox\] Verifying Ed25519 signature & manifest integrity: OK$/.exec(
      swapped,
    );
  if (sbVerifyMatch) {
    return `${sbVerifyMatch[1] ?? ""}[沙箱] 正在校验 Ed25519 签名与清单完整性: 通过`;
  }
  const sbAuditMatch = /^(\[stdout\]\s*)?\[Sandbox\] Executing audit task: (.+)$/.exec(swapped);
  if (sbAuditMatch) {
    return `${sbAuditMatch[1] ?? ""}[沙箱] 正在执行审计任务: ${swapPromptText(sbAuditMatch[2] ?? "", "zh", detail)}`;
  }
  return translatePackText(
    swapped
      .replace("Orchestration dry-run completed successfully", "编排预演已成功完成")
      .replace('"status": "verified"', '"status": "已验证"')
      .replace('"ed25519Signature": "verified"', '"ed25519Signature": "已验证"')
      .replace(
        '"securityScan": "0 high / 0 medium findings"',
        '"securityScan": "0 个高危 / 0 个中危发现"',
      ),
    "zh",
  );
}

function formatPlaygroundOutput(output: unknown, loc: Locale, detail: PackDetail): unknown {
  if (typeof output !== "object" || output === null) return output;
  const rec = output as Record<string, unknown>;
  if (rec.simulated === true && typeof rec.skill === "string") {
    const skillLabel = translatePackText(rec.skill, loc);
    const rawInput = typeof rec.input === "string" ? rec.input : "";
    const inputStr = swapPromptText(rawInput, loc, detail);
    if (loc === "zh") {
      return {
        ...rec,
        skill: skillLabel,
        input: inputStr,
        status: rec.status === "completed" ? "已完成" : rec.status,
        response: `来自 ${skillLabel} 的仿真响应：已在隔离沙箱环境中成功完成指令执行："${inputStr}"。`,
      };
    }
    return {
      ...rec,
      skill: skillLabel,
      input: inputStr,
      status: "completed",
      response: `Simulated response from ${skillLabel}: Execution completed successfully in sandboxed skill environment for query: "${inputStr}".`,
    };
  }
  const next: Record<string, unknown> = { ...rec };
  if (typeof next.task === "string") {
    next.task = swapPromptText(next.task, loc, detail);
  }
  if (typeof next.input === "string") {
    next.input = swapPromptText(next.input, loc, detail);
  }
  if (typeof next.prompt === "string") {
    next.prompt = swapPromptText(next.prompt, loc, detail);
  }
  if (typeof next.status === "string") {
    if (next.status === "verified" || next.status === "已验证") {
      next.status = loc === "zh" ? "已验证" : "verified";
    } else if (next.status === "completed" || next.status === "已完成") {
      next.status = loc === "zh" ? "已完成" : "completed";
    }
  }
  if (typeof next.ed25519Signature === "string") {
    if (next.ed25519Signature === "verified" || next.ed25519Signature === "已验证") {
      next.ed25519Signature = loc === "zh" ? "已验证" : "verified";
    }
  }
  if (typeof next.securityScan === "string") {
    if (
      next.securityScan === "0 high / 0 medium findings" ||
      next.securityScan === "0 个高危 / 0 个中危发现"
    ) {
      next.securityScan = loc === "zh" ? "0 个高危 / 0 个中危发现" : "0 high / 0 medium findings";
    }
  }
  if (typeof next.message === "string") {
    next.message =
      loc === "zh"
        ? swapPromptText(next.message, loc, detail).replace(
            "Orchestration dry-run completed successfully",
            "编排预演已成功完成",
          )
        : swapPromptText(next.message, loc, detail).replace(
            "编排预演已成功完成",
            "Orchestration dry-run completed successfully",
          );
  }
  return next;
}

export function PlaygroundView({
  detail,
  session,
  onRequireAuth,
}: {
  detail: PackDetail;
  session?: SessionInfo | null;
  onRequireAuth?: () => void;
}) {
  const { t, td, locale } = useI18n();
  const [inputVal, setInputVal] = useState(() => buildDefaultPrompt(detail, locale));
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<PlaygroundResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showLogs, setShowLogs] = useState(true);

  useEffect(() => {
    setError((prev) => (prev ? translatePackText(prev, locale) : null));
    setInputVal((prev) => {
      const enDefault = buildDefaultPrompt(detail, "en");
      const zhDefault = buildDefaultPrompt(detail, "zh");
      const rawZhDefault = `${translations.zh.defaultSkillPromptPrefix}${detail.title}${translations.zh.defaultSkillPromptSuffix}`;
      if (prev === enDefault || prev === zhDefault || prev === rawZhDefault) {
        return buildDefaultPrompt(detail, locale);
      }
      if (
        prev === translations.en.presetAuditPromptText ||
        prev === translations.zh.presetAuditPromptText
      ) {
        return translations[locale].presetAuditPromptText;
      }
      return prev;
    });
  }, [locale, detail]);

  const isAuthenticated = Boolean(session?.owner || getStoredToken());

  const handleRun = async () => {
    if (!session?.owner && !getStoredToken()) {
      if (onRequireAuth) {
        onRequireAuth();
      } else {
        setError(t("errSignInToRun"));
      }
      return;
    }
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
      const msg = err instanceof Error ? err.message : String(err);
      if (/unauthorized|401/i.test(msg) && onRequireAuth) {
        onRequireAuth();
      }
      setError(msg);
    } finally {
      setRunning(false);
    }
  };

  const loadPreset = (type: "audit" | "json" | "ping") => {
    if (type === "audit") {
      setInputVal(t("presetAuditPromptText"));
    } else if (type === "json") {
      setInputVal(JSON.stringify({ operation: "analyze", target: "auth_service.py", verbose: true }, null, 2));
    } else {
      setInputVal(JSON.stringify({ method: "ping", params: { timestamp: Date.now() } }, null, 2));
    }
  };

  return (
    <div className="playground-container" style={{ marginTop: "1.5rem" }}>
      <div className="playground-card playground-grid">
        <div className="playground-form-card">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "0.25rem", flexWrap: "wrap", gap: "0.75rem" }}>
            <div>
              <h3 style={{ margin: 0, fontSize: "1.1rem", display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                <span>{t("playgroundTitle")}</span>
                <span className="exec-badge">
                  {t("playgroundBadge")}
                </span>
              </h3>
              <p style={{ margin: "4px 0 0 0", color: "#8892b0", fontSize: "0.85rem" }}>
                {t("playgroundSubtitle")}
              </p>
            </div>
            <div className="playground-tabs">
              <button
                type="button"
                className="pg-tab"
                onClick={() => loadPreset("audit")}
              >
                {t("presetPrompt")}
              </button>
              <button
                type="button"
                className="pg-tab"
                onClick={() => loadPreset("json")}
              >
                {t("presetJson")}
              </button>
            </div>
          </div>

          {!isAuthenticated && (
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: "0.75rem",
                backgroundColor: "rgba(110, 168, 254, 0.1)",
                border: "1px solid rgba(110, 168, 254, 0.3)",
                borderRadius: "8px",
                padding: "0.75rem 1rem",
                fontSize: "0.85rem",
                color: "#c0caf5",
              }}
            >
              <span>
                {t("signInSandboxBanner")}
              </span>
              {onRequireAuth && (
                <button
                  type="button"
                  onClick={onRequireAuth}
                  style={{
                    padding: "5px 12px",
                    fontSize: "0.8rem",
                    borderRadius: "6px",
                    backgroundColor: "rgba(110, 168, 254, 0.2)",
                    border: "1px solid #6ea8fe",
                    color: "#6ea8fe",
                    fontWeight: 600,
                    whiteSpace: "nowrap",
                  }}
                >
                  {t("signIn")}
                </button>
              )}
            </div>
          )}

          <div>
            <label style={{ display: "block", fontSize: "0.82rem", color: "#8892b0", marginBottom: "0.4rem" }}>
              {t("taskPromptLabel")}
            </label>
            <textarea
              value={inputVal}
              onChange={(e) => setInputVal(e.target.value)}
              rows={3}
              style={{
                width: "100%",
                boxSizing: "border-box",
                fontFamily: "monospace",
                fontSize: "0.88rem",
                backgroundColor: "#0a0d14",
                color: "#c0caf5",
                border: "1px solid #283457",
                borderRadius: "6px",
                padding: "0.65rem 0.75rem",
                resize: "vertical",
              }}
            />
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button
              type="button"
              onClick={handleRun}
              disabled={running}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
                padding: "7px 18px",
                backgroundColor: running ? "#414868" : "#8A2BE2",
                color: "#fff",
                border: "none",
                borderRadius: "6px",
                fontWeight: 600,
                fontSize: "0.88rem",
                cursor: running ? "not-allowed" : "pointer",
                transition: "all 0.2s ease",
                whiteSpace: "nowrap",
              }}
            >
              {running ? (
                <>
                  <span className="spinner small" />
                  <span>{t("runningInSandbox")}</span>
                </>
              ) : (
                <>
                  <span>{t("runInSandbox")}</span>
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
              fontSize: "0.9rem",
            }}>
              <strong>{t("executionErrorLabel")}</strong> {td(error)}
            </div>
          )}
        </div>

        <div className="playground-output-card result-panel">
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
                backgroundColor: result
                  ? result.ok
                    ? "rgba(158, 206, 106, 0.2)"
                    : "rgba(247, 118, 142, 0.2)"
                  : "rgba(122, 162, 247, 0.18)",
                color: result ? (result.ok ? "#9ece6a" : "#f7768e") : "#7aa2f7",
              }}>
                {result ? (result.ok ? t("statusSuccess") : t("statusFailed")) : t("sandboxIdleStatus")}
              </span>
              {result && (
                <>
                  <span style={{ fontSize: "0.8rem", color: "#7aa2f7" }}>
                    ⏱️ {Math.max(1, result.executionTimeMs)}ms
                  </span>
                  <span style={{ fontSize: "0.8rem", color: "#565f89" }}>
                    {t("exitCodeLabel")} {result.exitCode}
                  </span>
                </>
              )}
            </div>
            {result && (
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
                  {showLogs ? t("hideConsoleLogs") : t("showConsoleLogs")}
                </button>
              </div>
            )}
          </div>

          <div style={{ padding: "1rem" }}>
            <div style={{ marginBottom: "0.75rem" }}>
              <span style={{ fontSize: "0.8rem", color: "#565f89", textTransform: "uppercase", fontWeight: 700 }}>
                {t("outputResultLabel")}
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
                {result
                  ? typeof result.output === "object" && result.output !== null
                    ? JSON.stringify(formatPlaygroundOutput(result.output, locale, detail), null, 2)
                    : String(result.output ?? t("noOutputFallback"))
                  : t("noOutputFallback")}
              </pre>
            </div>

            {showLogs && (
              <div>
                <span style={{ fontSize: "0.8rem", color: "#565f89", textTransform: "uppercase", fontWeight: 700 }}>
                  {t("executionTraceLabel")}
                </span>
                <div className="stream-console trace-timeline">
                  {result && result.logs && result.logs.length > 0 ? (
                    result.logs.map((log, i) => (
                      <div key={i} className="stream-line">
                        {formatPlaygroundLog(log, locale, detail)}
                      </div>
                    ))
                  ) : (
                    <div className="stream-line">{t("sandboxIdleHint")}</div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
