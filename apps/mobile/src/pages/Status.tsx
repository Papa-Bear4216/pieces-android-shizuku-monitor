import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { getStatus, ProxyNotConfiguredError, HomeNodeUnreachableError } from "../lib/api";
import { recordEvent } from "../lib/usage";
import { flushUsageEvents } from "../lib/flush";

type State =
  | { kind: "loading" }
  | { kind: "ok"; health: string; version: string }
  | { kind: "not-configured" }
  | { kind: "home-offline"; message: string }
  | { kind: "error"; message: string };

export default function Status() {
  const navigate = useNavigate();
  const [state, setState] = useState<State>({ kind: "loading" });

  async function load() {
    setState({ kind: "loading" });
    try {
      const { health, version } = await getStatus();
      setState({ kind: "ok", health, version });
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
    recordEvent({ type: "screen_view", screen: "status", timestamp: new Date().toISOString() });
    flushUsageEvents();
  }, []);

  return (
    <div className="page">
      <h1>Status</h1>

      {state.kind === "loading" && <p>Checking…</p>}

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

      {state.kind === "ok" && (
        <>
          <p className="status-ok">PiecesOS reachable</p>
          <dl>
            <dt>Health</dt>
            <dd>{state.health}</dd>
            <dt>Version</dt>
            <dd>{state.version}</dd>
          </dl>
          <button onClick={load}>Refresh</button>
        </>
      )}

      <nav className="tabbar">
        <button onClick={() => navigate("/setup")}>Setup</button>
        <button onClick={() => navigate("/ask")}>Ask</button>
        <button onClick={() => navigate("/recent")}>Recent</button>
      </nav>
    </div>
  );
}
