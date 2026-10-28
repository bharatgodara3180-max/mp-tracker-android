/**
 * Gate face kiosk (DC IN / DC OUT). No buttons: the server decides from the MP's state and the
 * site rules (shift start / late, lunch, pickup, 9-hour shift end, rejected) and the result fills
 * the whole screen with a sound. Works offline: scans are queued with a stable id and synced
 * in order without duplicates.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, get, imageUrl, post } from '../lib/api';
import { isNetworkError, uuid } from '../lib/offlineQueue';
import { cameraProblem, loadFaceEngine } from '../lib/face';
import { Button } from '../components/ui';
import { InstallAppButton } from '../components/InstallApp';
import { isNativeApp } from '../lib/native';
import { CameraHelp, CameraStage, CameraSwitch, FullResult, playSound, useFaceCapture, type KioskResult } from '../components/FaceKiosk';

const DEVICE_KEY = 'mp-face-device';
const FACING_KEY = 'mp-face-facing';
const QUEUE_KEY = 'mp-face-queue';
const FAILED_KEY = 'mp-face-failed';
const MAX_SERVER_ATTEMPTS = 5;   // server keeps erroring on one scan -> park it, don't block the rest

interface FaceScan { clientEventId: string; capturedAt: string; descriptor: number[]; snapshot: string | null; attempts?: number; lastError?: string }
interface ScanReply {
  matched: boolean; reason?: string | null; direction?: 'IN' | 'OUT'; processing_status?: string; repeat?: boolean;
  result?: KioskResult; employee?: { id: string; code: string; name: string; has_photo?: boolean } | null;
}
interface View { result: KioskResult; name?: string; code?: string; photo?: string | null; note?: string; repeat?: boolean }

function makeStore(key: string) {
  return {
    all(): FaceScan[] { try { return JSON.parse(localStorage.getItem(key) ?? '[]'); } catch { return []; } },
    save(items: FaceScan[]) {
      try { localStorage.setItem(key, JSON.stringify(items)); }
      catch { try { localStorage.setItem(key, JSON.stringify(items.map((i) => ({ ...i, snapshot: null })))); } catch { /* full */ } }
    },
  };
}
const store = makeStore(QUEUE_KEY);
const failedStore = makeStore(FAILED_KEY);

