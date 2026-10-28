import { useEffect, useRef, useState } from 'react';
import { get } from '../lib/api';
import type { Alert } from '../lib/types';
import { useLiveQuery } from './useLive';

const MUTE_KEY = 'mp-alerts-muted';

function readMuted() {
  try { return localStorage.getItem(MUTE_KEY) === '1'; } catch { return false; }
}

let audioCtx: AudioContext | null = null;
export function beep() {
  try {
    audioCtx ??= new AudioContext();
    const ctx = audioCtx;
    [0, 0.28].forEach((offset) => {
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.type = 'square'; o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, ctx.currentTime + offset);
      g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + offset + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + offset + 0.22);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + offset); o.stop(ctx.currentTime + offset + 0.24);
    });
  } catch { /* audio unavailable */ }
}

const rank = (s: Alert['severity']) => (s === 'CRITICAL' ? 3 : s === 'WARNING' ? 2 : 1);

/** Open alerts, live. Plays a sound once per *new* critical alert (never repeatedly for the same one). */
export function useOpenAlerts(enabled: boolean) {
  const [muted, setMutedState] = useState(readMuted);
  const seen = useRef<Set<string> | null>(null);
  const q = useLiveQuery<Alert[]>(
    async () => enabled ? (await get<Alert[]>('alerts', { show: 'open' })).sort((a, b) => rank(b.severity) - rank(a.severity)) : [],
    [], [enabled]);

  useEffect(() => {
    if (!q.data) return;
    const ids = new Set(q.data.map((a) => a.id));
    if (seen.current === null) { seen.current = ids; return; }   // no beep for alerts present at page load
    const fresh = q.data.filter((a) => a.severity === 'CRITICAL' && a.status === 'OPEN' && !seen.current!.has(a.id));
    seen.current = ids;
    if (fresh.length && !muted) beep();
  }, [q.data, muted]);

  const setMuted = (m: boolean) => {
    setMutedState(m);
    try { localStorage.setItem(MUTE_KEY, m ? '1' : '0'); } catch { /* ignore */ }
    if (!m) beep();
  };

  return { alerts: q.data ?? [], loading: q.loading, refresh: q.refresh, muted, setMuted };
}
