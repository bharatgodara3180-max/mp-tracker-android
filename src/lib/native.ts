/**
 * Android app (Capacitor) support. Inside the app the web files are local (http://localhost),
 * so the MP Tracker server address is chosen once in the app setup screen.
 */
export type AppMode = 'gate' | 'supervisor' | 'link';
const SERVER_KEY = 'mp-app-server';
const MODE_KEY = 'mp-app-mode';
const LINK_KEY = 'sfxbm-open-link';
const OPENED_KEY = 'sfxbm-opened';       // sessionStorage: the saved link was already opened in this app run

export function isNativeApp(): boolean {
  const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return !!cap?.isNativePlatform?.();
}

const get = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const set = (k: string, v: string | null) => { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch { /* ignore */ } };

/** Server base like "http://192.168.1.20:8010/" or "https://x.ngrok-free.dev/MP/" (always ends with "/"). */
export const appServer = () => (isNativeApp() ? get(SERVER_KEY) : null);   // nothing is pre-filled: the user enters the link
export const appMode = () => (isNativeApp() ? (get(MODE_KEY) as AppMode | null) ?? (get(SERVER_KEY) ? 'supervisor' : null) : null);
export function saveAppSetup(server: string | null, mode: AppMode | null) { set(SERVER_KEY, server); set(MODE_KEY, mode); }

export function normalizeServer(input: string): string | null {
  let v = input.trim();
  if (!v) return null;
  if (!/^https?:\/\//i.test(v)) v = `http://${v}`;
  try {
    const u = new URL(v);
    let path = u.pathname.replace(/[^/]*\.[^/]*$/, '');   // drop a file name like "index.html", keep folders like "/MP"
    if (!path.endsWith('/')) path += '/';
    return `${u.protocol}//${u.host}${path}`;
  } catch { return null; }
}

/** Gate link "https://host/MP/#/dc-gate?d=CODE&k=KEY" -> parts. */
export function parseGateLink(link: string): { server: string | null; device: string; key: string } | null {
  const t = link.trim();
  const d = /[?&#]d=([^&#\s]+)/.exec(t)?.[1];
  const k = /[?&#]k=([^&#\s]+)/.exec(t)?.[1];
  if (!d || !k) return null;
  const base = t.split('#')[0].split('?')[0];
  const server = /^https?:\/\//i.test(base) ? normalizeServer(base) : null;
  return { server, device: decodeURIComponent(d).toUpperCase(), key: decodeURIComponent(k) };
}

export const isLocalhostServer = (s: string | null) => !!s && /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/)/i.test(s);

// ---- SFXBM: one app, any link ------------------------------------------------------------
/** Typed text -> full URL ("abc.ngrok-free.dev/ASSETS" -> https, "192.168.1.5:8060" -> http), or null if it is not a link. */
export function normalizeLink(input: string): string | null {
  let v = input.trim();
  if (!v || /\s/.test(v)) return null;
  if (!/^https?:\/\//i.test(v)) v = `${/^(localhost|\d{1,3}(\.\d{1,3}){3})(:|\/|$)/i.test(v) || /:\d+(\/|$)/.test(v) ? 'http' : 'https'}://${v}`;
  try {
    const u = new URL(v);
    if (!u.hostname.includes('.') && u.hostname !== 'localhost') return null;
    return u.toString();
  } catch { return null; }
}

/** MP Tracker (gate link, :8010, /MP or a bare host) keeps the built-in screens; any other link (Asset Desk /ASSETS ...) opens as it is. */
export function isMpLink(link: string): boolean {
  if (parseGateLink(link)) return true;
  try {
    const u = new URL(link);
    if (u.port === '8010') return true;
    const p = u.pathname.replace(/\/+$/, '');
    return p === '' ? u.port === '' : /^\/mp(\/|$)/i.test(p);
  } catch { return false; }
}

export const savedLink = () => get(LINK_KEY);
export function saveOpenLink(link: string) { set(LINK_KEY, link); set(SERVER_KEY, null); set(MODE_KEY, 'link'); }
export const alreadyOpenedThisRun = () => { try { return sessionStorage.getItem(OPENED_KEY) === '1'; } catch { return false; } };
/** Open the link inside the app. The Android Back button comes back to the link screen. */
export function openLinkNow(link: string) {
  try { sessionStorage.setItem(OPENED_KEY, '1'); } catch { /* ignore */ }
  window.location.href = link;
}
