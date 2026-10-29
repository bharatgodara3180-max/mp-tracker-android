/**
 * Client for the self-hosted MP Tracker server.
 * All URLs are relative to where the app is served, so the same build works at
 * http://<pc>:8010/  and behind the pendency server proxy at https://<public>/MP/.
 */
import type { RpcResult } from './types';
import { appServer, isNativeApp } from './native';

const TOKEN_KEY = 'mp-token';

export class ApiError extends Error {
  constructor(message: string, public code?: string, public status?: number) { super(message); }
}

export function apiBase(): string {
  const server = appServer();                                     // Android app: server chosen in app setup
  if (server) return `${server}api/`;
  const dir = window.location.pathname.replace(/[^/]*$/, '');   // e.g. "/" or "/MP/"
  return `${dir}api/`;
}

export const token = {
  get: () => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } },
  set: (t: string | null) => { try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ } },
};

/** Gate tablet opened through its fixed link: it authenticates as the device, not as a user. */
let kioskToken: string | null = null;
export const setKioskToken = (t: string | null) => { kioskToken = t; };
/** A staff member who signs in on the gate tablet just to enrol a face (kept in memory, cleared when done). */
let staffToken: string | null = null;
export const setStaffToken = (t: string | null) => { staffToken = t; };
const authToken = () => staffToken ?? kioskToken ?? token.get();

type Listener = () => void;
const unauthorizedListeners = new Set<Listener>();
export const onUnauthorized = (l: Listener) => { unauthorizedListeners.add(l); return () => unauthorizedListeners.delete(l); };

export async function request<T>(method: string, path: string, body?: unknown, opts: { signal?: AbortSignal; params?: Record<string, unknown> } = {}): Promise<T> {
  const url = new URL(apiBase() + path.replace(/^\/+/, ''), window.location.origin);
  for (const [k, v] of Object.entries(opts.params ?? {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  const headers: Record<string, string> = {};
  const t = authToken();
  // Own header (not Authorization) so it never clashes with the pendency server's Basic Auth gate.
  if (t) headers['X-MP-Token'] = t;
  if (isNativeApp()) headers['ngrok-skip-browser-warning'] = '1';   // ngrok free links show a warning page otherwise
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  // writes get a time limit so a stuck connection never freezes a screen (long-poll GETs pass their own signal)
  const ctl = !opts.signal && method !== 'GET' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), path.startsWith('face/') ? 15000 : 45000) : null;
  try {
    res = await fetch(url.toString(), { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: opts.signal ?? ctl?.signal });
  } catch (e) {
    if ((e as Error).name === 'AbortError' && !ctl?.signal.aborted) throw e;
    throw new ApiError(ctl?.signal.aborted ? 'Server ne time pe jawab nahi diya — dobara try kariye' : 'Network unavailable — cannot reach the server', 'NETWORK', 0);
  } finally {
    if (timer) clearTimeout(timer);
  }
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { message: text }; }
  // Sign out only when OUR server says the login is no longer valid. A 401 from a proxy in between
  // (public link password, ngrok) or a network blip must not throw the user out of the app.
  if (res.status === 401 && path !== 'auth/login' && (data?.detail?.code ?? data?.code) === 'UNAUTHENTICATED') {
    unauthorizedListeners.forEach((l) => l());
  }
  if (!res.ok) {
    const d = data?.detail ?? data ?? {};
    throw new ApiError(typeof d === 'string' ? d : d.message ?? d.error ?? `Request failed (${res.status})`, d.code, res.status);
  }
  return data as T;
}

export const get = <T>(path: string, params?: Record<string, unknown>) => request<T>('GET', path, undefined, { params });
export const post = <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {});
export const put = <T>(path: string, body?: unknown) => request<T>('PUT', path, body ?? {});
export const del = <T>(path: string) => request<T>('DELETE', path);

/** Fetch a protected image (photo/snapshot) with the login header and return an object URL. */
export async function imageUrl(path: string): Promise<string | null> {
  const t = authToken();
  try {
    const h: Record<string, string> = t ? { 'X-MP-Token': t } : {};
    if (isNativeApp()) h['ngrok-skip-browser-warning'] = '1';
    const res = await fetch(apiBase() + path.replace(/^\/+/, ''), { headers: h });
    if (!res.ok) return null;
    return URL.createObjectURL(await res.blob());
  } catch { return null; }
}

const FRIENDLY_CONFLICT = 'Someone else just updated this record. The view has been refreshed — please check and retry.';

/** Call a server action (POST /api/rpc/<fn>). Throws ApiError on permission/validation failures. */
export async function rpc<T extends RpcResult = RpcResult>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  try {
    return await post<T>(`rpc/${fn}`, args);
  } catch (e) {
    if (e instanceof ApiError && e.code === 'CONFLICT' && /version/.test(e.message)) throw new ApiError(FRIENDLY_CONFLICT, e.code, e.status);
    throw e;
  }
}

/** Idempotency key for a single user action (prevents double-click duplicates). */
export const requestId = () => (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16); }));
