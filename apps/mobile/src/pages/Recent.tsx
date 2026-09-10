import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import {
  getWorkstreamSummaries,
  getCachedWorkstreamSummaries,
  ProxyNotConfiguredError,
  HomeNodeUnreachableError,
  type WorkstreamSummary,
} from "../lib/api";
import { recordEvent } from "../lib/usage";
import { flushUsageEvents } from "../lib/flush";

type State =
  | { kind: "loading" }
  | { kind: "loaded"; summaries: WorkstreamSummary[] }
  | { kind: "not-configured" }
  | { kind: "home-offline"; message: string; stale?: { summaries: WorkstreamSummary[]; at: string } }
  | { kind: "error"; message: string };

export default function Recent() {
  const navigate = useNavigate();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [expanded, setExpanded] = useState<string | null>(null);

  async function load() {
    setState({ kind: "loading" });
    try {
      const summaries = await getWorkstreamSummaries();
      setState({ kind: "loaded", summaries });
    } catch (err) {
      if (err instanceof ProxyNotConfiguredError) {
        setState({ kind: "not-configured" });
      } else if (err instanceof HomeNodeUnreachableError) {
        const cached = await getCachedWorkstreamSummaries();
        setState({
          kind: "home-offline",
          message: err.message,
          stale: cached ? { summaries: cached.value, at: cached.at } : undefined,
        });
      } else {
        setState({ kind: "error", message: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  useEffect(() => {
    load();
    recordEvent({ type: "screen_view", screen: "recent", timestamp: new Date().toISOString() });
    flushUsageEvents();
  }, []);

  return (
    <div className="page">
      <h1>What Got Done</h1>
      <p className="hint">PiecesOS's own workflow summaries — not a raw activity feed.</p>

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

          {state.stale && (
            <>
              <p className="hint setup-note">
                Showing the last synced copy from {new Date(state.stale.at).toLocaleString()}:
              </p>
              <ul>
                {state.stale.summaries.map((s) => (
                  <li key={s.id} className="card faded">
                    <div className="card-row">
                      <span className="card-title">{s.name}</span>
                      <span className="card-meta">{s.created}</span>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}

      {state.kind === "error" && (
        <>
          <p className="status-error">{state.message}</p>
          <button onClick={load}>Retry</button>
        </>
      )}

      {state.kind === "loaded" && (
        <>
          <button className="secondary" onClick={load} style={{ marginBottom: 12 }}>
            Refresh
          </button>
          {state.summaries.length === 0 && <p className="hint">No workflow summaries yet.</p>}
          <ul>
            {state.summaries.map((s) => (
              <li key={s.id} className="card clickable" onClick={() => setExpanded(expanded === s.id ? null : s.id)}>
                <div className="card-row">
                  <span className="card-title">{s.name}</span>
                  <span className="card-meta">{s.created}</span>
                </div>
                {expanded === s.id && <div className="card-body">{s.text}</div>}
              </li>
            ))}
          </ul>
        </>
      )}

      <nav className="tabbar">
        <button onClick={() => navigate("/setup")}>Setup</button>
        <button onClick={() => navigate("/status")}>Status</button>
        <button onClick={() => navigate("/ask")}>Ask</button>
        <button onClick={() => navigate("/search")}>Search</button>
      </nav>
    </div>
  );
}
