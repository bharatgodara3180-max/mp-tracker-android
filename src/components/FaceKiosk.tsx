/**
 * Shared pieces of the two face kiosks (gate DC IN/OUT and supervisor deployment):
 * camera + recognition loop, full-screen result, sounds, camera help.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { BlinkDetector, FACE_QUALITY, KIOSK_FACE, SAMPLES_NEEDED, describeAt, distance, focusOn, loadFaceEngine, mean, readiness, snapshot, startCamera, stopCamera, track, type Tracked } from '../lib/face';
import { Button } from './ui';

export interface KioskResult { label: string; sub?: string; tone: 'green' | 'blue' | 'red' | 'amber'; alarm?: boolean }

/* ---------- sounds ---------- */
export function playSound(alarm: boolean) {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    const tone = (freq: number, start: number, len: number, type: OscillatorType, vol: number) => {
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.type = type; o.frequency.value = freq; g.gain.value = vol;
      o.connect(g); g.connect(ctx.destination); o.start(ctx.currentTime + start); o.stop(ctx.currentTime + start + len);
    };
    if (alarm) { [0, 0.4, 0.8].forEach((s) => tone(260, s, 0.3, 'square', 0.25)); setTimeout(() => void ctx.close(), 1500); }
    else { tone(880, 0, 0.15, 'sine', 0.2); tone(1320, 0.16, 0.2, 'sine', 0.2); setTimeout(() => void ctx.close(), 600); }
  } catch { /* no audio */ }
}

/* ---------- camera + recognition loop ---------- */
type Phase = 'loading' | 'scanning' | 'busy' | 'result' | 'error';
/** What the page tells the loop after a scan: not matched -> short popup and a quick retry. */
export interface CaptureOutcome { matched: boolean; holdMs?: number }

const NOT_MATCHED_MS = 700;      // "face match nahi hua" popup
const TRACK_GAP_MS = 60;         // breathing room between frames so buttons / scrolling stay smooth
const SETTLE_MS = 450;           // pause before the next face (camera start / after a result)
const SEND_TIMEOUT_MS = 15000;   // a slow network never freezes the camera loop

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const frame = () => new Promise<void>((r) => { if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => r()); else setTimeout(r, 16); });

/**
 * Finds the face anywhere in the picture (box follows it), waits until it is at the right distance, fully in the
 * picture, looking straight and steady, then recognises it (2 consistent samples) and calls onCapture.
 */
