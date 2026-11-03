import { gzipSync, strToU8 } from "fflate";
import { useEffect, useState, type DragEvent, type FormEvent } from "react";
import {
  getSession,
  getStoredToken,
  publishPack,
  setStoredToken,
  type PublishResult,
  type SessionInfo,
} from "./api.js";
import { ModeBadge, PackageIcon, SparklesIcon, UploadIcon } from "./components.js";
import { translatePackText, useI18n } from "./i18n.js";
import { extractManifestFromTarball } from "./tar.js";

const CLI = "npx @agentshare/cli";

interface PackPreview {
  name: string;
  version: string;
  title: string;
  description: string;
  mode: string;
  tags: string[];
  compatibility: string[];
  skills: unknown[];
  secrets: string[];
}

interface SelectedFile {
  name: string;
  size: number;
}

function buildSampleTarball(): Uint8Array {
  const sampleManifest = JSON.stringify(
    {
      spec: "agent-pack/v0",
      name: "flow-orchestrator",
      version: "0.2.0",
      title: "Flow Ecosystem Orchestrator",
      description:
        "Multi-service health diagnostics, release readiness checks, and cross-project workflow automation pack.",
      mode: "offline",
      license: "MIT",
      compatibility: ["agents", "claude", "codex", "opencode", "openclaw", "hermes"],
      skills: ["."],
      tags: ["orchestration", "devops", "security"],
    },
    null,
    2,
  );
  const sampleSkill = `---
name: flow-orchestrator
description: Multi-service health diagnostics, release readiness checks, and cross-project workflow automation pack.
---

# Flow Ecosystem Orchestrator

Coordinate release pipelines, health checks, and cross-service workflows across your workspace with deterministic verification steps.
`;

  const makeEntry = (entryName: string, content: string): Uint8Array => {
    const contentBytes = strToU8(content);
    const header = new Uint8Array(512);
    header.set(strToU8(entryName), 0);
    header.set(strToU8("0000644"), 100);
    header.set(strToU8("0000000"), 108);
    header.set(strToU8("0000000"), 116);
    header.set(strToU8(contentBytes.length.toString(8).padStart(11, "0")), 124);
    header.set(strToU8(Math.floor(Date.now() / 1000).toString(8).padStart(11, "0")), 136);
    header.fill(32, 148, 156);
    header[156] = 48;
    header.set(strToU8("ustar"), 257);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += header[i]!;
    header.set(strToU8(sum.toString(8).padStart(6, "0") + "\0 "), 148);
    const padded = new Uint8Array(Math.ceil(contentBytes.length / 512) * 512);
    padded.set(contentBytes);
    const out = new Uint8Array(512 + padded.length);
    out.set(header, 0);
    out.set(padded, 512);
    return out;
  };

  const e1 = makeEntry("agent.json", sampleManifest);
  const e2 = makeEntry("SKILL.md", sampleSkill);
  const archive = new Uint8Array(e1.length + e2.length + 1024);
  archive.set(e1, 0);
  archive.set(e2, e1.length);
  return gzipSync(archive);
}

function toPreview(manifest: unknown, locale: "en" | "zh" = "en"): PackPreview {
  if (typeof manifest !== "object" || manifest === null) {
    throw new Error(locale === "zh" ? "agent.json 必须是 JSON 对象" : "agent.json must be an object");
  }
  const record = manifest as Record<string, unknown>;
  for (const key of ["name", "version", "title", "description", "mode"] as const) {
    if (typeof record[key] !== "string" || record[key].length === 0) {
      throw new Error(
        locale === "zh"
          ? `agent.json 缺少必填字段 "${key}"`
          : `agent.json is missing "${key}"`,
      );
    }
  }
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  return {
    name: record.name as string,
    version: record.version as string,
    title: record.title as string,
    description: record.description as string,
    mode: record.mode as string,
    tags: strings(record.tags),
    compatibility: strings(record.compatibility),
    skills: Array.isArray(record.skills) ? record.skills : [],
    secrets: strings(record.secrets),
  };
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function parseRef(ref: string): { owner: string; name: string } {
  const [owner = "", rest = ""] = ref.split("/");
  return { owner, name: rest.split("@")[0] ?? "" };
}

function CopyButton({ text }: { text: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? t("copiedLower") : t("copyLower")}
    </button>
  );
}

