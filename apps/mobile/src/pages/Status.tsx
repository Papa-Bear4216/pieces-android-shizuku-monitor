import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { getStatus, ProxyNotConfiguredError, HomeNodeUnreachableError } from "../lib/api";
import { recordEvent } from "../lib/usage";
import { flushUsageEvents } from "../lib/flush";
import { isShizukuToolkitEnabled } from "../lib/config";
import { registerPlugin } from "@capacitor/core";

const ShizukuMonitor = registerPlugin<any>('ShizukuMonitor');
const AccessibilityScanner = registerPlugin<any>('AccessibilityScanner');

// Must exactly match ShizukuMonitorPlugin.ALLOWED_COMMANDS on the Java side —
// that's the real enforcement point, this list just drives the UI.
const PRESET_COMMANDS = [
  "dumpsys battery", "dumpsys cpuinfo", "dumpsys meminfo",
  "pm list packages -3", "ifconfig wlan0", "getprop ro.build.version.release",
];

type State =
  | { kind: "loading" }
  | { kind: "ok"; health: string; version: string }
  | { kind: "not-configured" }
  | { kind: "home-offline"; message: string }
  | { kind: "error"; message: string };

type AppEntry = { packageName: string; label: string };

export default function Status() {
  const navigate = useNavigate();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [toolkitEnabled, setToolkitEnabled] = useState(false);
  const [apps, setApps] = useState<AppEntry[]>([]);
  const [allowlist, setAllowlistState] = useState<Set<string>>(new Set());
  const [showPicker, setShowPicker] = useState(false);

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
    isShizukuToolkitEnabled().then(setToolkitEnabled);
    recordEvent({ type: "screen_view", screen: "status", timestamp: new Date().toISOString() });
    flushUsageEvents();
  }, []);

  async function openPicker() {
    try {
      const [{ apps }, { packages }] = await Promise.all([
        AccessibilityScanner.listInstalledApps(),
        AccessibilityScanner.getAllowlist(),
      ]);
      setApps(apps);
      setAllowlistState(new Set(packages));
      setShowPicker(true);
    } catch (e: any) {
      alert("Could not load app list: " + (e.message || String(e)));
    }
  }

  async function toggleApp(packageName: string) {
    const next = new Set(allowlist);
    if (next.has(packageName)) next.delete(packageName);
    else next.add(packageName);
    setAllowlistState(next);
    await AccessibilityScanner.setAllowlist({ packages: Array.from(next) });
  }

  async function runPreset(cmd: string) {
    try {
      const res = await ShizukuMonitor.executeCommand({ command: cmd });
      await recordEvent({
        type: "system_telemetry",
        screen: "background",
        telemetry: `Command: ${cmd}\n\n${res.output}`,
        timestamp: new Date().toISOString(),
      });
      await flushUsageEvents();
      alert("Executed & synced to PiecesOS.");
    } catch (e: any) {
      alert("Error: " + (e.message || String(e)));
    }
  }

  async function scanScreenText() {
    try {
      const res = await AccessibilityScanner.getActiveScreenText();
      if (res.status === "success") {
        await recordEvent({
          type: "system_telemetry",
          screen: "background",
          telemetry: `Package: ${res.package}\n\n${res.textNodes}`,
          timestamp: new Date().toISOString(),
        });
        await flushUsageEvents();
        alert(`Captured & synced ${res.textNodes.length} characters from ${res.package}.`);
      } else {
        alert(res.status);
      }
    } catch (e: any) {
      alert("Accessibility error: " + (e.message || String(e)));
    }
  }

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

          {!toolkitEnabled && (
            <p className="hint" style={{ marginTop: 20 }}>
              Shizuku toolkit is off. Enable it in Setup to use privileged diagnostics or
              screen-text capture.
            </p>
          )}

          {toolkitEnabled && (
            <div style={{ marginTop: 20, display: 'flex', flexDirection: 'column', gap: 8, background: 'rgba(0,0,0,0.8)', padding: 16, borderRadius: 8 }}>
              <h4 style={{margin: 0, color: 'white', fontSize: 14}}>Shizuku Toolkit</h4>
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {PRESET_COMMANDS.map(c => (
                  <button
                    key={c}
                    onClick={() => runPreset(c)}
                    style={{ fontSize: 11, padding: '4px 8px', cursor: 'pointer', borderRadius: 4, border: 'none', background: '#444', color: 'white' }}
                  >
                    {c}
                  </button>
                ))}
              </div>

              <hr style={{ border: 0, borderTop: '1px solid #555', margin: '8px 0' }} />

              <p style={{ color: '#ccc', fontSize: 12, margin: 0 }}>
                Screen-text capture only reads from apps you've explicitly allowed below.
              </p>
              <button
                onClick={openPicker}
                style={{ padding: '8px 16px', background: '#555', color: 'white', borderRadius: 8, border: 'none', cursor: 'pointer' }}
              >
                Choose allowed apps ({allowlist.size} selected)
              </button>
              <button
                onClick={scanScreenText}
                disabled={allowlist.size === 0}
                style={{ padding: '8px 16px', background: allowlist.size === 0 ? '#666' : '#9c27b0', color: 'white', borderRadius: 8, border: 'none', cursor: allowlist.size === 0 ? 'not-allowed' : 'pointer', fontWeight: 'bold' }}
              >
                Scan Screen Text
              </button>

              {showPicker && (
                <div style={{ marginTop: 8, maxHeight: 300, overflowY: 'auto', background: '#111', borderRadius: 8, padding: 8 }}>
                  {apps.map(app => (
                    <label key={app.packageName} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', fontSize: 13, color: 'white' }}>
                      <input
                        type="checkbox"
                        checked={allowlist.has(app.packageName)}
                        onChange={() => toggleApp(app.packageName)}
                      />
                      {app.label} <span style={{ color: '#888', fontSize: 11 }}>({app.packageName})</span>
                    </label>
                  ))}
                  <button
                    onClick={() => setShowPicker(false)}
                    style={{ marginTop: 8, padding: '4px 12px', background: '#444', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer' }}
                  >
                    Done
                  </button>
                </div>
              )}
            </div>
          )}
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
