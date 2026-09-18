import { useEffect, useState } from "react";
import { type PackDetail, getPack } from "./api.js";
import { InstallCommand, ModeBadge } from "./components.js";

export function PackDetailPage({ owner, name }: { owner: string; name: string }) {
  const [detail, setDetail] = useState<PackDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDetail(null);
    setError(null);
    getPack(owner, name).then(setDetail).catch((err: Error) => setError(err.message));
  }, [owner, name]);

  if (error) return <p className="error">{error}</p>;
  if (!detail) return <p className="muted">loading…</p>;

  return (
    <div className="detail">
      <a className="back" href="#/">
        ← back
      </a>
      <div className="card-head">
        <span className="ref">
          {detail.owner}/{detail.name}@{detail.version}
        </span>
        <ModeBadge mode={detail.mode} />
      </div>
      <h2>{detail.title}</h2>
      <p>{detail.description}</p>
      <InstallCommand owner={detail.owner} name={detail.name} />
      <dl>
        <dt>downloads</dt>
        <dd>{detail.downloads}</dd>
        <dt>stars</dt>
        <dd>
          {detail.stars}
          {detail.starred === true ? " (starred by you)" : ""}
        </dd>
        <dt>versions</dt>
        <dd>{detail.versions.join(", ")}</dd>
        <dt>targets</dt>
        <dd>{(detail.manifest.compatibility ?? []).join(", ")}</dd>
        {detail.manifest.endpoint && (
          <>
            <dt>endpoint</dt>
            <dd>
              {detail.manifest.endpoint.type} {detail.manifest.endpoint.url}
            </dd>
          </>
        )}
        {detail.manifest.runtime && (
          <>
            <dt>runtime</dt>
            <dd>
              {detail.manifest.runtime.image ?? detail.manifest.runtime.dockerfile} (
              {detail.manifest.runtime.protocol})
            </dd>
          </>
        )}
        {(detail.manifest.secrets ?? []).length > 0 && (
          <>
            <dt>secrets</dt>
            <dd>{detail.manifest.secrets?.join(", ")}</dd>
          </>
        )}
        <dt>sha256</dt>
        <dd className="digest">{detail.digest}</dd>
      </dl>
    </div>
  );
}
