import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, post, rpc } from '../lib/api';
import { OfflineQueue, isNetworkError, type QueuedScan, type SendResult } from '../lib/offlineQueue';
import { STATUS_META } from '../lib/format';
import type { MpStatus } from '../lib/types';
import { Button } from '../components/ui';

const queue = new OfflineQueue(window.localStorage);
const DEVICE_KEY = 'mp-kiosk-device';
const PURPOSES = [
  { v: null, label: 'Not specified' }, { v: 'PICKUP', label: 'Pickup' }, { v: 'LUNCH', label: 'Lunch' },
  { v: 'BREAK', label: 'Break' }, { v: 'OFFICIAL', label: 'Official work' }, { v: 'SHIFT_END', label: 'Shift end' }, { v: 'OTHER', label: 'Other' },
] as const;

interface ScanResult { ok: boolean; name?: string; code?: string; direction?: string; status?: MpStatus; processing?: string; note?: string; error?: string; queued?: boolean }

async function send(device: string, s: QueuedScan): Promise<SendResult> {
  try {
    const data = await rpc('kiosk_gate_scan', {
      p_device_code: device, p_scan_value: s.scanValue, p_direction: s.direction, p_purpose: s.purpose,
      p_client_event_id: s.clientEventId, p_captured_at: s.capturedAt });
    return { ok: true, result: data };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const retryable = !(e instanceof ApiError) || e.code === 'NETWORK' || (e.status ?? 0) >= 500 || isNetworkError(e);
    return { ok: false, retryable, error: msg };
  }
}

export default function KioskPage() {
  const [device, setDevice] = useState(() => localStorage.getItem(DEVICE_KEY) ?? '');
  const [setup, setSetup] = useState(!localStorage.getItem(DEVICE_KEY));
  const [mode, setMode] = useState<'AUTO' | 'IN' | 'OUT'>('AUTO');
  const [purpose, setPurpose] = useState<string | null>(null);
  const [value, setValue] = useState('');
  const [last, setLast] = useState<ScanResult | null>(null);
  const [pending, setPending] = useState(queue.size());
  const [online, setOnline] = useState(navigator.onLine);
  const input = useRef<HTMLInputElement>(null);
  const flushing = useRef(false);

  const flush = useCallback(async (show = false) => {
    if (!device || flushing.current) return;
    flushing.current = true;
    try {
      const r = await queue.flush((s) => send(device, s));
      setPending(queue.size());
      if (show && r.results.length) {
        const x = r.results[r.results.length - 1] as Record<string, any>;
        if (x?.error) setLast({ ok: false, error: x.error });
        else if (x) setLast({ ok: x.ok !== false && x.processing_status !== 'REJECTED', name: x.employee?.name, code: x.employee?.code,
          direction: x.direction, status: x.status, processing: x.processing_status, note: x.note ?? x.message });
      }
      if (r.remaining > 0 && show) setLast({ ok: false, queued: true, error: 'Network unavailable — scan saved and will sync automatically.' });
    } finally { flushing.current = false; }
  }, [device]);

  useEffect(() => {
    if (setup || !device) return;   // nothing runs while the device code is being typed
    const on = () => { setOnline(true); void flush(); };
    const off = () => setOnline(false);
    window.addEventListener('online', on); window.addEventListener('offline', off);
    const t = setInterval(() => void flush(), 15_000);
    const hb = setInterval(() => { if (device) void post('kiosk/heartbeat', { device_code: device, pending_events: queue.size() }).catch(() => {}); }, 60_000);
    if (device) void post('kiosk/heartbeat', { device_code: device, pending_events: queue.size() }).catch(() => {});
    void flush();
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); clearInterval(t); clearInterval(hb); };
  }, [device, flush, setup]);

  useEffect(() => { const t = setInterval(() => { if (document.activeElement?.tagName !== 'INPUT' || document.activeElement === input.current) input.current?.focus(); }, 1500); return () => clearInterval(t); }, []);

  const submit = async () => {
    const v = value.trim();
    if (!v) return;
    setValue('');
    queue.enqueue({ scanValue: v, direction: mode === 'AUTO' ? null : mode, purpose: mode === 'IN' ? null : purpose });
    setPending(queue.size());
    setPurpose(null);
    await flush(true);
    input.current?.focus();
  };

  if (setup) return (
    <div className="kiosk">
      <div className="kiosk-card">
        <h2>Gate kiosk setup</h2>
        <p className="muted">Enter the device code registered in Admin → Devices (e.g. GATE-KIOSK-01). Stay signed in as the gate operator on this tablet.</p>
        <input className="kiosk-input" value={device} onChange={(e) => setDevice(e.target.value.toUpperCase())} placeholder="GATE-KIOSK-01" />
        <Button variant="primary" onClick={() => { localStorage.setItem(DEVICE_KEY, device); setSetup(false); }} disabled={!device}>Start kiosk</Button>
      </div>
    </div>
  );

  const tone = last ? (last.ok ? (last.direction === 'OUT' ? 'blue' : 'green') : last.queued ? 'amber' : 'red') : 'gray';
  return (
    <div className="kiosk">
      <header className="kiosk-head">
        <strong>Gate · {device}</strong>
        <span className={`conn conn-${online ? 'live' : 'offline'}`}>{online ? 'online' : 'OFFLINE'}</span>
        {pending > 0 && <span className="pill tone-amber">{pending} waiting to sync</span>}
        <span className="spacer" />
        <button className="btn btn-ghost btn-sm" onClick={() => setSetup(true)}>Setup</button>
      </header>
      <div className="kiosk-modes">
        {(['AUTO', 'IN', 'OUT'] as const).map((m) => <button key={m} className={`kiosk-mode ${mode === m ? 'active' : ''} m-${m.toLowerCase()}`} onClick={() => setMode(m)}>{m === 'AUTO' ? 'Auto IN/OUT' : m}</button>)}
      </div>
      {mode !== 'IN' && <div className="kiosk-purpose">
        <span className="muted">If going out — purpose:</span>
        {PURPOSES.map((p) => <button key={p.label} className={`tag ${purpose === p.v ? 'on' : ''}`} onClick={() => setPurpose(p.v)}>{p.label}</button>)}
      </div>}
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <input ref={input} autoFocus className="kiosk-input" value={value} onChange={(e) => setValue(e.target.value)}
               placeholder="Scan ID card QR / barcode or type employee ID" autoComplete="off" inputMode="text" />
      </form>
      <div className={`kiosk-result tone-${tone}`} aria-live="assertive">
        {!last ? <span className="muted">Ready to scan</span> : last.ok ? <>
          <div className="kr-dir">{last.processing === 'APPLIED' ? last.direction : last.processing === 'DUPLICATE' || last.processing === 'DUPLICATE_SUBMISSION' ? 'Already recorded' : last.processing}</div>
          <div className="kr-name">{last.name ?? 'Unknown'} <span className="mono">{last.code}</span></div>
          {last.status && <div>{STATUS_META[last.status]?.label}</div>}
          {last.note && <div className="small">{last.note}</div>}
        </> : <>
          <div className="kr-dir">{last.queued ? 'Saved offline' : 'Not recorded'}</div>
          <div>{last.error ?? last.note}</div>
        </>}
      </div>
      <p className="muted small kiosk-foot">The Face kiosk is the main gate screen; this QR / employee-ID kiosk is the fallback. Scans made offline sync in order with no duplicates.</p>
    </div>
  );
}
