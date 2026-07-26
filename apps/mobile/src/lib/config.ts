import { Preferences } from "@capacitor/preferences";

// Single source of truth for the proxy connection: base URL + bearer token,
// entered once on the Setup screen and persisted for reuse. Mirrors the
// apiUrl()/API_BASE_URL pattern from bear-house-classic's src/lib/api.ts —
// same reasoning: the native webview has no implicit relative-fetch target,
// so the target must always be explicit and user-supplied (there's no
// single production origin here — this is a LAN device the user points at).
//
// Uses Capacitor's Preferences plugin (native storage) rather than
// localStorage — this token is a real credential, not UI state.

const PROXY_BASE_URL_KEY = "pieces-android:proxyBaseUrl";
const PROXY_TOKEN_KEY = "pieces-android:proxyToken";

export async function getProxyBaseUrl(): Promise<string | null> {
  const { value } = await Preferences.get({ key: PROXY_BASE_URL_KEY });
  return value;
}

export async function setProxyBaseUrl(url: string): Promise<void> {
  await Preferences.set({ key: PROXY_BASE_URL_KEY, value: url.replace(/\/$/, "") });
}

export async function getProxyToken(): Promise<string | null> {
  const { value } = await Preferences.get({ key: PROXY_TOKEN_KEY });
  return value;
}

export async function setProxyToken(token: string): Promise<void> {
  await Preferences.set({ key: PROXY_TOKEN_KEY, value: token });
}

export async function isConfigured(): Promise<boolean> {
  const [url, token] = await Promise.all([getProxyBaseUrl(), getProxyToken()]);
  return Boolean(url && token);
}

export async function clearConfig(): Promise<void> {
  await Promise.all([Preferences.remove({ key: PROXY_BASE_URL_KEY }), Preferences.remove({ key: PROXY_TOKEN_KEY })]);
}
