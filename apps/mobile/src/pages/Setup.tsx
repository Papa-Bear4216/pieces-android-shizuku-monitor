import { useState, useEffect } from "react";
import { useNavigate } from "react-router";
import { registerPlugin } from "@capacitor/core";
import { BarcodeScanner } from "@capacitor-mlkit/barcode-scanning";

const ShizukuMonitor = registerPlugin<any>('ShizukuMonitor');
const AccessibilityScanner = registerPlugin<any>('AccessibilityScanner');
import {
  getProxyBaseUrl, getProxyToken, setProxyBaseUrl, setProxyToken,
  isShizukuToolkitEnabled, setShizukuToolkitEnabled,
  isScreenContextEnabled, setScreenContextEnabled,
} from "../lib/config";
import { checkProxyHealth, getStatus, HomeNodeUnreachableError } from "../lib/api";
import { recordEvent, classifyMode } from "../lib/usage";
import { flushUsageEvents } from "../lib/flush";
import { parseConnectionQrPayload } from "../lib/connectionQr";
import { decodeJwtForDisplay, formatExpiry } from "../lib/jwtDisplay";

export default function Setup() {
  const navigate = useNavigate();
  const [baseUrl, setBaseUrl] = useState("");
  const [token, setToken] = useState("");
  const [checking, setChecking] = useState(false);
  // "ok" = full end-to-end chain verified (proxy/gateway -> PiecesOS).
  // "server-only" = the proxy/gateway process answers but PiecesOS itself
  // doesn't - previously this was indistinguishable from "ok", since the
  // save flow only ever checked checkProxyHealth()'s unauthenticated
  // /mobile/health, which proves nothing about the home PC. Found in
  // practice 2026-08-29: Setup said "Connected" while Status simultaneously
  // said "Home PC is offline."
  const [result, setResult] = useState<"idle" | "ok" | "server-only" | "unreachable">("idle");
  const [scanError, setScanError] = useState<string | null>(null);
  const [shizukuToolkit, setShizukuToolkit] = useState(false);
  const [screenContext, setScreenContext] = useState(false);
  const [accessibilityGranted, setAccessibilityGranted] = useState(false);

  useEffect(() => {
    (async () => {
      const [savedUrl, savedToken, toolkitEnabled, contextEnabled] = await Promise.all([
        getProxyBaseUrl(), getProxyToken(), isShizukuToolkitEnabled(), isScreenContextEnabled(),
      ]);
      if (savedUrl) setBaseUrl(savedUrl);
      if (savedToken) setToken(savedToken);
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

  // Runs AFTER the shallow checkProxyHealth() pass and AFTER saving, since
  // getStatus() reads from the just-saved config, not from function
  // arguments - this proves the FULL chain (proxy/gateway -> PiecesOS), not
  // just that the gateway process itself is up. Never throws: a deep-check
  // failure downgrades the already-"ok" shallow result to "server-only"
  // rather than failing setup entirely, since the shallow health check
  // already succeeded and the config is already saved correctly.
  async function deepCheckAfterSave(): Promise<"ok" | "server-only"> {
    try {
      await getStatus();
      return "ok";
    } catch (e) {
      if (e instanceof HomeNodeUnreachableError) return "server-only";
      // Any other error here (unexpected shape, etc.) is still evidence
      // the deep chain isn't fully healthy - treat it the same way rather
      // than silently claiming "ok".
      return "server-only";
    }
  }

  async function handleScanToConnect() {
    setScanError(null);
    try {
      const { camera } = await BarcodeScanner.checkPermissions();
      if (camera !== "granted" && camera !== "limited") {
        const req = await BarcodeScanner.requestPermissions();
        if (req.camera !== "granted" && req.camera !== "limited") {
          setScanError("Camera permission is required to scan the connection code.");
          return;
        }
      }

      const { barcodes } = await BarcodeScanner.scan();
      const raw = barcodes[0]?.rawValue;
      if (!raw) {
        // User backed out of the scanner without capturing a code - not an
        // error worth surfacing, just a no-op.
        return;
      }

      const { baseUrl: scannedUrl, token: scannedToken } = parseConnectionQrPayload(raw);
      setBaseUrl(scannedUrl);
      setToken(scannedToken);
      // Mirrors handleTestAndSave's own test-then-save sequencing, so a
      // successful scan behaves exactly like a successful manual entry +
      // tap of "Test & Save" - no separate save step for the user to forget.
      setChecking(true);
      setResult("idle");
      try {
        const reachable = await checkProxyHealth(scannedUrl);
        if (!reachable) {
          setResult("unreachable");
          return;
        }
        await setProxyBaseUrl(scannedUrl);
        await setProxyToken(scannedToken);
        // Deep check (up to ~35s on a retry) deliberately happens while
        // `checking` is still true - button stays disabled and shows
        // "Checking…" for the FULL flow, not just the fast shallow check.
        // Previously setChecking(false) fired here, which re-enabled the
        // button and let a second scan start concurrently with this one
        // still finishing.
        setResult(await deepCheckAfterSave());
        await recordEvent({
          type: "setup_saved",
          screen: "setup",
          mode: classifyMode(scannedUrl),
          timestamp: new Date().toISOString(),
        });
        flushUsageEvents();
      } finally {
        setChecking(false);
      }
    } catch (e) {
      setScanError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleTestAndSave() {
    setChecking(true);
    setResult("idle");
    const reachable = await checkProxyHealth(baseUrl);
    if (!reachable) {
      setChecking(false);
      setResult("unreachable");
      return;
    }
    await setProxyBaseUrl(baseUrl);
    await setProxyToken(token);
    setResult(await deepCheckAfterSave());
    setChecking(false);

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

      <button onClick={handleScanToConnect} disabled={checking}>
        Scan to Connect
      </button>
      <p className="hint setup-note">
        Fastest option: scan a connection code shown by the server (e.g. a companion
        setup script running on your PC). Fills in both fields below and saves
        automatically — no typing or copy-paste needed.
      </p>
      {scanError && <p className="status-error">{scanError}</p>}

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
      {(() => {
        // Only the gateway/remote token is a JWT (365-day expiry, see
        // apps/pieces-gateway/src/jwt.ts) - the LAN proxy's bearer token is
        // opaque random bytes with no expiry concept, so decodeJwtForDisplay
        // correctly returns null for it and nothing renders here for that case.
        const info = token ? decodeJwtForDisplay(token) : null;
        if (!info?.expiresAt) return null;
        const expired = info.expiresAt.getTime() < Date.now();
        return (
          <p className={`setup-note ${expired ? "status-error" : "hint"}`}>
            Remote token {formatExpiry(info.expiresAt)}
            {expired && " — scan a fresh connection code, or re-enroll this device."}
          </p>
        );
      })()}

      <button onClick={handleTestAndSave} disabled={checking || !baseUrl || !token}>
        {checking ? "Checking…" : "Test & Save"}
      </button>

      {result === "ok" && <p className="status-ok">Connected. Saved.</p>}
      {result === "server-only" && (
        <>
          <p className="status-ok">Saved.</p>
          <p className="status-error">
            But the server can't reach your home PC right now (it may just be starting up, or
            genuinely offline). Check Status for details — you don't need to redo Setup, this
            usually clears on its own.
          </p>
        </>
      )}
      {result === "unreachable" && <p className="status-error">Could not reach proxy at that address.</p>}

      <div className="panel">
        <label className="toggle-row">
          <input
            type="checkbox"
            checked={screenContext}
            onChange={(e) => handleToggleScreenContext(e.target.checked)}
          />
          <strong>Enable screen context</strong>
        </label>
        <p className="hint" style={{ margin: 0 }}>
          Off by default. Turning this on lets you pick specific apps (in the Status tab's
          app picker) whose on-screen text gets captured and sent to PiecesOS as context.
          No Shizuku required — just Android's standard Accessibility permission, same
          mechanism screen readers use. You'll need to grant it once in system Settings.
        </p>
        {screenContext && (
          <div>
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

      <div className="panel">
        <label className="toggle-row">
          <input
            type="checkbox"
            checked={shizukuToolkit}
            onChange={(e) => handleToggleShizuku(e.target.checked)}
          />
          <strong>Enable Shizuku toolkit (advanced)</strong>
        </label>
        <p className="hint" style={{ margin: 0 }}>
          Off by default. Turning this on lets the app run privileged diagnostic commands
          via Shizuku, and auto-re-enable screen context's Accessibility permission if it
          gets dropped (e.g. after a reboot) instead of you having to re-grant it manually.
          Not required for screen context itself — only useful if you want the diagnostics
          toolkit or the auto-re-enable convenience. Requires the Shizuku app installed and
          its daemon running.
        </p>
      </div>

      <nav className="tabbar">
        <button onClick={() => navigate("/status")}>Status</button>
        <button onClick={() => navigate("/ask")}>Ask</button>
        <button onClick={() => navigate("/recent")}>Recent</button>
        <button onClick={() => navigate("/search")}>Search</button>
      </nav>
    </div>
  );
}
