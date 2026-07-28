import { useEffect } from "react";
import { HashRouter, Routes, Route, Navigate } from "react-router-dom";
import { registerPlugin } from "@capacitor/core";

const ShizukuMonitor = registerPlugin<any>('ShizukuMonitor');
import Setup from "./pages/Setup";
import Status from "./pages/Status";
import Ask from "./pages/Ask";
import Recent from "./pages/Recent";
import { flushUsageEvents } from "./lib/flush";

const USAGE_FLUSH_INTERVAL_MS = 5 * 60 * 1000;

// HashRouter, not BrowserRouter: Capacitor serves the app from a local
// file/asset origin with no server-side routing, so path-based routes would
// 404 on refresh/deep link. Same class of problem bear-house-classic solved
// with apiUrl() for API calls — this is the routing equivalent.
export default function App() {
  useEffect(() => {
    // Backstop flush for events queued during a long session on one screen
    // (e.g. repeated searches without navigating away) — per-screen mount
    // already flushes on every navigation, this just covers the gap.
    const id = setInterval(flushUsageEvents, USAGE_FLUSH_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  return (
    <>
      <HashRouter>
        <Routes>
          <Route path="/" element={<Navigate to="/setup" replace />} />
          <Route path="/setup" element={<Setup />} />
          <Route path="/status" element={<Status />} />
          <Route path="/ask" element={<Ask />} />
          <Route path="/recent" element={<Recent />} />
        </Routes>
      </HashRouter>
      <button 
        onClick={async () => {
          try {
            const res = await ShizukuMonitor.getMetrics();
            console.log(res.metrics);
            alert("Shizuku metrics pooled successfully! Check logs.");
          } catch(e) {
            alert("Shizuku error: " + JSON.stringify(e));
          }
        }} 
        style={{ position: 'fixed', bottom: 20, right: 20, zIndex: 9999, padding: '12px 24px', background: 'blue', color: 'white', borderRadius: 8 }}
      >
        Test Shizuku
      </button>
    </>
  );
}
