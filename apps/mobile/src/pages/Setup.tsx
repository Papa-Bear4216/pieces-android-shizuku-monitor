import { useState, useEffect } from "react";
import { useNavigate } from "react-router";
import { registerPlugin } from "@capacitor/core";

const ShizukuMonitor = registerPlugin<any>('ShizukuMonitor');
const AccessibilityScanner = registerPlugin<any>('AccessibilityScanner');
import {
  getProxyBaseUrl, getProxyToken, setProxyBaseUrl, setProxyToken,
  getRemoteGatewayUrl, getRemoteGatewayToken, setRemoteGatewayUrl, setRemoteGatewayToken,
  isShizukuToolkitEnabled, setShizukuToolkitEnabled,
  isScreenContextEnabled, setScreenContextEnabled,
} from "../lib/config";
import { checkProxyHealth } from "../lib/api";
import { recordEvent } from "../lib/usage";
import { flushUsageEvents } from "../lib/flush";

export default function Setup() {
  const navigate = useNavigate();
  // Plan A (LAN)
  const [baseUrl, setBaseUrl] = useState("");
  const [token, setToken] = useState("");
  const [result, setResult] = useState<"idle" | "ok" | "unreachable">("idle");

  // Plan B (Remote Gateway Fallback)
  const [remoteUrl, setRemoteUrl] = useState("");
  const [remoteToken, setRemoteToken] = useState("");
  const [remoteResult, setRemoteResult] = useState<"idle" | "ok" | "unreachable">("idle");

  const [checking, setChecking] = useState(false);
  const [shizukuToolkit, setShizukuToolkit] = useState(false);
  const [screenContext, setScreenContext] = useState(false);
  const [accessibilityGranted, setAccessibilityGranted] = useState(false);

  useEffect(() => {
    (async () => {
      const [
        savedUrl, savedToken,
        savedRemoteUrl, savedRemoteToken,
        toolkitEnabled, contextEnabled
      ] = await Promise.all([
        getProxyBaseUrl(), getProxyToken(),
        getRemoteGatewayUrl(), getRemoteGatewayToken(),
        isShizukuToolkitEnabled(), isScreenContextEnabled(),
      ]);
      if (savedUrl) setBaseUrl(savedUrl);
      if (savedToken) setToken(savedToken);
      if (savedRemoteUrl) setRemoteUrl(savedRemoteUrl);
      if (savedRemoteToken) setRemoteToken(savedRemoteToken);
      setShizukuToolkit(toolkitEnabled);
      setScreenContext(contextEnabled);
    })();
    AccessibilityScanner.isAccessibilityServiceEnabled().then((r: any) => setAccessibilityGranted(r.enabled));
    recordEvent({ type: "screen_view", screen: "setup", timestamp: new Date().toISOString() });
    flushUsageEvents();
  }, []);

  async function handleToggleScreenContext(next: boolean) {
    setScreenContext(next);
    await setScreenContextEnabled(next);
    try {
      await AccessibilityScanner.setScreenContextEnabled({ enabled: next });
    } catch (e) {
      console.warn("[Accessibility] setScreenContextEnabled failed", e);
    }
  }

  async function handleToggleShizuku(next: boolean) {
    setShizukuToolkit(next);
    await setShizukuToolkitEnabled(next);
    try {
      await ShizukuMonitor.setToolkitEnabled({ enabled: next });
    } catch (e) {
      console.warn("[Shizuku] setToolkitEnabled failed", e);
    }
    if (next) {
      try {
        await ShizukuMonitor.enableAccessibilityService();
      } catch (e) {
        console.warn("[Shizuku] enableAccessibilityService failed", e);
      }
    }
  }

  async function handleTestAndSave() {
    setChecking(true);
    setResult("idle");
    setRemoteResult("idle");

    let lanOk = false;
    let remoteOk = false;

    if (baseUrl.trim()) {
      const reachable = await checkProxyHealth(baseUrl.trim());
      lanOk = reachable;
      setResult(reachable ? "ok" : "unreachable");
      if (reachable) {
        await setProxyBaseUrl(baseUrl.trim());
        await setProxyToken(token.trim());
      }
    }

    if (remoteUrl.trim()) {
      const reachable = await checkProxyHealth(remoteUrl.trim());
      remoteOk = reachable;
      setRemoteResult(reachable ? "ok" : "unreachable");
      if (reachable) {
        await setRemoteGatewayUrl(remoteUrl.trim());
        await setRemoteGatewayToken(remoteToken.trim());
      }
    }

    setChecking(false);

    if (lanOk || remoteOk) {
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
          console.warn("[Shizuku] Auto-init failed", e);
        }
      }

      await recordEvent({
        type: "setup_saved",
        screen: "setup",
        mode: lanOk ? "lan" : "remote",
        timestamp: new Date().toISOString(),
      });
      flushUsageEvents();
    }
  }

  return (
    <div className="page">
      <h1>Connection Setup</h1>
      <p className="hint">
        Configure your local and remote endpoints. The app automatically uses Plan A on your home network/USB and falls back to Plan B when you disconnect or leave home.
      </p>

      {/* Plan A: LAN */}
      <div style={{ padding: 14, border: "1px solid #3d3b54", borderRadius: 10, marginBottom: 16 }}>
        <h3 style={{ margin: "0 0 6px 0", fontSize: 16 }}>Plan A: Home / LAN Proxy (Primary)</h3>
        <p className="hint" style={{ margin: "0 0 10px 0" }}>
          Local IP or USB reverse tunnel (e.g. <code>http://127.0.0.1:8787</code> or <code>http://192.168.1.x:8787</code>).
        </p>
        <label>
          LAN Address
          <input
            type="text"
            placeholder="http://192.168.1.20:8787 or http://127.0.0.1:8787"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </label>
        <label style={{ marginTop: 8 }}>
          LAN Bearer Token
          <input
            type="password"
            placeholder="token from PC proxy"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </label>
        {result === "ok" && <p className="status-ok" style={{ margin: "6px 0 0 0" }}>✓ LAN Proxy Connected</p>}
        {result === "unreachable" && <p className="status-error" style={{ margin: "6px 0 0 0" }}>✗ Could not reach LAN proxy</p>}
      </div>

      {/* Plan B: Remote Gateway */}
      <div style={{ padding: 14, border: "1px solid #3d3b54", borderRadius: 10, marginBottom: 16 }}>
        <h3 style={{ margin: "0 0 6px 0", fontSize: 16 }}>Plan B: Remote Gateway (Auto-Failover)</h3>
        <p className="hint" style={{ margin: "0 0 10px 0" }}>
          Away-from-home gateway via Tailscale/Domain (e.g. <code>https://pieces.yourdomain.com</code>). Used automatically when LAN disconnects.
        </p>
        <label>
          Gateway URL
          <input
            type="text"
            placeholder="https://pieces.yourdomain.com"
            value={remoteUrl}
            onChange={(e) => setRemoteUrl(e.target.value)}
          />
        </label>
        <label style={{ marginTop: 8 }}>
          Device Token
          <input
            type="password"
            placeholder="device token from gateway enroll"
            value={remoteToken}
            onChange={(e) => setRemoteToken(e.target.value)}
          />
        </label>
        {remoteResult === "ok" && <p className="status-ok" style={{ margin: "6px 0 0 0" }}>✓ Remote Gateway Connected</p>}
        {remoteResult === "unreachable" && <p className="status-error" style={{ margin: "6px 0 0 0" }}>✗ Could not reach Remote Gateway</p>}
      </div>

      <button
        onClick={handleTestAndSave}
        disabled={checking || (!baseUrl && !remoteUrl)}
        style={{ width: "100%", padding: "12px 16px", fontWeight: "bold" }}
      >
        {checking ? "Testing Connections…" : "Test & Save Both Profiles"}
      </button>

      {/* Screen Context & Permissions */}
      <div style={{ marginTop: 24, padding: 12, border: "1px solid #444", borderRadius: 8 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={screenContext}
            onChange={(e) => handleToggleScreenContext(e.target.checked)}
          />
          <strong>Enable screen context</strong>
        </label>
        <p className="hint" style={{ marginTop: 8 }}>
          Allows selecting allowed apps in the Status tab to capture on-screen context for PiecesOS.
        </p>
        {screenContext && (
          <div style={{ marginTop: 8 }}>
            {accessibilityGranted ? (
              <p className="status-ok" style={{ margin: 0 }}>Accessibility permission granted.</p>
            ) : (
              <>
                <p className="status-error" style={{ margin: "0 0 8px 0" }}>
                  Accessibility permission not granted yet.
                </p>
                <button onClick={() => AccessibilityScanner.openAccessibilitySettings()}>
                  Open Accessibility Settings
                </button>
              </>
            )}
          </div>
        )}
      </div>

      <div style={{ marginTop: 16, padding: 12, border: "1px solid #444", borderRadius: 8 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={shizukuToolkit}
            onChange={(e) => handleToggleShizuku(e.target.checked)}
          />
          <strong>Enable Shizuku toolkit (advanced)</strong>
        </label>
        <p className="hint" style={{ marginTop: 8 }}>
          Enables privileged diagnostic commands via Shizuku. Requires Shizuku daemon running.
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
