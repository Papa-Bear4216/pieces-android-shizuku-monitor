import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { getProxyBaseUrl, getProxyToken, setProxyBaseUrl, setProxyToken } from "../lib/config";
import { checkProxyHealth } from "../lib/api";

export default function Setup() {
  const navigate = useNavigate();
  const [baseUrl, setBaseUrl] = useState("");
  const [token, setToken] = useState("");
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<"idle" | "ok" | "unreachable">("idle");

  useEffect(() => {
    (async () => {
      const [savedUrl, savedToken] = await Promise.all([getProxyBaseUrl(), getProxyToken()]);
      if (savedUrl) setBaseUrl(savedUrl);
      if (savedToken) setToken(savedToken);
    })();
  }, []);

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
        <strong>Away from home:</strong> https://pieces.dysfunctionjunction.xyz and a device token from
        the gateway's enroll command. This path fails closed — if the home PC is offline or unreachable,
        requests return an explicit error rather than hanging.
      </p>

      <label>
        Server address
        <input
          type="text"
          placeholder="http://192.168.1.20:8787 or https://pieces.dysfunctionjunction.xyz"
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

      <nav className="tabbar">
        <button onClick={() => navigate("/status")}>Status</button>
        <button onClick={() => navigate("/ask")}>Ask</button>
        <button onClick={() => navigate("/recent")}>Recent</button>
      </nav>
    </div>
  );
}
