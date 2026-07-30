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
const SHIZUKU_ENABLED_KEY = "pieces-android:shizukuToolkitEnabled";
const SCREEN_CONTEXT_ENABLED_KEY = "pieces-android:screenContextEnabled";

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

// Off by default. The Shizuku toolkit (privileged shell diagnostics + the
// system-wide accessibility screen-text capture) is powerful enough that it
// must be an explicit, informed opt-in — never auto-enabled just because the
// Shizuku app happens to be installed and granted.
export async function isShizukuToolkitEnabled(): Promise<boolean> {
  const { value } = await Preferences.get({ key: SHIZUKU_ENABLED_KEY });
  return value === "true";
}

export async function setShizukuToolkitEnabled(enabled: boolean): Promise<void> {
  await Preferences.set({ key: SHIZUKU_ENABLED_KEY, value: String(enabled) });
}

// Independent of Shizuku. Screen-context capture only needs Android's
// standard Accessibility Service permission — a manual one-time toggle in
// system Settings, same mechanism screen readers and password managers use.
// Off by default, same reasoning as the Shizuku toolkit: this is powerful
// enough that it must be an explicit, informed opt-in.
export async function isScreenContextEnabled(): Promise<boolean> {
  const { value } = await Preferences.get({ key: SCREEN_CONTEXT_ENABLED_KEY });
  return value === "true";
}

export async function setScreenContextEnabled(enabled: boolean): Promise<void> {
  await Preferences.set({ key: SCREEN_CONTEXT_ENABLED_KEY, value: String(enabled) });
}