export function PublishPage() {
  const { t, td, locale } = useI18n();
  const [token, setToken] = useState(() => getStoredToken() ?? "");
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [sessionChecked, setSessionChecked] = useState(false);
  const [file, setFile] = useState<SelectedFile | null>(null);
  const [manifest, setManifest] = useState<unknown>(null);
  const [preview, setPreview] = useState<PackPreview | null>(null);
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [digest, setDigest] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PublishResult | null>(null);

  useEffect(() => {
    getSession()
      .then((found) => setSession(found))
      .finally(() => setSessionChecked(true));
  }, []);

  useEffect(() => {
    setError((prev) => (prev ? translatePackText(prev, locale) : null));
  }, [locale]);

  const loadTarballBytes = async (fileName: string, data: Uint8Array): Promise<void> => {
    setFile({ name: fileName, size: data.byteLength });
    setManifest(null);
    setPreview(null);
    setBytes(null);
    setDigest(null);
    setResult(null);
    setError(null);
    try {
      const parsed = extractManifestFromTarball(data, locale);
      setPreview(toPreview(parsed, locale));
      setManifest(parsed);
      setBytes(data);
      const copyBuf = new Uint8Array(data.byteLength);
      copyBuf.set(data);
      setDigest(hex(await crypto.subtle.digest("SHA-256", copyBuf)));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const selectFile = async (selected: File | null): Promise<void> => {
    if (selected === null) {
      setFile(null);
      setManifest(null);
      setPreview(null);
      setBytes(null);
      setDigest(null);
      setResult(null);
      setError(null);
      return;
    }
    const data = new Uint8Array(await selected.arrayBuffer());
    await loadTarballBytes(selected.name, data);
  };

  const handleAiAutofill = async (): Promise<void> => {
    const data = buildSampleTarball();
    await loadTarballBytes("flow-orchestrator-0.2.0.tgz", data);
  };

  const onDrop = (event: DragEvent<HTMLLabelElement>): void => {
    event.preventDefault();
    setDragOver(false);
    void selectFile(event.dataTransfer.files[0] ?? null);
  };

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (bytes === null || manifest === null || digest === null) {
      setError(t("errChooseTarballFirst"));
      return;
    }
    if (session === null && token.trim().length === 0) {
      setError(t("errTokenRequired"));
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      if (token.trim().length > 0) setStoredToken(token.trim());
      setResult(await publishPack(token.trim() || undefined, manifest, bytes, digest));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const packCommand = `${CLI} pack <my-agent-dir> --out pack.tgz`;

  return (
    <form className="publish" onSubmit={(event) => void submit(event)}>
      <a className="back" href="#/">
        {t("backLink")}
      </a>
      <h2>{t("publishTitle")}</h2>
      <p className="muted">
        {locale === "zh" ? (
          <>
            {t("publishImmutableLead")} <code>agent.json</code> {t("publishImmutableMid")}{" "}
            <code>version</code> {t("publishImmutableTail")}
          </>
        ) : (
          <>
            {t("publishImmutableLead")} <code>version</code> {t("publishImmutableMid")}{" "}
            <code>agent.json</code> {t("publishImmutableTail")}
          </>
        )}
      </p>

      <section className="step">
        <div className="step-head">
          <span className="step-num">1</span>
          <h3>{t("publishStep1Title")}</h3>
        </div>
        <div className="install code-row">
          <code>{packCommand}</code>
          <CopyButton text={packCommand} />
        </div>
        <p className="muted small">
          {t("publishStep1DescLead")} <code>agent.json</code>
          {t("publishStep1DescTail")}
        </p>
      </section>

      <section className="step">
        <div className="step-head step-head-between">
          <div className="step-head-left">
            <span className="step-num">2</span>
            <h3>{t("publishStep2Title")}</h3>
          </div>
          <button
            type="button"
            data-testid="ai-autofill-btn"
            className="ai-autofill-btn"
            onClick={() => void handleAiAutofill()}
            title={t("aiAutofillTitle")}
          >
            <SparklesIcon size={14} />
            <span>{t("aiAutofillBtn")}</span>
          </button>
        </div>
        <label
          className={`dropzone${dragOver ? " over" : ""}${file !== null ? " filled" : ""}`}
          onDragOver={(event) => {
            event.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
        >
          <input
            type="file"
            accept=".tgz,.tar.gz,application/gzip"
            onChange={(event) => void selectFile(event.target.files?.[0] ?? null)}
          />
          {file === null ? (
            <div className="dropzone-empty">
              <span className="dropzone-icon">
                <UploadIcon size={20} />
              </span>
              <span className="dropzone-title">{t("dropzoneEmptyTitle")}</span>
              <span className="muted small">{t("dropzoneEmptySub")}</span>
            </div>
          ) : (
            <div className="dropzone-empty">
              <span className="dropzone-icon">
                <PackageIcon size={20} />
              </span>
              <span className="dropzone-title">{file.name}</span>
              <span className="muted small">
                {formatBytes(file.size)}
                {digest !== null && ` · sha256 ${digest.slice(0, 12)}…`}
              </span>
            </div>
          )}
        </label>

        {preview !== null && (
          <div className="card preview-card">
            <div className="card-head preview-head">
              <span className="ref">
                {preview.name}@{preview.version}
              </span>
              <ModeBadge mode={preview.mode} />
            </div>
            <h3>{td(preview.title)}</h3>
            <p>{td(preview.description)}</p>
            <div className="meta-row preview-chips">
              {preview.compatibility.length > 0 && (
                <span className="chip">{preview.compatibility.join(" · ")}</span>
              )}
              {preview.skills.length > 0 && (
                <span className="chip">
                  {locale === "zh"
                    ? `${preview.skills.length} ${t("skillsCountSuffix")}`
                    : `${preview.skills.length} skill${preview.skills.length === 1 ? "" : "s"}`}
                </span>
              )}
              {preview.tags.map((tag) => (
                <span className="chip" key={tag}>
                  {td(tag)}
                </span>
              ))}
              {preview.secrets.map((secret) => (
                <span className="chip secret" key={secret}>
                  {secret}
                </span>
              ))}
            </div>
            {digest !== null && <div className="digest">sha256 {digest}</div>}
          </div>
        )}
      </section>

      <section className="step">
        <div className="step-head">
          <span className="step-num">3</span>
          <h3>{t("publishStep3Title")}</h3>
        </div>
        {sessionChecked && session !== null && (
          <p className="muted small">
            {t("publishSignedInLead")} <strong>{session.owner}</strong> {t("publishSignedInTail")}
          </p>
        )}
        <label className="field">
          {t("apiTokenLabel")}{session !== null && <span>{t("optionalSuffix")}</span>}
          <input
            type="password"
            value={token}
            placeholder={t("tokenPlaceholder")}
            autoComplete="off"
            onChange={(event) => setToken(event.target.value)}
          />
        </label>
        <p className="muted small">
          {session !== null
            ? t("tokenHintSignedIn")
            : t("tokenHintSignedOut")}
        </p>

        {error !== null && <p className="banner error">{td(error)}</p>}
        {result !== null && (
          <div className="success-card">
            <div className="card-head preview-head">
              <span className="ref">{result.ref}</span>
              <span className="muted small">{t("publishedBadge")}</span>
            </div>
            <p className="muted small">
              <a href={`#/agents/${parseRef(result.ref).owner}/${parseRef(result.ref).name}`}>
                {t("viewPackLink")}
              </a>
            </p>
            <div className="install code-row">
              <code>{`${CLI} install ${parseRef(result.ref).owner}/${parseRef(result.ref).name}`}</code>
              <CopyButton
                text={`${CLI} install ${parseRef(result.ref).owner}/${parseRef(result.ref).name}`}
              />
            </div>
          </div>
        )}

        <div className="actions">
          <button className="primary" type="submit" disabled={busy || bytes === null}>
            {busy ? t("publishingBusy") : t("publishSubmitBtn")}
          </button>
        </div>
      </section>
    </form>
  );
}
