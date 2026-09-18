import type { PackSummary } from "./api.js";

export function ModeBadge({ mode }: { mode: string }) {
  return <span className={`badge mode-${mode}`}>{mode}</span>;
}

export function InstallCommand({ owner, name }: { owner: string; name: string }) {
  const command = `npx @agentshare/cli install ${owner}/${name} --target agents`;
  return (
    <div className="install">
      <code>{command}</code>
      <button onClick={() => void navigator.clipboard.writeText(command)}>copy</button>
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
      <div className="card-foot">
        <span>v{pack.version}</span>
        <span>
          ★ {pack.stars} · {pack.downloads} downloads
        </span>
      </div>
    </a>
  );
}
