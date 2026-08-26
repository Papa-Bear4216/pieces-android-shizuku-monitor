import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import {
  getWorkstreamSummaries,
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
  | { kind: "home-offline"; message: string }
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
        setState({ kind: "home-offline", message: err.message });
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
          <button onClick={load} style={{ marginBottom: 12 }}>
            Refresh
          </button>
          {state.summaries.length === 0 && <p>No workflow summaries yet.</p>}
          <ul>
            {state.summaries.map((s) => (
              <li key={s.id} style={{ marginBottom: 12, border: "1px solid #444", padding: 12, borderRadius: 8 }}>
                <div
                  onClick={() => setExpanded(expanded === s.id ? null : s.id)}
                  style={{ cursor: "pointer", display: "flex", justifyContent: "space-between" }}
                >
                  <strong>{s.name}</strong>
                  <span style={{ color: "#888", fontSize: 12 }}>{s.created}</span>
                </div>
                {expanded === s.id && (
                  <div style={{ marginTop: 8, whiteSpace: "pre-wrap", fontSize: 14, color: "#ccc" }}>{s.text}</div>
                )}
              </li>
            ))}
          </ul>
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