export default function FaceKioskPage({ fixedDevice }: { fixedDevice?: string }) {
  const [device, setDevice] = useState(() => fixedDevice ?? localStorage.getItem(DEVICE_KEY) ?? 'GATE-FACE-TAB-01');
  const [facing, setFacing] = useState<'user' | 'environment'>(() => (localStorage.getItem(FACING_KEY) as 'user' | 'environment') ?? 'user');
  const [setup, setSetup] = useState(!fixedDevice && !localStorage.getItem(DEVICE_KEY));
  const [started, setStarted] = useState(false);     // one tap needed: browsers allow sound / full screen only after a touch
  const [view, setView] = useState<View | null>(null);
  const [problem, setProblem] = useState<string | null>(cameraProblem());
  const [pending, setPending] = useState(store.all().length);
  const [failed, setFailed] = useState(failedStore.all().length);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [showFailed, setShowFailed] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const [cfg, setCfg] = useState<{ require_blink: boolean; enrolled: number }>({ require_blink: false, enrolled: 0 });
  const flushing = useRef(false);
  useEffect(() => { void loadFaceEngine().catch(() => {}); }, []);   // start downloading models right away (before the tap)

  /* ---------- sending / offline sync ---------- */
  const sendOne = useCallback(async (s: FaceScan): Promise<{ ok: true; reply: ScanReply } | { ok: false; retry: boolean; network: boolean; error: string }> => {
    try {
      const reply = await post<ScanReply>('face/scan', {
        device_code: device, descriptor: s.descriptor, snapshot: s.snapshot, client_event_id: s.clientEventId, captured_at: s.capturedAt });
      return { ok: true, reply };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 502/503/504 = proxy says the MP service is down/restarting -> same as no network
      const network = !(e instanceof ApiError) || e.code === 'NETWORK' || isNetworkError(e) || [502, 503, 504].includes(e.status ?? 0);
      const retry = network || (e instanceof ApiError && (e.status ?? 0) >= 500);
      const error = e instanceof ApiError && e.status && !network ? `${msg} [HTTP ${e.status}]` : msg;
      return { ok: false, retry, network, error };
    }
  }, [device]);

  const flush = useCallback(async () => {
    if (flushing.current) return;
    flushing.current = true;
    try {
      const items = store.all().sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
      let err: string | null = null;
      while (items.length) {
        const head = items[0];
        const r = await sendOne(head);
        if (!r.ok && r.retry) {
          err = r.error;
          if (r.network) break;                                   // wait for the network, keep order
          head.attempts = (head.attempts ?? 0) + 1; head.lastError = r.error;
          if (head.attempts < MAX_SERVER_ATTEMPTS) { store.save(items); break; }
          failedStore.save([...failedStore.all(), head]);
        } else if (!r.ok) {
          failedStore.save([...failedStore.all(), { ...head, lastError: r.error }]);
        }
        items.shift(); store.save(items);
      }
      setSyncError(err);
      setPending(store.all().length); setFailed(failedStore.all().length);
    } finally { flushing.current = false; }
  }, [sendOne]);

  const queued = (network: boolean, error?: string): View => ({
    result: { label: 'SAVED', sub: network ? 'Server tak network nahi — scan save hai, apne-aap sync hoga' : 'Server error — scan save hai, dobara try hoga', tone: 'amber' },
    note: error,
  });

  const onCapture = useCallback(async (descriptor: number[], snap: string | null) => {
    const scan: FaceScan = { clientEventId: uuid(), capturedAt: new Date().toISOString(), descriptor, snapshot: snap };
    if (store.all().length) await flush();             // older offline scans go first (order matters for the rules)
    if (store.all().length) {
      store.save([...store.all(), scan]); setPending(store.all().length);
      const head = store.all()[0];
      playSound(false); setView(queued(!head?.attempts, head?.lastError));
      return;
    }
    const r = await sendOne(scan);
    if (r.ok) {
      const res: KioskResult = r.reply.result ?? { label: r.reply.matched ? `DC ${r.reply.direction}` : 'PEHCHAAN NAHI HUI', tone: r.reply.matched ? 'green' : 'red', alarm: !r.reply.matched };
      playSound(!!res.alarm);
      const e = r.reply.employee;
      const photo = e?.has_photo ? await imageUrl(`face/photo/${e.id}`) : null;
      setView({ result: res, name: e?.name, code: e?.code, photo, note: r.reply.matched ? undefined : r.reply.reason ?? undefined, repeat: r.reply.repeat });
    } else if (r.retry) {
      store.save([...store.all(), { ...scan, attempts: r.network ? 0 : 1, lastError: r.error }]); setPending(store.all().length);
      setSyncError(r.error);
      playSound(false); setView(queued(r.network, r.error));
    } else {
      playSound(true); setView({ result: { label: 'ERROR', sub: r.error, tone: 'red', alarm: true } });
    }
  }, [flush, sendOne]);

  const onReset = useCallback(() => setView((v) => { if (v?.photo) URL.revokeObjectURL(v.photo); return null; }), []);
  const cam = useFaceCapture({ enabled: started && !setup && !problem, facing, requireBlink: cfg.require_blink, onCapture, onReset });
  const flipCamera = () => { const f = facing === 'user' ? 'environment' : 'user'; setFacing(f); try { localStorage.setItem(FACING_KEY, f); } catch { /* ignore */ } };
  const begin = () => { setStarted(true); void document.documentElement.requestFullscreen?.().catch(() => {}); };

  /* ---------- heartbeat, config, online state ---------- */
  useEffect(() => {
    if (setup) return;
    const on = () => { setOnline(true); void flush(); };
    const off = () => setOnline(false);
    window.addEventListener('online', on); window.addEventListener('offline', off);
    const beat = () => void post('kiosk/heartbeat', { device_code: device, pending_events: store.all().length, firmware: 'face-gate-web' })
      .then(() => setOnline(true))
      .catch((e) => { if (!(e instanceof ApiError) || e.code === 'NETWORK' || (e.status ?? 0) >= 500) setOnline(false); });
    const loadCfg = () => void get<{ require_blink: boolean; enrolled: number }>('face/config').then(setCfg).catch(() => {});
    beat(); loadCfg(); void flush();
    const t1 = setInterval(beat, 30_000); const t2 = setInterval(() => void flush(), 15_000); const t3 = setInterval(loadCfg, 120_000);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); clearInterval(t1); clearInterval(t2); clearInterval(t3); };
  }, [device, setup, flush]);

  if (problem) return <CameraHelp problem={problem} path="face-kiosk" onRetry={() => setProblem(cameraProblem())} />;

  if (setup) return (
    <div className="kiosk">
      <div className="kiosk-card">
        <h2>Gate face kiosk — DC IN / OUT</h2>
        <p className="muted">Device code from Admin → Devices (default <b>GATE-FACE-TAB-01</b>). Gate tablet ke liye Admin → Devices → <b>Gate link</b> use kariye.</p>
        <input className="kiosk-input" value={device} onChange={(e) => setDevice(e.target.value.toUpperCase())} placeholder="GATE-FACE-TAB-01" />
        <CameraSwitch facing={facing} setFacing={setFacing} />
        <Button variant="primary" disabled={!device} onClick={() => {
          localStorage.setItem(DEVICE_KEY, device); localStorage.setItem(FACING_KEY, facing); setSetup(false); begin();
        }}>Start</Button>
      </div>
    </div>
  );

  return (
    <div className="gate-screen">
      <div className="gate-camera">
        <CameraStage cam={cam} mirror={facing === 'user'} />
        <div className="gate-chips">
          <span className={`conn conn-${online ? 'live' : 'offline'}`}>{online ? 'online' : 'OFFLINE'}</span>
          {pending > 0 && <button className="pill tone-amber" onClick={() => void flush()}>{pending} sync baaki · Sync now</button>}
          {failed > 0 && <button className="pill tone-red" onClick={() => setShowFailed(!showFailed)}>{failed} failed</button>}
        </div>
      </div>
      <div className="gate-panel">
        <button className="gate-flip" onClick={flipCamera} aria-label="Switch camera" title="Camera badlein">
          <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 7h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z" />
            <path d="M9 13a3 3 0 0 1 5.2-2" /><path d="M15 13a3 3 0 0 1-5.2 2" /><path d="M14.5 9.5v1.7h-1.7" /><path d="M9.5 16.5v-1.7h1.7" />
          </svg>
        </button>
        <div className="gate-title">Take Attendance</div>
        <div className="gate-hint">{cam.phase === 'busy' ? 'Checking…' : cam.phase === 'scanning' ? 'Camera ki taraf seedha dekhiye' : cam.hint}</div>
        {syncError && pending > 0 && <div className="gate-err">Sync error: {syncError}</div>}
        <div className="gate-foot">DC IN / OUT · {device} · {cfg.enrolled} faces{!fixedDevice && <> · <button className="link-btn" onClick={() => setSetup(true)}>Setup</button></>}{isNativeApp() && <> · <button className="link-btn" onClick={() => { if (confirm('App setup kholein? (server / gate link badalne ke liye)')) window.location.hash = '#/app-setup'; }}>App setup</button></>}</div>
      </div>
      {showFailed && <div className="gate-failed sync-error">
        <b>Scans the server could not accept</b> (kept on this tablet):
        <ul>{failedStore.all().map((f) => <li key={f.clientEventId}>{new Date(f.capturedAt).toLocaleString()} — {f.lastError}</li>)}</ul>
        <button className="btn btn-sm" onClick={() => { const items = failedStore.all().map((f) => ({ ...f, attempts: 0 })); failedStore.save([]);
          store.save([...store.all(), ...items]); setFailed(0); setShowFailed(false); setPending(store.all().length); void flush(); }}>Retry all</button>{' '}
        <button className="btn btn-ghost btn-sm" onClick={() => { if (confirm('Delete these failed scans from this tablet?')) { failedStore.save([]); setFailed(0); setShowFailed(false); } }}>Delete</button>{' '}
        <button className="btn btn-ghost btn-sm" onClick={() => setShowFailed(false)}>Close</button>
      </div>}
      {!started && <div className="gate-start" role="button" tabIndex={0} onClick={begin}>
        <span className="gate-start-title">DC IN / OUT</span>
        <span>Shuru karne ke liye screen touch kariye</span>
        <InstallAppButton label="Tablet pe app install karein" className="btn gate-install" />
      </div>}
      {view && <FullResult {...view} />}
    </div>
  );
}
