import { HashRouter, Routes, Route, Navigate } from "react-router-dom";
import Setup from "./pages/Setup";
import Status from "./pages/Status";
import Ask from "./pages/Ask";
import Recent from "./pages/Recent";

// HashRouter, not BrowserRouter: Capacitor serves the app from a local
// file/asset origin with no server-side routing, so path-based routes would
// 404 on refresh/deep link. Same class of problem bear-house-classic solved
// with apiUrl() for API calls — this is the routing equivalent.
export default function App() {
  return (
    <HashRouter>
      <Routes>
        <Route path="/" element={<Navigate to="/setup" replace />} />
        <Route path="/setup" element={<Setup />} />
        <Route path="/status" element={<Status />} />
        <Route path="/ask" element={<Ask />} />
        <Route path="/recent" element={<Recent />} />
      </Routes>
    </HashRouter>
  );
}
