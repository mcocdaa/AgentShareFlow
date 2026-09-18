import { useCallback, useEffect, useState } from "react";
import { type PackSummary, searchPacks } from "./api.js";
import { PackCard } from "./components.js";
import { PackDetailPage } from "./PackDetail.js";
import { PublishPage } from "./Publish.js";
import { SharePage } from "./SharePage.js";

function useHashRoute(): string {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return hash;
}

export function App() {
  const hash = useHashRoute();
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<PackSummary[]>([]);
  const [loading, setLoading] = useState(true);

  const runSearch = useCallback((value: string) => {
    setLoading(true);
    searchPacks(value)
      .then((result) => setItems(result.items))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, []);

  const shareMatch = /^#\/share\/([a-f0-9]+)$/.exec(hash);
  const detailMatch = /^#\/agents\/([^/]+)\/([^/]+)$/.exec(hash);
  const publishMatch = hash === "#/publish";

  useEffect(() => {
    if (!detailMatch && !shareMatch && !publishMatch) runSearch("");
  }, [hash, detailMatch, shareMatch, publishMatch, runSearch]);

  return (
    <div className="app">
      <header>
        <a className="logo" href="#/">
          AgentShareFlow
        </a>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            runSearch(query);
          }}
        >
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="search packs…"
          />
          <button type="submit">search</button>
        </form>
        <a className={`header-link${publishMatch ? " active" : ""}`} href="#/publish">
          publish
        </a>
      </header>
      <main>
        {shareMatch ? (
          <SharePage id={shareMatch[1] ?? ""} />
        ) : publishMatch ? (
          <PublishPage />
        ) : detailMatch ? (
          <PackDetailPage
            owner={decodeURIComponent(detailMatch[1] ?? "")}
            name={decodeURIComponent(detailMatch[2] ?? "")}
          />
        ) : loading ? (
          <p className="muted">loading…</p>
        ) : items.length === 0 ? (
          <p className="muted">no packs yet — publish one with the CLI</p>
        ) : (
          <div className="grid">
            {items.map((pack) => (
              <PackCard key={`${pack.owner}/${pack.name}`} pack={pack} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