export function useFaceCapture(opts: {
  enabled: boolean; facing: 'user' | 'environment'; requireBlink: boolean;
  onCapture: (descriptor: number[], snap: string | null) => Promise<void | CaptureOutcome>; onReset: () => void;
  /** Fixed result time (ms) instead of "until the person walks away". */
  resultMs?: number;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [hint, setHint] = useState('Starting camera…');
  const [progress, setProgress] = useState(0);
  const ref = useRef(opts);
  ref.current = opts;

  useEffect(() => {
    if (!opts.enabled) return;
    let stream: MediaStream | null = null;
    let alive = true;
    let wake: { release(): Promise<void> } | null = null;
    let facing = ref.current.facing;          // camera switch = new stream only, the loop keeps running

    const drawBox = (t: Tracked | null, tone: 'idle' | 'ok' | 'bad') => {
      const el = boxRef.current; const v = video.current;
      if (!el || !v) return;
      if (!t) { el.style.opacity = '0'; return; }
      const cw = v.clientWidth; const ch = v.clientHeight;
      const sc = Math.max(cw / t.vw, ch / t.vh);              // video is object-fit: cover
      const ox = (cw - t.vw * sc) / 2; const oy = (ch - t.vh * sc) / 2;
      const pad = t.box.width * 0.12;
      const w = (t.box.width + pad * 2) * sc; const h = (t.box.height + pad * 2) * sc;
      let x = (t.box.x - pad) * sc + ox; const y = (t.box.y - pad * 1.4) * sc + oy;
      if (facing === 'user') x = cw - x - w;
      el.style.opacity = '1';
      el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
      el.style.width = `${Math.round(w)}px`; el.style.height = `${Math.round(h)}px`;
      el.dataset.tone = tone;
    };

    const openCamera = async () => {
      if (!video.current) throw new Error('no video');
      stopCamera(stream); stream = null;
      facing = ref.current.facing;
      stream = await startCamera(video.current, facing);
      try {   // continuous auto-focus where the phone supports it
        const tr = stream.getVideoTracks()[0];
        const caps = (tr.getCapabilities?.() ?? {}) as Record<string, unknown>;
        if (Array.isArray(caps.focusMode) && (caps.focusMode as string[]).includes('continuous'))
          await tr.applyConstraints({ advanced: [{ focusMode: 'continuous' }] } as unknown as MediaTrackConstraints);
      } catch { /* optional */ }
    };

    (async () => {
      try {
        setPhase('loading'); setHint('Loading face models…');
        if (!video.current) return;
        await Promise.all([loadFaceEngine(), openCamera()]);
        if (!alive) { stopCamera(stream); return; }
        try { wake = await (navigator as unknown as { wakeLock?: { request(t: string): Promise<{ release(): Promise<void> }> } }).wakeLock?.request('screen') ?? null; } catch { /* optional */ }
        setPhase('scanning'); setHint('Camera ke saamne aaiye');
        await sleep(SETTLE_MS);
      } catch (e) {
        if (!alive) return;
        setPhase('error');
        setHint(e instanceof Error && /Permission|NotAllowed/i.test(e.name + e.message)
          ? 'Camera permission denied — allow camera for this site in the browser settings.'
          : `Camera / model error: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      const blink = new BlinkDetector();
      let samples: { d: Float32Array; at: number }[] = [];
      let snap: string | null = null;
      let lastMiss: { d: number[]; at: number } | null = null;     // last "not matched"
      let prev: { x: number; y: number } | null = null;
      let steady = 0; let errors = 0; let focusAt = 0;
      let lastTime = -1; let frozenSince = Date.now();

      while (alive) {
        const v = video.current;
        if (!v || document.hidden) { await sleep(300); continue; }
        if (ref.current.facing !== facing) {          // camera switched
          drawBox(null, 'idle'); samples = []; steady = 0; prev = null; setHint('Camera badal raha hai…');
          try { await openCamera(); } catch { await sleep(800); }
          frozenSince = Date.now(); continue;
        }
        // camera watchdog: picture stopped moving for 4 s -> reopen the camera
        if (v.currentTime !== lastTime) { lastTime = v.currentTime; frozenSince = Date.now(); }
        else if (Date.now() - frozenSince > 4000) {
          setHint('Camera restart ho raha hai…'); drawBox(null, 'idle');
          try { await openCamera(); } catch { await sleep(1500); }
          frozenSince = Date.now(); continue;
        }
        let t: Tracked | null = null;
        try { t = await track(v); errors = 0; }
        catch { errors++; await sleep(errors > 5 ? 1000 : 150); continue; }   // one bad frame never stops the loop
        await sleep(t ? TRACK_GAP_MS : TRACK_GAP_MS * 2);
        if (!alive) break;

        let msg = readiness(t);
        const placed = !msg;          // right distance / pose -> green box (even while waiting to be steady)
        if (!t) { blink.reset(); samples = []; } else blink.push(t.ear);
        if (!msg && t) {
          // steady = moved less than a quarter of its own face width (works near and far)
          const c = { x: (t.box.x + t.box.width / 2) / t.box.width, y: (t.box.y + t.box.height / 2) / t.box.width };
          steady = prev && Math.hypot(c.x - prev.x, c.y - prev.y) < KIOSK_FACE.steady ? steady + 1 : 0;
          prev = c;
          if (steady < 2) msg = 'Ruk ke seedha dekhiye';
          else if (ref.current.requireBlink && !blink.done) msg = 'Aankh jhapkaiye (blink)';
        } else { steady = 0; prev = null; }
        drawBox(t, placed ? 'ok' : t ? 'bad' : 'idle');

        if (msg) {
          samples = []; snap = null; setProgress(0); setHint(msg);
          await frame(); continue;
        }
        if (t && Date.now() - focusAt > 1500) { focusAt = Date.now(); focusOn(stream, t, facing === 'user'); }

        // ready: recognise (heavier network, only now)
        let desc: Float32Array | null = null;
        try { desc = t ? await describeAt(v, t.box) : null; } catch { await sleep(150); continue; }
        if (!alive) break;
        if (!desc) { samples = []; await frame(); continue; }
        const now = Date.now();
        samples = samples.filter((x) => now - x.at < 3000);
        if (samples.length && distance(samples[0].d, desc) > FACE_QUALITY.consistent) samples = [];
        samples.push({ d: desc, at: now });
        if (samples.length === 1) snap = snapshot(v);
        setProgress(Math.min(samples.length, SAMPLES_NEEDED));
        setHint('Pehchaan ho rahi hai…');
        if (samples.length < SAMPLES_NEEDED) continue;

        const d = mean(samples.map((x) => x.d));
        const shot = snap ?? snapshot(v);
        samples = []; snap = null; blink.reset(); setProgress(0);
        if (lastMiss && now - lastMiss.at < 1500 && distance(lastMiss.d, d) < FACE_QUALITY.consistent) {
          setHint('Match nahi hua — seedha aur paas dekhiye'); await sleep(250); continue;   // don't spam the same unknown face
        }

        setPhase('busy');
        let out: void | CaptureOutcome = undefined;
        try {
          out = await Promise.race([ref.current.onCapture(d, shot),
            sleep(SEND_TIMEOUT_MS).then(() => { throw new Error('timeout'); })]);
        } catch { /* the page shows its own error */ }
        if (!alive) return;
        setPhase('result'); drawBox(null, 'idle');
        const matched = !out || out.matched;
        if (!matched) lastMiss = { d, at: Date.now() };
        const hold = out?.holdMs ?? (matched ? ref.current.resultMs : NOT_MATCHED_MS);
        if (hold) { await sleep(hold); }
        else {   // gate: keep the result until the person moves away (min 1.5 s, max 6 s)
          const shownAt = Date.now(); let lastSeen = Date.now();
          while (alive) {
            let seen = false;
            try { seen = !!(await track(v)); } catch { /* ignore */ }
            if (seen) lastSeen = Date.now();
            const shown = Date.now() - shownAt;
            if ((shown > 1500 && Date.now() - lastSeen > 700) || shown > 6000) break;
            await sleep(120);
          }
        }
        if (!alive) return;
        ref.current.onReset();
        setPhase('scanning'); setHint('Agla MP');
        steady = 0; prev = null;
        await sleep(SETTLE_MS);
      }
    })();
    return () => { alive = false; stopCamera(stream); void wake?.release().catch(() => {}); };
  }, [opts.enabled]);

  return { video, boxRef, phase, hint, progress };
}

/* ---------- views ---------- */
export function CameraStage({ cam, mirror, children }: { cam: ReturnType<typeof useFaceCapture>; mirror: boolean; children?: ReactNode }) {
  return (
    <div className="face-stage">
      <video ref={cam.video} className={`face-video ${mirror ? 'mirror' : ''}`} playsInline muted />
      <div ref={cam.boxRef} className="face-box" data-tone="idle" />
      {cam.phase !== 'result' && <div className="face-hint">
        {cam.phase === 'busy' ? 'Checking…' : cam.hint}
        {cam.phase === 'scanning' && cam.progress > 0 && <div className="face-progress"><i style={{ width: `${(cam.progress / SAMPLES_NEEDED) * 100}%` }} /></div>}
      </div>}
      {children}
    </div>
  );
}

/** Full-page result: big label (DC IN / DC IN LATE / DC OUT PICKUP / DEPLOYED …), sub-line, MP name and photo. */
export function FullResult({ result, name, code, photo, note, repeat }: {
  result: KioskResult; name?: string | null; code?: string | null; photo?: string | null; note?: string | null; repeat?: boolean;
}) {
  return (
    <div className={`full-result tone-${result.tone}`} aria-live="assertive">
      <div className="fr-label">{result.label}</div>
      {result.sub && <div className="fr-sub">{result.sub}</div>}
      {(name || photo) && <div className="fr-person">
        {photo && <img src={photo} alt="" />}
        <div><div className="fr-name">{name}</div>{code && <div className="fr-code">{code}</div>}</div>
      </div>}
      {note && <div className="fr-note">{note}</div>}
      {repeat && <div className="fr-note">Pehle hi scan ho chuka hai — wahi result</div>}
    </div>
  );
}

export function CameraHelp({ problem, onRetry, path }: { problem: string; onRetry: () => void; path: string }) {
  const origin = window.location.origin;
  return (
    <div className="kiosk">
      <div className="kiosk-card wide">
        <h2>Camera blocked by the browser</h2>
        {problem === 'insecure' ? <>
          <p>Browser camera sirf <b>HTTPS</b> link pe deta hai. Ye page <span className="mono">{origin}</span> (http) pe khula hai. Do mein se ek kariye:</p>
          <ol className="help-steps">
            <li><b>Public HTTPS link</b> kholiye: <span className="mono">https://&lt;aapka public address&gt;/MP/#/{path}</span></li>
            <li><b>LAN pe hi chalana ho</b> (internet ke bina bhi): Chrome mein
              <span className="mono"> chrome://flags/#unsafely-treat-insecure-origin-as-secure</span> kholiye → <b>Enabled</b> → box mein
              <span className="mono"> {origin}</span> likhiye → <b>Relaunch</b>.</li>
          </ol>
        </> : <p>Is browser mein camera support nahi hai. Latest Google Chrome use kariye.</p>}
        <Button variant="primary" onClick={onRetry}>Try again</Button>
      </div>
    </div>
  );
}

export function CameraSwitch({ facing, setFacing }: { facing: 'user' | 'environment'; setFacing: (f: 'user' | 'environment') => void }) {
  return (
    <div className="kiosk-modes two">
      <button className={`kiosk-mode ${facing === 'user' ? 'active' : ''}`} onClick={() => setFacing('user')}>Front camera</button>
      <button className={`kiosk-mode ${facing === 'environment' ? 'active' : ''}`} onClick={() => setFacing('environment')}>Back camera</button>
    </div>
  );
}
