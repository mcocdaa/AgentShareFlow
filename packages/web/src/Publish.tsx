import { useEffect, useState, type DragEvent, type FormEvent } from "react";
import { getSession, publishPack, type PublishResult, type SessionInfo } from "./api.js";
import { ModeBadge } from "./components.js";
import { extractManifestFromTarball } from "./tar.js";

const TOKEN_KEY = "agentshare.token";
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

function toPreview(manifest: unknown): PackPreview {
  if (typeof manifest !== "object" || manifest === null) {
    throw new Error("agent.json must be an object");
  }
  const record = manifest as Record<string, unknown>;
  for (const key of ["name", "version", "title", "description", "mode"] as const) {
    if (typeof record[key] !== "string" || record[key].length === 0) {
      throw new Error(`agent.json is missing "${key}"`);
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
      {copied ? "copied" : "copy"}
    </button>
  );
}

export function PublishPage() {
  const [token, setToken] = useState(() => window.localStorage.getItem(TOKEN_KEY) ?? "");
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

  const selectFile = async (selected: File | null): Promise<void> => {
    setFile(selected === null ? null : { name: selected.name, size: selected.size });
    setManifest(null);
    setPreview(null);
    setBytes(null);
    setDigest(null);
    setResult(null);
    setError(null);
    if (selected === null) return;
    try {
      const data = new Uint8Array(await selected.arrayBuffer());
      const parsed = extractManifestFromTarball(data);
      setPreview(toPreview(parsed));
      setManifest(parsed);
      setBytes(data);
      setDigest(hex(await crypto.subtle.digest("SHA-256", data)));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const onDrop = (event: DragEvent<HTMLLabelElement>): void => {
    event.preventDefault();
    setDragOver(false);
    void selectFile(event.dataTransfer.files[0] ?? null);
  };

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (bytes === null || manifest === null || digest === null) {
      setError("choose a tarball created by `agentshare pack` first");
      return;
    }
    if (session === null && token.trim().length === 0) {
      setError("API token is required (or sign in via this registry's OIDC login)");
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      if (token.trim().length > 0) window.localStorage.setItem(TOKEN_KEY, token.trim());
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
        ← back
      </a>
      <h2>Publish a pack</h2>
      <p className="muted">
        Releases are immutable — bump <code>version</code> in <code>agent.json</code> to publish
        again.
      </p>

      <section className="step">
        <div className="step-head">
          <span className="step-num">1</span>
          <h3>Build the tarball</h3>
        </div>
        <div className="install">
          <code>{packCommand}</code>
          <CopyButton text={packCommand} />
        </div>
        <p className="muted small">
          The registry re-validates <code>agent.json</code>, re-runs the security scan, and blocks
          high-severity packs.
        </p>
      </section>

      <section className="step">
        <div className="step-head">
          <span className="step-num">2</span>
          <h3>Upload</h3>
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
            <>
              <span className="dropzone-title">Drop a pack tarball here</span>
              <span className="muted small">or click to choose a .tgz file</span>
            </>
          ) : (
            <>
              <span className="dropzone-title">{file.name}</span>
              <span className="muted small">
                {formatBytes(file.size)}
                {digest !== null && ` · sha256 ${digest.slice(0, 12)}…`}
              </span>
            </>
          )}
        </label>

        {preview !== null && (
          <div className="card preview-card">
            <div className="card-head">
              <span className="ref">
                {preview.name}@{preview.version}
              </span>
              <ModeBadge mode={preview.mode} />
            </div>
            <h3>{preview.title}</h3>
            <p>{preview.description}</p>
            <div className="meta-row">
              {preview.compatibility.length > 0 && (
                <span className="chip">{preview.compatibility.join(" · ")}</span>
              )}
              {preview.skills.length > 0 && (
                <span className="chip">
                  {preview.skills.length} skill{preview.skills.length === 1 ? "" : "s"}
                </span>
              )}
              {preview.tags.map((tag) => (
                <span className="chip" key={tag}>
                  {tag}
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
          <h3>Authenticate &amp; publish</h3>
        </div>
        {sessionChecked && session !== null && (
          <p className="muted small">
            Signed in as <strong>{session.owner}</strong> — token not required.
          </p>
        )}
        <label className="field">
          API token{session !== null && <span> (optional)</span>}
          <input
            type="password"
            value={token}
            placeholder="token from AGENTSHARE_TOKENS"
            autoComplete="off"
            onChange={(event) => setToken(event.target.value)}
          />
        </label>
        <p className="muted small">
          {session !== null
            ? "Only needed to publish under a different owner; otherwise this browser session is used."
            : "Stored in this browser only; sent to this registry as a Bearer token."}
        </p>

        {error !== null && <p className="banner error">{error}</p>}
        {result !== null && (
          <div className="success-card">
            <div className="card-head">
              <span className="ref">{result.ref}</span>
              <span className="muted small">published</span>
            </div>
            <p className="muted small">
              <a href={`#/agents/${parseRef(result.ref).owner}/${parseRef(result.ref).name}`}>
                view pack
              </a>
            </p>
            <div className="install">
              <code>{`${CLI} install ${parseRef(result.ref).owner}/${parseRef(result.ref).name}`}</code>
              <CopyButton
                text={`${CLI} install ${parseRef(result.ref).owner}/${parseRef(result.ref).name}`}
              />
            </div>
          </div>
        )}

        <button className="primary" type="submit" disabled={busy || bytes === null}>
          {busy ? "publishing…" : "publish"}
        </button>
      </section>
    </form>
  );
}
