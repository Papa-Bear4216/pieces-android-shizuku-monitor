import { useEffect, useState } from "react";
import { HashRouter, Routes, Route, Navigate } from "react-router-dom";
import Setup from "./pages/Setup";
import Status from "./pages/Status";
import Ask from "./pages/Ask";
import Recent from "./pages/Recent";
import { flushUsageEvents } from "./lib/flush";
import { isShizukuToolkitEnabled } from "./lib/config";
import { registerPlugin, Capacitor } from "@capacitor/core";

const ShizukuMonitor = registerPlugin<any>('ShizukuMonitor');

const USAGE_FLUSH_INTERVAL_MS = 5 * 60 * 1000;

// HashRouter, not BrowserRouter: Capacitor serves the app from a local
// file/asset origin with no server-side routing, so path-based routes would
// 404 on refresh/deep link. Same class of problem bear-house-classic solved
// with apiUrl() for API calls — this is the routing equivalent.
export default function App() {
  const [shizukuOffline, setShizukuOffline] = useState(false);

  useEffect(() => {
    // Re-enable the accessibility service via Shizuku on launch if it got
    // dropped (e.g. after a reboot) — but only for users who opted into the
    // Shizuku toolkit specifically via Setup. Screen context on its own
    // (isScreenContextEnabled) doesn't need this at all: without Shizuku,
    // Accessibility is a normal Android Settings toggle that the user
    // enables manually once, and it just stays enabled — no re-arming logic
    // needed since nothing here can silently disable it.
    async function checkShizuku() {
      const enabled = await isShizukuToolkitEnabled();
      if (!enabled) return;

      try {
        const res = await ShizukuMonitor.checkPermission();
        if (res.status !== "granted") {
          setShizukuOffline(true);
        } else {
          await ShizukuMonitor.enableAccessibilityService();
        }
      } catch {
        setShizukuOffline(true);
      }
    }
    if (Capacitor.isNativePlatform()) checkShizuku();

    // Backstop flush for events queued during a long session on one screen
    // (e.g. repeated searches without navigating away) — per-screen mount
    // already flushes on every navigation, this just covers the gap.
    const id = setInterval(flushUsageEvents, USAGE_FLUSH_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  return (
    <>
      {shizukuOffline && (
        <div style={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          background: "linear-gradient(to right, #ff4e50, #f9d423)",
          color: "#fff",
          padding: "16px",
          textAlign: "center",
          fontWeight: "bold",
          zIndex: 9999,
          boxShadow: "0 4px 6px rgba(0,0,0,0.1)",
          fontFamily: "system-ui, sans-serif"
        }}>
          ⚠️ Shizuku is Offline. Please restart it via Wireless Debugging (your device may have rebooted).
          <button 
            onClick={() => setShizukuOffline(false)} 
            style={{ marginLeft: "12px", background: "rgba(0,0,0,0.2)", border: "none", color: "white", padding: "4px 8px", borderRadius: "4px" }}
          >
            Dismiss
          </button>
        </div>
      )}
      <HashRouter>
        <Routes>
          <Route path="/" element={<Navigate to="/setup" replace />} />
          <Route path="/setup" element={<Setup />} />
          <Route path="/status" element={<Status />} />
          <Route path="/ask" element={<Ask />} />
          <Route path="/recent" element={<Recent />} />
        </Routes>
      </HashRouter>
    </>
  );
}
