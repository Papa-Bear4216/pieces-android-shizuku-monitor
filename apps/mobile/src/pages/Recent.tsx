import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import {
  getRecentConversations,
  getRecentAssets,
  searchAssets,
  getAsset,
  getConversationMessages,
  ProxyNotConfiguredError,
  HomeNodeUnreachableError,
  type ConversationSummary,
  type AssetSummary,
  type ConversationMessage,
} from "../lib/api";
import { recordEvent } from "../lib/usage";
import { flushUsageEvents } from "../lib/flush";

type State =
  | { kind: "loading" }
  | { kind: "loaded"; conversations: ConversationSummary[]; assets: AssetSummary[] }
  | { kind: "not-configured" }
  | { kind: "home-offline"; message: string }
  | { kind: "error"; message: string };

export default function Recent() {
  const navigate = useNavigate();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<AssetSummary[] | null>(null);
  
  // Track expanded assets
  const [expandedAsset, setExpandedAsset] = useState<string | null>(null);
  const [assetContent, setAssetContent] = useState<string>("");

  // Track expanded conversations
  const [expandedConversation, setExpandedConversation] = useState<string | null>(null);
  const [conversationMessages, setConversationMessages] = useState<ConversationMessage[] | null>(null);
  const [conversationLoadingError, setConversationLoadingError] = useState<string>("");

  async function load() {
    setState({ kind: "loading" });
    try {
      const [conversations, assets] = await Promise.all([getRecentConversations(), getRecentAssets()]);
      setState({ kind: "loaded", conversations, assets });
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
    recordEvent({ type: "screen_view", screen: "recent", timestamp: new Date().toISOString() });
    flushUsageEvents();
  }, []);

  async function handleSearch() {
    if (!query.trim()) {
      setSearchResults(null);
      return;
    }
    try {
      const results = await searchAssets(query);
      setSearchResults(results);
      recordEvent({
        type: "search",
        screen: "recent",
        query,
        resultCount: results.length,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      setSearchResults([]);
    } finally {
      flushUsageEvents();
    }
  }

  async function handleExpandAsset(id: string) {
    if (expandedAsset === id) {
      setExpandedAsset(null); // Collapse
      return;
    }
    
    setExpandedAsset(id);
    setAssetContent("Loading content...");
    
    try {
      const content = await getAsset(id);
      setAssetContent(content);
    } catch (err: any) {
      setAssetContent("Failed to load: " + err.message);
    }
  }

  async function handleExpandConversation(id: string) {
    if (expandedConversation === id) {
      setExpandedConversation(null); // Collapse
      return;
    }
    
    setExpandedConversation(id);
    setConversationMessages(null);
    setConversationLoadingError("");
    
    try {
      const messages = await getConversationMessages(id);
      setConversationMessages(messages);
    } catch (err: any) {
      setConversationLoadingError("Failed to load: " + err.message);
    }
  }

  return (
    <div className="page">
      <h1>Recent</h1>

      <label>
        Search assets
        <input
          type="text"
          placeholder="search…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSearch()}
        />
      </label>
      <button onClick={handleSearch} disabled={!query.trim()}>
        Search
      </button>

      {state.kind === "loading" && <p>Loading…</p>}

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

      {searchResults !== null && (
        <section>
          <h2>Search results</h2>
          {searchResults.length === 0 && <p>No matches.</p>}
          <ul>
            {searchResults.map((a) => (
              <li key={a.id} style={{ marginBottom: 12, border: "1px solid #ccc", padding: 8, borderRadius: 4 }}>
                <div onClick={() => handleExpandAsset(a.id)} style={{ cursor: "pointer" }}>
                  <strong>{a.name}</strong> — {a.updated}
                  <span style={{ float: "right" }}>{expandedAsset === a.id ? "▲" : "▼"}</span>
                </div>
                {expandedAsset === a.id && (
                  <pre style={{ marginTop: 8, padding: 8, background: "#f4f4f4", color: "black", whiteSpace: "pre-wrap", overflowX: "auto" }}>
                    {assetContent}
                  </pre>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {state.kind === "loaded" && (
        <>
          <section>
            <h2>Conversations</h2>
            <ul>
              {state.conversations.slice(0, 20).map((c) => (
                <li key={c.id} style={{ marginBottom: 12, border: "1px solid #ccc", padding: 8, borderRadius: 4 }}>
                  <div onClick={() => handleExpandConversation(c.id)} style={{ cursor: "pointer" }}>
                    <strong>{c.name}</strong> — {c.updated}
                    <span style={{ float: "right" }}>{expandedConversation === c.id ? "▲" : "▼"}</span>
                  </div>
                  {expandedConversation === c.id && (
                    <div style={{ marginTop: 8, padding: 8, background: "#f4f4f4", color: "black", borderRadius: 4 }}>
                      {conversationLoadingError && <p style={{color: "red"}}>{conversationLoadingError}</p>}
                      {!conversationMessages && !conversationLoadingError && <p>Loading timeline...</p>}
                      {conversationMessages && conversationMessages.length === 0 && <p>No messages in this conversation.</p>}
                      {conversationMessages && conversationMessages.map((msg) => {
                        const isUser = msg.role.toLowerCase() === "user";
                        return (
                          <div key={msg.id} style={{
                            display: "flex",
                            flexDirection: "column",
                            alignItems: isUser ? "flex-end" : "flex-start",
                            marginBottom: 12
                          }}>
                            <div style={{
                              maxWidth: "85%",
                              padding: "10px 14px",
                              borderRadius: "18px",
                              backgroundColor: isUser ? "#007AFF" : "#E5E5EA",
                              color: isUser ? "#FFF" : "#000",
                              borderBottomRightRadius: isUser ? "4px" : "18px",
                              borderBottomLeftRadius: isUser ? "18px" : "4px",
                              boxShadow: "0 1px 2px rgba(0,0,0,0.1)"
                            }}>
                              <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                                {msg.text || <i style={{ opacity: 0.7 }}>(No text content)</i>}
                              </div>
                            </div>
                            <small style={{ color: "#8e8e93", marginTop: 4, fontSize: "0.75rem", padding: "0 4px" }}>
                              {msg.timestamp}
                            </small>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h2>Assets</h2>
            <ul>
              {state.assets.slice(0, 100).map((a) => (
                <li key={a.id} style={{ marginBottom: 12, border: "1px solid #ccc", padding: 8, borderRadius: 4 }}>
                  <div onClick={() => handleExpandAsset(a.id)} style={{ cursor: "pointer" }}>
                    <strong>{a.name}</strong> — {a.updated}
                    <span style={{ float: "right" }}>{expandedAsset === a.id ? "▲" : "▼"}</span>
                  </div>
                  {expandedAsset === a.id && (
                    <pre style={{ marginTop: 8, padding: 8, background: "#f4f4f4", color: "black", whiteSpace: "pre-wrap", overflowX: "auto" }}>
                      {assetContent}
                    </pre>
                  )}
                </li>
              ))}
            </ul>
          </section>
        </>
      )}

      <nav className="tabbar">
        <button onClick={() => navigate("/setup")}>Setup</button>
        <button onClick={() => navigate("/status")}>Status</button>
        <button onClick={() => navigate("/ask")}>Ask</button>
      </nav>
    </div>
  );
}
