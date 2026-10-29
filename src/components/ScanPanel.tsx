/**
 * Identify an MP by Face scan, QR / barcode scan (camera) or Manual type (scanner gun types here too),
 * send it with `submit`, and show the full-screen result. Used by the supervisor app for
 * deployment, OUT assign and area handover.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, get, imageUrl } from '../lib/api';
import { cameraProblem, loadFaceEngine, startCamera, stopCamera } from '../lib/face';
import { Button } from './ui';
import { CameraStage, FullResult, playSound, useFaceCapture, type CaptureOutcome, type KioskResult } from './FaceKiosk';

export type ScanId = { scan_value?: string; descriptor?: number[] };
export interface ScanReply { matched?: boolean; reason?: string; repeat?: boolean; result: KioskResult; employee?: { id: string; code: string; name: string; has_photo?: boolean } | null }
type Mode = 'face' | 'qr' | 'manual';
type Facing = 'user' | 'environment';
interface View { result: KioskResult; name?: string; code?: string; photo?: string | null; repeat?: boolean }

type Detector = { detect(src: HTMLVideoElement): Promise<{ rawValue: string }[]> };
const BarcodeDetectorCtor = (window as unknown as { BarcodeDetector?: new (o?: { formats: string[] }) => Detector }).BarcodeDetector;

const MODE_KEY = 'mp-scan-mode';
const FACING_KEY = 'mp-scan-facing';

export function ScanPanel({ submit, active, buttonLabel, onResult }: {
  submit: (id: ScanId) => Promise<ScanReply>; active: boolean; buttonLabel: string; onResult?: (r: ScanReply) => void;
}) {
  const [mode, setModeState] = useState<Mode>(() => (localStorage.getItem(MODE_KEY) as Mode) || 'face');
  const [facing, setFacing] = useState<Facing>(() => (localStorage.getItem(FACING_KEY) as Facing) || 'environment');
  const [value, setValue] = useState('');
  const [view, setView] = useState<View | null>(null);
  const [busy, setBusy] = useState(false);
  const [camErr, setCamErr] = useState<string | null>(null);
  const [requireBlink, setRequireBlink] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const qrVideo = useRef<HTMLVideoElement>(null);
  const clearTimer = useRef<number>();
  const busyRef = useRef(false);
  const camBlocked = cameraProblem();
  const submitRef = useRef(submit);
  submitRef.current = submit;
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;

  useEffect(() => { void loadFaceEngine().catch(() => {}); }, []);
  useEffect(() => { void get<{ require_blink: boolean }>('face/config').then((c) => setRequireBlink(c.require_blink)).catch(() => {}); }, []);
  const setMode = (m: Mode) => { setModeState(m); setCamErr(null); setView(null); try { localStorage.setItem(MODE_KEY, m); } catch { /* ignore */ } };
  const flip = () => { const f: Facing = facing === 'user' ? 'environment' : 'user'; setFacing(f); try { localStorage.setItem(FACING_KEY, f); } catch { /* ignore */ } };

  const showView = (v: View, autoClear: boolean) => {
    setView((old) => { if (old?.photo) URL.revokeObjectURL(old.photo); return v; });
    window.clearTimeout(clearTimer.current);
    if (autoClear) clearTimer.current = window.setTimeout(() => setView(null), v.result.alarm ? 4000 : 2500);
  };

  const send = useCallback(async (id: ScanId, autoClear: boolean): Promise<ScanReply | null> => {
    if (busyRef.current) return null;
    busyRef.current = true; setBusy(true);
    try {
      const r = await Promise.race([submitRef.current(id),     // never hang on a slow network
        new Promise<never>((_, rej) => setTimeout(() => rej(new ApiError('Server slow hai — dobara scan kariye', 'NETWORK', 0)), 15000))]);
      playSound(!!r.result.alarm);
      onResultRef.current?.(r);
      const photo = r.employee?.has_photo ? await imageUrl(`face/photo/${r.employee.id}`) : null;
      showView({ result: r.result, name: r.employee?.name, code: r.employee?.code, photo, repeat: r.repeat }, autoClear);
      return r;
    } catch (e) {
      playSound(true);
      const net = !(e instanceof ApiError) || e.code === 'NETWORK' || [502, 503, 504].includes(e.status ?? 0);
      showView({ result: { label: net ? 'NETWORK NAHI' : 'ERROR', sub: e instanceof Error ? e.message : String(e), tone: 'red', alarm: true } }, autoClear);
      return null;
    } finally {
      busyRef.current = false; setBusy(false);
    }
  }, []);

  /* Face scan: result 2 s, then the next MP; the same face is not repeated for 10 s */
  const onFace = useCallback(async (descriptor: number[]): Promise<CaptureOutcome> => {
    const r = await send({ descriptor }, false);
    return { matched: !!r?.employee };      // not recognised -> short popup, quick retry
  }, [send]);
  const onFaceReset = useCallback(() => setView((v) => { if (v?.photo) URL.revokeObjectURL(v.photo); return null; }), []);
  const faceCam = useFaceCapture({ enabled: active && mode === 'face' && !camBlocked, facing, requireBlink, onCapture: onFace, onReset: onFaceReset,
    resultMs: 2000, sameFaceGapMs: 10000 });

  /* QR / barcode scan */
  useEffect(() => {
    if (!active || mode !== 'qr') return;
    let stream: MediaStream | null = null;
    let alive = true;
    (async () => {
      try {
        if (camBlocked) throw new Error('Camera ke liye HTTPS link chahiye — Manual type / scanner gun use kariye');
        if (!qrVideo.current) return;
        stream = await startCamera(qrVideo.current, facing);
        // Built-in reader (Android Chrome / app: QR + barcodes); otherwise jsQR in JavaScript (QR codes)
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
          if (c && !busyRef.current && (c !== last || Date.now() - lastAt > 3000)) { last = c; lastAt = Date.now(); await send({ scan_value: c }, true); }
          await new Promise((r) => setTimeout(r, 250));
        }
      } catch (e) { if (alive) setCamErr(e instanceof Error ? e.message : String(e)); }
    })();
    return () => { alive = false; stopCamera(stream); };
  }, [active, mode, facing, send, camBlocked]);

  /* Manual type (scanner gun types here too) */
  useEffect(() => {
    if (!active || mode !== 'manual') return;
    input.current?.focus();
    const t = setInterval(() => { if (document.activeElement?.tagName !== 'INPUT') input.current?.focus(); }, 1500);
    return () => clearInterval(t);
  }, [active, mode]);
  const submitManual = async () => {
    const v = value.trim();
    if (!v) return;
    setValue('');
    await send({ scan_value: v }, true);
    input.current?.focus();
  };

  const FlipButton = () => (
    <button className="gate-flip small" onClick={flip} aria-label="Switch camera" title="Camera badlein">
      <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 7h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z" />
        <path d="M9 13a3 3 0 0 1 5.2-2" /><path d="M15 13a3 3 0 0 1-5.2 2" /><path d="M14.5 9.5v1.7h-1.7" /><path d="M9.5 16.5v-1.7h1.7" />
      </svg>
    </button>
  );

  return (
    <>
      <div className="deploy-modes" role="tablist">
        {([['face', 'Face scan'], ['qr', 'QR scan'], ['manual', 'Manual type']] as const).map(([m, label]) =>
          <button key={m} role="tab" aria-selected={mode === m} className={`kiosk-mode ${mode === m ? 'active' : ''}`} onClick={() => setMode(m)}>{label}</button>)}
      </div>
      {active && mode === 'face' && (camBlocked
        ? <div className="sync-error">Camera ke liye HTTPS link (ya Android app) chahiye. Tab tak QR scan / Manual type use kariye.</div>
        : <div className="deploy-cam"><CameraStage cam={faceCam} mirror={facing === 'user'} /><FlipButton /></div>)}
      {active && mode === 'qr' && (camErr
        ? <div className="sync-error">{camErr}</div>
        : <div className="deploy-cam"><div className="face-stage"><video ref={qrVideo} className={`face-video ${facing === 'user' ? 'mirror' : ''}`} playsInline muted />
            <div className="scan-box" /><div className="face-hint">{busy ? 'Checking…' : 'ID card ka QR / barcode box mein dikhaiye'}</div></div><FlipButton /></div>)}
      {active && mode === 'manual' && <div className="manual-row">
        <form onSubmit={(e) => { e.preventDefault(); void submitManual(); }}>
          <input ref={input} autoFocus className="kiosk-input" value={value} onChange={(e) => setValue(e.target.value)} disabled={busy}
                 placeholder="Employee ID likhiye (ya scanner gun se scan)" autoComplete="off" />
        </form>
        <Button variant="primary" disabled={!value.trim() || busy} onClick={() => void submitManual()}>{buttonLabel}</Button>
      </div>}
      {view && <div onClick={() => setView(null)}><FullResult {...view} /></div>}
    </>
  );
}
