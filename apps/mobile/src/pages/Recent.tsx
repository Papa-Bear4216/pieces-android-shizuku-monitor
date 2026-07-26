import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  getRecentConversations,
  getRecentAssets,
  searchAssets,
  ProxyNotConfiguredError,
  HomeNodeUnreachableError,
  type ConversationSummary,
  type AssetSummary,
} from "../lib/api";

type State =
  | { kind: "loading" }
  | { kind: "loaded"; conversations: ConversationSummary[]; assets: AssetSummary[] }
  | { kind: "not-configured" }
  | { kind: "home-offline"; message: string }
  | { kind: "error"; message: string };

export default function Recent() {
  const navigate = useNavigate();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<AssetSummary[] | null>(null);

  async function load() {
    setState({ kind: "loading" });
    try {
      const [conversations, assets] = await Promise.all([getRecentConversations(), getRecentAssets()]);
      setState({ kind: "loaded", conversations, assets });
    } catch (err) {
      if (err instanceof ProxyNotConfiguredError) {
        setState({ kind: "not-configured" });
      } else if (err instanceof HomeNodeUnreachableError) {
        setState({ kind: "home-offline", message: err.message });
      } else {
        setState({ kind: "error", message: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function handleSearch() {
    if (!query.trim()) {
      setSearchResults(null);
      return;
    }
    try {
      setSearchResults(await searchAssets(query));
    } catch (err) {
      setSearchResults([]);
    }
  }

  return (
    <div className="page">
      <h1>Recent</h1>

      <label>
        Search assets
        <input
          type="text"
          placeholder="search…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSearch()}
        />
      </label>
      <button onClick={handleSearch} disabled={!query.trim()}>
        Search
      </button>

      {state.kind === "loading" && <p>Loading…</p>}

      {state.kind === "not-configured" && (
        <>
          <p className="status-error">Not set up yet.</p>
          <button onClick={() => navigate("/setup")}>Go to Setup</button>
        </>
      )}

      {state.kind === "home-offline" && (
        <>
          <p className="status-error">Home PC is offline or unreachable. {state.message}</p>
          <button onClick={load}>Retry</button>
        </>
      )}

      {state.kind === "error" && (
        <>
          <p className="status-error">{state.message}</p>
          <button onClick={load}>Retry</button>
        </>
      )}

      {searchResults !== null && (
        <section>
          <h2>Search results</h2>
          {searchResults.length === 0 && <p>No matches.</p>}
          <ul>
            {searchResults.map((a) => (
              <li key={a.id}>
                <strong>{a.name}</strong> — {a.updated}
              </li>
            ))}
          </ul>
        </section>
      )}

      {state.kind === "loaded" && (
        <>
          <section>
            <h2>Conversations</h2>
            <ul>
              {state.conversations.slice(0, 20).map((c) => (
                <li key={c.id}>
                  <strong>{c.name}</strong> — {c.updated}
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h2>Assets</h2>
            <ul>
              {state.assets.slice(0, 20).map((a) => (
                <li key={a.id}>
                  <strong>{a.name}</strong> — {a.updated}
                </li>
              ))}
            </ul>
          </section>
        </>
      )}

      <nav className="tabbar">
        <button onClick={() => navigate("/setup")}>Setup</button>
        <button onClick={() => navigate("/status")}>Status</button>
        <button onClick={() => navigate("/ask")}>Ask</button>
      </nav>
    </div>
  );
}
