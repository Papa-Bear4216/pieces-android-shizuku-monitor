import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { getStatus, ProxyNotConfiguredError, HomeNodeUnreachableError } from "../lib/api";
import { recordEvent } from "../lib/usage";
import { flushUsageEvents } from "../lib/flush";
import { registerPlugin } from "@capacitor/core";

const ShizukuMonitor = registerPlugin<any>('ShizukuMonitor');
const AccessibilityScanner = registerPlugin<any>('AccessibilityScanner');

type State =
  | { kind: "loading" }
  | { kind: "ok"; health: string; version: string }
  | { kind: "not-configured" }
  | { kind: "home-offline"; message: string }
  | { kind: "error"; message: string };

export default function Status() {
  const navigate = useNavigate();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [cmd, setCmd] = useState("dumpsys battery");

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
          
          <div style={{ marginTop: 20, display: 'flex', flexDirection: 'column', gap: 8, background: 'rgba(0,0,0,0.8)', padding: 16, borderRadius: 8 }}>
            <h4 style={{margin: 0, color: 'white', fontSize: 14}}>Shizuku Toolkit</h4>
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {["dumpsys battery", "dumpsys cpuinfo", "pm list packages -3", "ifconfig wlan0", "getprop ro.build.version.release", "dumpsys meminfo"].map(c => (
                <button 
                  key={c} 
                  onClick={() => setCmd(c)} 
                  style={{ fontSize: 11, padding: '4px 8px', cursor: 'pointer', borderRadius: 4, border: 'none', background: '#444', color: 'white' }}
                >
                  {c}
                </button>
              ))}
            </div>
            <input 
              value={cmd} 
              onChange={e => setCmd(e.target.value)} 
              style={{ padding: 8, borderRadius: 4, border: 'none', color: 'black' }} 
            />
            <button 
              onClick={async () => {
                try {
                  const res = await ShizukuMonitor.executeCommand({ command: cmd });
                  console.log(`[${cmd}]\n` + res.output);
                  
                  const { recordEvent } = await import("../lib/usage");
                  await recordEvent({
                    type: "system_telemetry",
                    screen: "background",
                    telemetry: `Command: ${cmd}\n\n${res.output}`,
                    timestamp: new Date().toISOString(),
                  });
                  await flushUsageEvents();
                  
                  alert("Executed & Synced to Pieces OS!");
                } catch(e: any) {
                  alert("Error: " + (e.message || String(e)));
                }
              }} 
              style={{ padding: '8px 16px', background: 'green', color: 'white', borderRadius: 8, border: 'none', cursor: 'pointer', fontWeight: 'bold' }}
            >
              Execute Command
            </button>
            
            <button 
              onClick={async () => {
                try {
                  const res = await AccessibilityScanner.getActiveScreenText();
                  console.log(`[Accessibility] Captured Package: ${res.package}\nText Nodes:\n${res.textNodes}`);
                  
                  if (res.status === "success") {
                    const { recordEvent } = await import("../lib/usage");
                    await recordEvent({
                      type: "system_telemetry",
                      screen: "background",
                      telemetry: `Package: ${res.package}\n\n${res.textNodes}`,
                      timestamp: new Date().toISOString(),
                    });
                    await flushUsageEvents();
                    alert(`Captured & Synced ${res.textNodes.length} characters from ${res.package}.`);
                  } else {
                    alert(res.status);
                  }
                } catch(e: any) {
                  alert("Accessibility Error: " + (e.message || String(e)));
                }
              }} 
              style={{ padding: '8px 16px', background: '#9c27b0', color: 'white', borderRadius: 8, border: 'none', cursor: 'pointer', fontWeight: 'bold', marginTop: 8 }}
            >
              Scan Screen Text
            </button>
          </div>
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
