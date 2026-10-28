/**
 * Supervisor deployment (no IN/OUT). Area chosen once; then each MP is identified by
 * Face scan, QR / barcode scan (camera) or Manual type (also works with a scanner gun),
 * and deployed to that area. MPs not inside the DC are refused with an alarm.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, get, imageUrl, post } from '../lib/api';
import { cameraProblem, loadFaceEngine, startCamera, stopCamera } from '../lib/face';
import { useRefData } from '../hooks/useRefData';
import { Button, Field } from '../components/ui';
import { InstallAppButton } from '../components/InstallApp';
import { isNativeApp } from '../lib/native';
import { CameraStage, FullResult, playSound, useFaceCapture, type KioskResult } from '../components/FaceKiosk';

const AREA_KEY = 'mp-deploy-area';
const TASK_KEY = 'mp-deploy-task';
const MODE_KEY = 'mp-deploy-mode';
const FACING_KEY = 'mp-deploy-facing';
const ACTION_KEY = 'mp-deploy-action';
type Action = 'deploy' | 'out';
type OutPurpose = 'PICKUP' | 'LUNCH' | 'OTHER';
type Mode = 'face' | 'qr' | 'manual';
type Facing = 'user' | 'environment';

interface DeployReply { matched: boolean; reason?: string; repeat?: boolean; result: KioskResult; employee?: { id: string; code: string; name: string; has_photo?: boolean } | null }
interface View { result: KioskResult; name?: string; code?: string; photo?: string | null; repeat?: boolean }

type Detector = { detect(src: HTMLVideoElement): Promise<{ rawValue: string }[]> };
const BarcodeDetectorCtor = (window as unknown as { BarcodeDetector?: new (o?: { formats: string[] }) => Detector }).BarcodeDetector;

export default function DeployPage() {
  const ref = useRefData();
  const [area, setArea] = useState(() => localStorage.getItem(AREA_KEY) ?? '');
  const [task, setTask] = useState(() => localStorage.getItem(TASK_KEY) ?? '');
  const [setup, setSetup] = useState(!localStorage.getItem(AREA_KEY));
  const [action, setActionState] = useState<Action>(() => (localStorage.getItem(ACTION_KEY) as Action) || 'deploy');
  const [outPurpose, setOutPurpose] = useState<OutPurpose>('LUNCH');
  const [route, setRoute] = useState('');
  const [mode, setModeState] = useState<Mode>(() => (localStorage.getItem(MODE_KEY) as Mode) || 'face');
  const [facing, setFacing] = useState<Facing>(() => (localStorage.getItem(FACING_KEY) as Facing) || 'environment');
  const [value, setValue] = useState('');
  const [view, setView] = useState<View | null>(null);
  const [busy, setBusy] = useState(false);
  const [count, setCount] = useState(0);
  const [camErr, setCamErr] = useState<string | null>(null);
  const [requireBlink, setRequireBlink] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const qrVideo = useRef<HTMLVideoElement>(null);
  const clearTimer = useRef<number>();
  const busyRef = useRef(false);
  const areaRow = ref.activeAreas.find((a) => a.id === area);
  const needsArea = action === 'deploy' && (setup || !areaRow);
  const setAction = (a: Action) => {
    setActionState(a); setView(null);
    if (a === 'deploy' && !areaRow) setSetup(true);     // choose the area first (Start button), don't jump on select
    try { localStorage.setItem(ACTION_KEY, a); } catch { /* ignore */ }
  };
  const camBlocked = cameraProblem();

  useEffect(() => { void loadFaceEngine().catch(() => {}); }, []);
  useEffect(() => { void get<{ require_blink: boolean }>('face/config').then((c) => setRequireBlink(c.require_blink)).catch(() => {}); }, []);
  const setMode = (m: Mode) => { setModeState(m); setCamErr(null); setView(null); try { localStorage.setItem(MODE_KEY, m); } catch { /* ignore */ } };
  const flip = () => { const f: Facing = facing === 'user' ? 'environment' : 'user'; setFacing(f); try { localStorage.setItem(FACING_KEY, f); } catch { /* ignore */ } };

  const showView = (v: View, autoClear: boolean) => {
    setView((old) => { if (old?.photo) URL.revokeObjectURL(old.photo); return v; });
    window.clearTimeout(clearTimer.current);
    if (autoClear) clearTimer.current = window.setTimeout(() => setView(null), v.result.alarm ? 4000 : 2500);
  };

  /** One deploy call; `id` is either { scan_value } or { descriptor }. */
  const deploy = useCallback(async (id: { scan_value?: string; descriptor?: number[] }, autoClear: boolean) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true);
    try {
      const r = action === 'deploy'
        ? await post<DeployReply>('face/deploy', { ...id, area_id: area, task: task.trim() || null })
        : await post<DeployReply>('face/assign-out', { ...id, purpose: outPurpose, route_ref: outPurpose === 'PICKUP' ? route.trim() || null : null });
      playSound(!!r.result.alarm);
      if ((r.result.label === 'DEPLOYED' || r.result.label === 'OUT ASSIGNED') && !r.repeat) setCount((c) => c + 1);
      const photo = r.employee?.has_photo ? await imageUrl(`face/photo/${r.employee.id}`) : null;
      showView({ result: r.result, name: r.employee?.name, code: r.employee?.code, photo, repeat: r.repeat }, autoClear);
    } catch (e) {
      playSound(true);
      const net = !(e instanceof ApiError) || e.code === 'NETWORK' || [502, 503, 504].includes(e.status ?? 0);
      showView({ result: { label: net ? 'NETWORK NAHI' : 'ERROR', sub: e instanceof Error ? e.message : String(e), tone: 'red', alarm: true } }, autoClear);
    } finally {
      busyRef.current = false; setBusy(false);
    }
  }, [area, task, action, outPurpose, route]);

  /* ---------- Face scan ---------- */
  const onFace = useCallback(async (descriptor: number[]) => { await deploy({ descriptor }, false); }, [deploy]);
  const onFaceReset = useCallback(() => setView((v) => { if (v?.photo) URL.revokeObjectURL(v.photo); return null; }), []);
  const faceCam = useFaceCapture({ enabled: !needsArea && mode === 'face' && !camBlocked, facing, requireBlink, onCapture: onFace, onReset: onFaceReset,
    resultMs: 2000, sameFaceGapMs: 10000 });   // result 2 s, then next MP; same face not repeated for 10 s

  /* ---------- QR / barcode scan ---------- */
  useEffect(() => {
    if (needsArea || mode !== 'qr') return;
    let stream: MediaStream | null = null;
    let alive = true;
    (async () => {
      try {
        if (camBlocked) throw new Error('Camera ke liye HTTPS link chahiye — Manual type / scanner gun use kariye');
        if (!qrVideo.current) return;
        stream = await startCamera(qrVideo.current, facing);
        // Built-in reader (Android Chrome: QR + barcodes); otherwise jsQR in JavaScript (QR codes, any browser)
        const native = BarcodeDetectorCtor ? new BarcodeDetectorCtor({ formats: ['qr_code', 'code_128', 'code_39', 'ean_13', 'ean_8', 'itf', 'data_matrix'] }) : null;
        const jsQR = native ? null : (await import('jsqr')).default;
        const canvas = document.createElement('canvas');
        const read = async (v: HTMLVideoElement): Promise<string | undefined> => {
          if (native) return (await native.detect(v).catch(() => []))[0]?.rawValue;
          if (!v.videoWidth || !jsQR) return undefined;
          const w = 480; const h = Math.round((v.videoHeight / v.videoWidth) * w);
          canvas.width = w; canvas.height = h;
          const g = canvas.getContext('2d', { willReadFrequently: true });
          if (!g) return undefined;
          g.drawImage(v, 0, 0, w, h);
          return jsQR(g.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' })?.data;
        };
        let last = ''; let lastAt = 0;
        while (alive) {
          const c = qrVideo.current ? (await read(qrVideo.current))?.trim() : undefined;
          if (c && !busyRef.current && (c !== last || Date.now() - lastAt > 3000)) { last = c; lastAt = Date.now(); await deploy({ scan_value: c }, true); }
          await new Promise((r) => setTimeout(r, 250));
        }
      } catch (e) { if (alive) setCamErr(e instanceof Error ? e.message : String(e)); }
    })();
    return () => { alive = false; stopCamera(stream); };
  }, [needsArea, mode, facing, deploy, camBlocked]);

  /* ---------- Manual type (scanner gun types here too) ---------- */
  useEffect(() => {
    if (needsArea || mode !== 'manual') return;
    input.current?.focus();
    const t = setInterval(() => { if (document.activeElement?.tagName !== 'INPUT') input.current?.focus(); }, 1500);
    return () => clearInterval(t);
  }, [needsArea, mode]);
  const submitManual = async () => {
    const v = value.trim();
    if (!v) return;
    setValue('');
    await deploy({ scan_value: v }, true);
    input.current?.focus();
  };

  if (needsArea) return (
    <div className="kiosk">
      <div className="kiosk-card">
        <h2>Deployment</h2>
        <p className="muted">Area chuniye — jis MP ko scan karenge wo is area pe deploy ho jayega. Yahan IN/OUT nahi hota.</p>
        <Field label="Area / block"><select className="kiosk-select" value={area} onChange={(e) => setArea(e.target.value)}>
          <option value="">— choose —</option>
          {ref.activeAreas.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.code})</option>)}
        </select></Field>
        <Field label="Task (optional)"><input value={task} onChange={(e) => setTask(e.target.value)} placeholder="e.g. Sorting, Loading" /></Field>
        <Button variant="primary" disabled={!area} onClick={() => {
          localStorage.setItem(AREA_KEY, area); localStorage.setItem(TASK_KEY, task); setCount(0); setSetup(false);
        }}>Start deploying</Button>
        <Button variant="ghost" onClick={() => { setSetup(false); setAction('out'); }}>Sirf OUT assign karna hai</Button>
      </div>
    </div>
  );

  const FlipButton = () => (
    <button className="gate-flip small" onClick={flip} aria-label="Switch camera" title="Camera badlein">
      <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 7h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z" />
        <path d="M9 13a3 3 0 0 1 5.2-2" /><path d="M15 13a3 3 0 0 1-5.2 2" /><path d="M14.5 9.5v1.7h-1.7" /><path d="M9.5 16.5v-1.7h1.7" />
      </svg>
    </button>
  );

  return (
    <div className="kiosk deploy-page">
      <InstallAppButton label="Phone pe MP Deploy app install karein" className="btn btn-sm install-strip" />
      <div className="action-switch" role="tablist">
        <button role="tab" aria-selected={action === 'deploy'} className={action === 'deploy' ? 'active' : ''} onClick={() => setAction('deploy')}>Deploy</button>
        <button role="tab" aria-selected={action === 'out'} className={action === 'out' ? 'active out' : ''} onClick={() => setAction('out')}>OUT assign</button>
      </div>
      {action === 'deploy' && areaRow ? <header className="kiosk-head">
        <strong>Deploy → {areaRow.name}{task ? ` · ${task}` : ''}</strong>
        <span className="pill tone-green">{count} done</span>
        <span className="spacer" />
        <button className="btn btn-ghost btn-sm" onClick={() => setSetup(true)}>Change area</button>
      </header> : <div className="out-purpose">
        <span className="muted small">OUT kis liye:</span>
        {(['PICKUP', 'LUNCH', 'OTHER'] as const).map((p) => <button key={p} className={`tag ${outPurpose === p ? 'on' : ''}`} onClick={() => setOutPurpose(p)}>{p === 'PICKUP' ? 'Pickup' : p === 'LUNCH' ? 'Lunch' : 'Other'}</button>)}
        {outPurpose === 'PICKUP' && <input className="route-input" value={route} onChange={(e) => setRoute(e.target.value)} placeholder="Route / ref (optional)" />}
        <span className="pill tone-green">{count} done</span>
      </div>}
      <div className="deploy-modes" role="tablist">
        {([['face', 'Face scan'], ['qr', 'QR scan'], ['manual', 'Manual type']] as const).map(([m, label]) =>
          <button key={m} role="tab" aria-selected={mode === m} className={`kiosk-mode ${mode === m ? 'active' : ''}`} onClick={() => setMode(m)}>{label}</button>)}
      </div>

      {mode === 'face' && (camBlocked
        ? <div className="sync-error">Camera ke liye HTTPS link chahiye (public …/MP/ link). Tab tak QR scan / Manual type use kariye.</div>
        : <div className="deploy-cam"><CameraStage cam={faceCam} mirror={facing === 'user'} /><FlipButton /></div>)}

      {mode === 'qr' && (camErr
        ? <div className="sync-error">{camErr}</div>
        : <div className="deploy-cam"><div className="face-stage"><video ref={qrVideo} className={`face-video ${facing === 'user' ? 'mirror' : ''}`} playsInline muted />
            <div className="scan-box" /><div className="face-hint">{busy ? 'Checking…' : 'ID card ka QR / barcode box mein dikhaiye'}</div></div><FlipButton /></div>)}

      {mode === 'manual' && <>
        <form onSubmit={(e) => { e.preventDefault(); void submitManual(); }}>
          <input ref={input} autoFocus className="kiosk-input" value={value} onChange={(e) => setValue(e.target.value)} disabled={busy}
                 placeholder="Employee ID likhiye (ya scanner gun se scan)" autoComplete="off" />
        </form>
        <Button variant="primary" disabled={!value.trim() || busy} onClick={() => void submitManual()}>{action === 'deploy' ? 'Deploy' : 'OUT assign'}</Button>
      </>}

      {isNativeApp() && <p className="small kiosk-foot"><a href="#/" className="link-btn">Dashboard</a> · <a href="#/app-setup" className="link-btn">App setup</a></p>}
      <p className="muted small kiosk-foot">{action === 'deploy'
        ? 'Sirf DC ke andar (DC IN) wale MP deploy hote hain. Wahi MP 2 minute mein dobara scan ho to wahi result dikhega.'
        : 'Gate pe DC OUT sirf assign hue OUT se hoga (Lunch assign gate pe 2 ghante valid). 9 ghante baad shift-end OUT ke liye assign ki zarurat nahi.'}</p>
      {view && <div onClick={() => setView(null)}><FullResult {...view} /></div>}
    </div>
  );
}
