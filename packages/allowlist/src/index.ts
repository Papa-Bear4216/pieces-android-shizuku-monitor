// Deny-by-default. Every entry here must trace back to a "Confirmed working"
// row in docs/ALLOWED_ROUTES.md. Do not add a route here without repeating
// the live-curl-evidence step documented there first.
//
// Single source of truth shared by BOTH Plan A's LAN proxy (apps/proxy) and
// Plan B's remote gateway (apps/pieces-gateway). Import this, do not copy it —
// two independently-maintained allowlists drift out of sync within a week.

export interface AllowedRoute {
  method: "GET" | "POST";
  // Mobile-facing path the phone calls.
  mobilePath: string;
  // Real PiecesOS path this proxies to.
  piecesPath: string;
}

export const ALLOWED_ROUTES: AllowedRoute[] = [
  { method: "GET", mobilePath: "/mobile/status/health", piecesPath: "/.well-known/health" },
  { method: "GET", mobilePath: "/mobile/status/version", piecesPath: "/.well-known/version" },
  { method: "GET", mobilePath: "/mobile/recent/conversations", piecesPath: "/conversations" },
  { method: "GET", mobilePath: "/mobile/recent/assets", piecesPath: "/assets" },
  { method: "GET", mobilePath: "/mobile/recent/search", piecesPath: "/assets/search" },
  // Ask is handled specially by each caller (not a 1:1 proxy passthrough) because
  // it needs the typed unavailable-vs-answered handling from PiecesClient.ask().
];

export function findAllowedRoute(method: string, mobilePath: string): AllowedRoute | undefined {
  return ALLOWED_ROUTES.find((r) => r.method === method && r.mobilePath === mobilePath);
}
