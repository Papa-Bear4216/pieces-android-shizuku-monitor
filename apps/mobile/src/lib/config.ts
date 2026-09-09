import { Preferences } from "@capacitor/preferences";

// Dual-profile connection configuration:
// - Plan A (LAN / USB): Fast local path (e.g. http://192.168.1.x:8787 or http://127.0.0.1:8787)
// - Plan B (Remote): Automatic fallback via gateway/Tailscale (e.g. https://pieces.yourdomain.com)
//
// Uses Capacitor's Preferences plugin (native storage) rather than localStorage.

const PROXY_BASE_URL_KEY = "pieces-android:proxyBaseUrl";
const PROXY_TOKEN_KEY = "pieces-android:proxyToken";

const REMOTE_GATEWAY_URL_KEY = "pieces-android:remoteGatewayUrl";
const REMOTE_GATEWAY_TOKEN_KEY = "pieces-android:remoteGatewayToken";

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

export async function getRemoteGatewayUrl(): Promise<string | null> {
  const { value } = await Preferences.get({ key: REMOTE_GATEWAY_URL_KEY });
  return value;
}

export async function setRemoteGatewayUrl(url: string): Promise<void> {
  await Preferences.set({ key: REMOTE_GATEWAY_URL_KEY, value: url.replace(/\/$/, "") });
}

export async function getRemoteGatewayToken(): Promise<string | null> {
  const { value } = await Preferences.get({ key: REMOTE_GATEWAY_TOKEN_KEY });
  return value;
}

export async function setRemoteGatewayToken(token: string): Promise<void> {
  await Preferences.set({ key: REMOTE_GATEWAY_TOKEN_KEY, value: token });
}

export interface ConnectionTarget {
  baseUrl: string;
  token: string;
  mode: "lan" | "remote";
}

export async function getConnectionTargets(): Promise<ConnectionTarget[]> {
  const [lanUrl, lanToken, remoteUrl, remoteToken] = await Promise.all([
    getProxyBaseUrl(),
    getProxyToken(),
    getRemoteGatewayUrl(),
    getRemoteGatewayToken(),
  ]);

  const targets: ConnectionTarget[] = [];
  if (lanUrl && lanToken) {
    targets.push({ baseUrl: lanUrl, token: lanToken, mode: "lan" });
  }
  if (remoteUrl && remoteToken) {
    targets.push({ baseUrl: remoteUrl, token: remoteToken, mode: "remote" });
  }
  return targets;
}

export async function isConfigured(): Promise<boolean> {
  const targets = await getConnectionTargets();
  return targets.length > 0;
}

export async function clearConfig(): Promise<void> {
  await Promise.all([
    Preferences.remove({ key: PROXY_BASE_URL_KEY }),
    Preferences.remove({ key: PROXY_TOKEN_KEY }),
    Preferences.remove({ key: REMOTE_GATEWAY_URL_KEY }),
    Preferences.remove({ key: REMOTE_GATEWAY_TOKEN_KEY }),
  ]);
}

export async function isShizukuToolkitEnabled(): Promise<boolean> {
  const { value } = await Preferences.get({ key: SHIZUKU_ENABLED_KEY });
  return value === "true";
}

export async function setShizukuToolkitEnabled(enabled: boolean): Promise<void> {
  await Preferences.set({ key: SHIZUKU_ENABLED_KEY, value: String(enabled) });
}

export async function isScreenContextEnabled(): Promise<boolean> {
  const { value } = await Preferences.get({ key: SCREEN_CONTEXT_ENABLED_KEY });
  return value === "true";
}

export async function setScreenContextEnabled(enabled: boolean): Promise<void> {
  await Preferences.set({ key: SCREEN_CONTEXT_ENABLED_KEY, value: String(enabled) });
}
