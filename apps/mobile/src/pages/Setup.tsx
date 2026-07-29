import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { registerPlugin } from "@capacitor/core";

const ShizukuMonitor = registerPlugin<any>('ShizukuMonitor');
import {
  getProxyBaseUrl, getProxyToken, setProxyBaseUrl, setProxyToken,
  isShizukuToolkitEnabled, setShizukuToolkitEnabled,
} from "../lib/config";
import { checkProxyHealth } from "../lib/api";
import { recordEvent, classifyMode } from "../lib/usage";
import { flushUsageEvents } from "../lib/flush";

export default function Setup() {
  const navigate = useNavigate();
  const [baseUrl, setBaseUrl] = useState("");
  const [token, setToken] = useState("");
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<"idle" | "ok" | "unreachable">("idle");
  const [shizukuToolkit, setShizukuToolkit] = useState(false);

  useEffect(() => {
    (async () => {
      const [savedUrl, savedToken, toolkitEnabled] = await Promise.all([
        getProxyBaseUrl(), getProxyToken(), isShizukuToolkitEnabled(),
      ]);
      if (savedUrl) setBaseUrl(savedUrl);
      if (savedToken) setToken(savedToken);
      setShizukuToolkit(toolkitEnabled);
    })();
    recordEvent({ type: "screen_view", screen: "setup", timestamp: new Date().toISOString() });
    flushUsageEvents();
  }, []);

  async function handleToggleShizuku(next: boolean) {
    setShizukuToolkit(next);
    await setShizukuToolkitEnabled(next);
    if (next) {
      // First-enable: try to turn on the accessibility service right away
      // rather than waiting for the next app launch. Best-effort — if
      // Shizuku isn't granted yet, the Status tab will surface that.
      try {
        await ShizukuMonitor.enableAccessibilityService();
      } catch (e) {
        console.warn("[Shizuku] enableAccessibilityService failed (grant Shizuku permission first)", e);
      }
    }
  }

  async function handleTestAndSave() {
    setChecking(true);
    setResult("idle");
    const reachable = await checkProxyHealth(baseUrl);
    setChecking(false);
    if (!reachable) {
      setResult("unreachable");
      return;
    }
    setResult("ok");
    await setProxyBaseUrl(baseUrl);
    await setProxyToken(token);

    if (shizukuToolkit) {
      try {
        const res = await ShizukuMonitor.executeCommand({ command: "dumpsys meminfo" });
        await recordEvent({
          type: "system_telemetry",
          screen: "background",
          telemetry: res.output,
          timestamp: new Date().toISOString(),
        });
      } catch (e) {
        console.warn("[Shizuku] Auto-init failed (Is the daemon started?)", e);
      }
    }

    await recordEvent({
      type: "setup_saved",
      screen: "setup",
      mode: classifyMode(baseUrl),
      timestamp: new Date().toISOString(),
    });
    flushUsageEvents();
  }

  return (
    <div className="page">
      <h1>Setup</h1>
      <p className="hint">
        Two ways to connect — same fields either way, just a different address and token:
      </p>
      <p className="hint">
        <strong>On your home Wi-Fi:</strong> the LAN proxy address (e.g. http://192.168.1.20:8787) and
        the bearer token generated on that PC.
      </p>
      <p className="hint">
        <strong>Away from home:</strong> your gateway's public URL (e.g. https://pieces.yourdomain.com)
        and a device token from the gateway's enroll command. This path fails closed — if the home PC
        is offline or unreachable, requests return an explicit error rather than hanging.
      </p>

      <label>
        Server address
        <input
          type="text"
          placeholder="http://192.168.1.20:8787 or https://pieces.yourdomain.com"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
        />
      </label>

      <label>
        Token
        <input type="password" placeholder="token" value={token} onChange={(e) => setToken(e.target.value)} />
      </label>

      <button onClick={handleTestAndSave} disabled={checking || !baseUrl || !token}>
        {checking ? "Checking…" : "Test & Save"}
      </button>

      {result === "ok" && <p className="status-ok">Connected. Saved.</p>}
      {result === "unreachable" && <p className="status-error">Could not reach proxy at that address.</p>}

      <div style={{ marginTop: 24, padding: 12, border: "1px solid #444", borderRadius: 8 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={shizukuToolkit}
            onChange={(e) => handleToggleShizuku(e.target.checked)}
          />
          <strong>Enable Shizuku toolkit (advanced)</strong>
        </label>
        <p className="hint" style={{ marginTop: 8 }}>
          Off by default. Turning this on lets the app run privileged diagnostic commands
          via Shizuku, and — if you separately grant Accessibility in Android Settings and
          pick apps in the Status tab's app picker — capture on-screen text from those
          specific apps only, to give PiecesOS more context. Requires the Shizuku app
          installed and its daemon running. Nothing here happens unless you turn this on
          first.
        </p>
      </div>

      <nav className="tabbar">
        <button onClick={() => navigate("/status")}>Status</button>
        <button onClick={() => navigate("/ask")}>Ask</button>
        <button onClick={() => navigate("/recent")}>Recent</button>
      </nav>
    </div>
  );
}
