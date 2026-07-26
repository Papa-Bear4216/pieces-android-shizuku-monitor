import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ask, ProxyNotConfiguredError, HomeNodeUnreachableError, type AskResult } from "../lib/api";

type State =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "result"; result: AskResult }
  | { kind: "not-configured" }
  | { kind: "home-offline"; message: string }
  | { kind: "error"; message: string };

export default function Ask() {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [state, setState] = useState<State>({ kind: "idle" });

  async function handleAsk() {
    if (!query.trim()) return;
    setState({ kind: "loading" });
    try {
      const result = await ask(query);
      setState({ kind: "result", result });
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

  return (
    <div className="page">
      <h1>Ask</h1>

      <label>
        Question
        <input
          type="text"
          placeholder="What have I been working on?"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>

      <button onClick={handleAsk} disabled={state.kind === "loading" || !query.trim()}>
        {state.kind === "loading" ? "Asking…" : "Ask"}
      </button>

      {state.kind === "not-configured" && (
        <>
          <p className="status-error">Not set up yet.</p>
          <button onClick={() => navigate("/setup")}>Go to Setup</button>
        </>
      )}

      {state.kind === "home-offline" && (
        <p className="status-error">Home PC is offline or unreachable. {state.message}</p>
      )}

      {state.kind === "error" && <p className="status-error">{state.message}</p>}

      {state.kind === "result" && state.result.status === "unavailable" && (
        <p className="status-error">
          Ask is currently unavailable: {state.result.reason}
        </p>
      )}

      {state.kind === "result" && state.result.status === "answered" && (
        <pre className="answer">{JSON.stringify(state.result.answers, null, 2)}</pre>
      )}

      <nav className="tabbar">
        <button onClick={() => navigate("/setup")}>Setup</button>
        <button onClick={() => navigate("/status")}>Status</button>
        <button onClick={() => navigate("/recent")}>Recent</button>
      </nav>
    </div>
  );
}
