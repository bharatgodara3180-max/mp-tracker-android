import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { get } from '../lib/api';

/* ---------- Global connection health + change watcher (long poll) ---------- */
type ConnState = { status: 'connecting' | 'live' | 'reconnecting' | 'offline'; lastRefresh: number | null; version: number };
let conn: ConnState = { status: 'connecting', lastRefresh: null, version: 0 };
const listeners = new Set<() => void>();
function setConn(p: Partial<ConnState>) {
  conn = { ...conn, ...p };
  listeners.forEach((l) => l());
}
export function useConnection() {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => conn);
}

let watcherStarted = false;
/**
 * One long-poll loop per tab: GET /api/changes?since=v returns the moment anything
 * changes on the server (or after 25 s). Works through any HTTP proxy, reconnects
 * automatically with back-off when the network drops.
 */
function startWatcher() {
  if (watcherStarted) return;
  watcherStarted = true;
  let since = 0;
  let backoff = 1000;
  const loop = async () => {
    for (;;) {
      try {
        const r = await get<{ version: number }>('changes', { since, timeout: 25 });
        if (conn.status !== 'live') setConn({ status: 'live' });
        backoff = 1000;
        if (r.version !== since) { since = r.version; setConn({ version: r.version }); }
      } catch {
        setConn({ status: navigator.onLine ? 'reconnecting' : 'offline' });
        await new Promise((res) => setTimeout(res, backoff));
        backoff = Math.min(backoff * 2, 15000);
      }
    }
  };
  void loop();
  window.addEventListener('offline', () => setConn({ status: 'offline' }));
}

/** Re-render every `ms` so elapsed-time columns tick without refetching. */
export function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

/**
 * Load data and keep it live: refetch (debounced) whenever the server reports a
 * change, when the tab becomes visible again, and as a slow safety poll. The
 * server database stays the single source of truth.
 */
export function useLiveQuery<T>(loader: () => Promise<T>, _tables: string[] = [], deps: unknown[] = [],
                                opts: { pollMs?: number } = {}) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inflight = useRef(false);
  const again = useRef(false);
  const { version } = useConnection();

  const refresh = useCallback(async () => {
    if (inflight.current) { again.current = true; return; }
    inflight.current = true;
    try {
      const d = await loaderRef.current();
      setData(d);
      setError(null);
      setConn({ lastRefresh: Date.now() });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      inflight.current = false;
      setLoading(false);
      if (again.current) { again.current = false; void refresh(); }
    }
  }, []);

  const schedule = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void refresh(), 250);
  }, [refresh]);

  useEffect(() => { startWatcher(); }, []);
  useEffect(() => { if (version) schedule(); }, [version, schedule]);

  useEffect(() => {
    setLoading(true);
    void refresh();
    const onVisible = () => { if (document.visibilityState === 'visible') schedule(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', schedule);
    const poll = setInterval(() => void refresh(), opts.pollMs ?? 60_000);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', schedule);
      clearInterval(poll);
      if (timer.current) clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, error, loading, refresh };
}
