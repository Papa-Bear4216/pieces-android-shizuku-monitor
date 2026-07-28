import { useEffect, useState } from "react";
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
  const [cmd, setCmd] = useState("dumpsys battery");
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
      <div style={{ position: 'fixed', bottom: 20, right: 20, zIndex: 9999, display: 'flex', flexDirection: 'column', gap: 8, background: 'rgba(0,0,0,0.8)', padding: 16, borderRadius: 8, maxWidth: 320 }}>
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
              alert("Executed! Check JS console for output.");
            } catch(e: any) {
              alert("Error: " + (e.message || String(e)));
            }
          }} 
          style={{ padding: '8px 16px', background: 'green', color: 'white', borderRadius: 8, border: 'none', cursor: 'pointer', fontWeight: 'bold' }}
        >
          Execute Command
        </button>
      </div>
    </>
  );
}
