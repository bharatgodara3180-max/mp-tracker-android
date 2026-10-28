/**
 * Shared pieces of the two face kiosks (gate DC IN/OUT and supervisor deployment):
 * camera + recognition loop, full-screen result, sounds, camera help.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { BlinkDetector, FACE_QUALITY, SAMPLES_NEEDED, analyse, distance, loadFaceEngine, mean, snapshot, startCamera, stopCamera } from '../lib/face';
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

/**
 * Finds one good face, takes 3 consistent samples, calls onCapture(descriptor, snapshot).
 * After onCapture resolves it waits (result on screen) until the person leaves (min 2.5 s, max 8 s), then onReset().
 */
export function useFaceCapture(opts: {
  enabled: boolean; facing: 'user' | 'environment'; requireBlink: boolean;
  onCapture: (descriptor: number[], snap: string | null) => Promise<void>; onReset: () => void;
  /** Fixed result time (ms) instead of "until the person walks away"; the same face is then not re-scanned for sameFaceGapMs. */
  resultMs?: number; sameFaceGapMs?: number;
}) {
  const video = useRef<HTMLVideoElement>(null);
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
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    (async () => {
      try {
        setPhase('loading'); setHint('Loading face models…');
        if (!video.current) return;
        // camera and models start together (models are usually already loading since the page opened)
        const [, s] = await Promise.all([loadFaceEngine(), startCamera(video.current, opts.facing)]);
        stream = s;
        if (!alive) { stopCamera(stream); return; }
        try { wake = await (navigator as unknown as { wakeLock?: { request(t: string): Promise<{ release(): Promise<void> }> } }).wakeLock?.request('screen') ?? null; } catch { /* optional */ }
        setPhase('scanning');
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
      let lastFace: { d: number[]; at: number } | null = null;
      while (alive) {
        const v = video.current;
        if (!v) { await sleep(150); continue; }
        const fr = await analyse(v, true);
        let msg = '';
        if (fr.count === 0) msg = 'Camera ke saamne aaiye';
        else if (fr.count > 1) msg = 'Ek baar mein ek vyakti';
        else if (fr.sizeRatio < FACE_QUALITY.minSize) msg = 'Thoda paas aaiye';
        else if (!fr.centered) msg = 'Chehra beech mein rakhiye';
        else if (fr.score < FACE_QUALITY.minScore) msg = 'Seedha camera ki taraf dekhiye';
        if (fr.count === 0) { blink.reset(); samples = []; } else blink.push(fr.ear);
        const good = !msg;
        if (good && ref.current.requireBlink && !blink.done) msg = 'Aankh jhapkaiye (blink)';
        if (good && fr.descriptor) {
          const now = Date.now();
          samples = samples.filter((s) => now - s.at < 6000);   // slow tablets need ~1 s per sample
          if (samples.length && distance(samples[0].d, fr.descriptor) > FACE_QUALITY.consistent) samples = [];
          samples.push({ d: fr.descriptor, at: now });
          if (samples.length === 1) snap = snapshot(v);
          setProgress(Math.min(samples.length, SAMPLES_NEEDED));
          if (samples.length >= SAMPLES_NEEDED && (!ref.current.requireBlink || blink.done)) {
            const d = mean(samples.map((s) => s.d));
            const shot = snap ?? snapshot(v);
            samples = []; snap = null; blink.reset(); setProgress(0);
            const gap = ref.current.sameFaceGapMs ?? 0;
            if (gap && lastFace && Date.now() - lastFace.at < gap && distance(lastFace.d, d) < FACE_QUALITY.consistent) {
              setHint('Ho gaya — agla MP aaye'); await sleep(400); continue;   // same person still in front: don't repeat
            }
            lastFace = { d, at: Date.now() };
            setPhase('busy');
            try { await ref.current.onCapture(d, shot); } catch { /* page shows its own error */ }
            if (!alive) return;
            setPhase('result');
            const fixed = ref.current.resultMs;
            if (fixed) { await sleep(fixed); if (!alive) return; lastFace = { d, at: Date.now() }; }
            // otherwise keep the result up until the person moves away (min 2.5 s, max 8 s)
            const shownAt = Date.now(); let lastSeen = Date.now();
            while (alive && !fixed) {
              const f2 = await analyse(v, false);
              if (f2.count) lastSeen = Date.now();
              const shown = Date.now() - shownAt;
              if ((shown > 2500 && Date.now() - lastSeen > 1000) || shown > 8000) break;
              await sleep(120);
            }
            ref.current.onReset();
            setPhase('scanning');
            continue;
          }
        } else if (!good) setProgress(0);
        setHint(msg || 'Hold still…');
        await sleep(15);
      }
    })();
    return () => { alive = false; stopCamera(stream); void wake?.release().catch(() => {}); };
  }, [opts.enabled, opts.facing]);

  return { video, phase, hint, progress };
}

/* ---------- views ---------- */
export function CameraStage({ cam, mirror, children }: { cam: ReturnType<typeof useFaceCapture>; mirror: boolean; children?: ReactNode }) {
  return (
    <div className="face-stage">
      <video ref={cam.video} className={`face-video ${mirror ? 'mirror' : ''}`} playsInline muted />
      <div className={`face-guide ${cam.progress ? 'locking' : ''}`} />
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
