/**
 * SFXBM host: shows the Asset Desk page (/ASSETS/go -> operator / admin) in a full-screen frame and owns the front camera.
 * The page keeps its normal look; for the operator's Issue screen it asks us to show the camera in a box ("slot") and we
 * find the face there, send the face data to the page (it asks the server who it is) and the page moves on to "Scan Asset ID".
 * The face engine and the camera load once and stay on for the whole app run, whatever tab the operator is on.
 */
import { useEffect, useRef, useState } from 'react';
import { FACE_QUALITY, describeAt, distance, focusOn, loadFaceEngine, readiness, startCamera, stopCamera, track, type Tracked } from '../lib/face';
import { lastLink } from '../lib/native';

interface Slot { x: number; y: number; w: number; h: number }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default function HostPage() {
  const [url] = useState(() => { try { return sessionStorage.getItem('sfxbm-host'); } catch { return null; } });
  const target = url ?? lastLink();
  const origin = (() => { try { return new URL(target).origin; } catch { return ''; } })();
  const frame = useRef<HTMLIFrameElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [slot, setSlot] = useState<Slot>({ x: 0, y: 0, w: 320, h: 240 });
  const [hint, setHint] = useState('');
  const [needCam, setNeedCam] = useState(false);
  const [shown, setShown] = useState(false);
  const st = useRef({ active: false, cool: 0, pend: null as null | ((m: boolean) => void) });

  /* ---------- messages from the Asset Desk page ---------- */
  useEffect(() => {
    const on = (e: MessageEvent) => {
      if (e.origin !== origin) return;
      const d = e.data as { sfxbm?: string; [k: string]: unknown } | null;
      if (!d || typeof d !== 'object' || !d.sfxbm) return;
      if (d.sfxbm === 'ready') setNeedCam(true);
      else if (d.sfxbm === 'cam') {
        const was = st.current.active;
        st.current.active = !!d.active; setShown(!!d.active);
        if (d.active) {
          if (!was) st.current.cool = Date.now() + Number(d.cool ?? 0);
          const r = d.rect as Slot | undefined;
          if (r) setSlot((p) => (p.x === r.x && p.y === r.y && p.w === r.w && p.h === r.h ? p : { x: r.x, y: r.y, w: r.w, h: r.h }));
        } else setHint('');
      } else if (d.sfxbm === 'face-result') { const p = st.current.pend; st.current.pend = null; p?.(!!d.matched); }
      else if (d.sfxbm === 'goto' && typeof d.url === 'string' && d.url.startsWith('http://localhost/')) window.location.href = d.url;   // MP login -> built-in MP screens
      else if (d.sfxbm === 'setup') window.location.hash = '#/app-setup';
    };
    window.addEventListener('message', on);
    return () => window.removeEventListener('message', on);
  }, [origin]);

  /* ---------- camera + face loop (starts when the operator page says it is ready; then never stops) ---------- */
  useEffect(() => {
    if (!needCam) return;
    let alive = true; let stream: MediaStream | null = null;
    const drawBox = (t: Tracked | null, tone: 'idle' | 'ok' | 'bad') => {
      const el = boxRef.current; const v = video.current;
      if (!el || !v) return;
      if (!t) { el.style.opacity = '0'; return; }
      const cw = v.clientWidth; const ch = v.clientHeight;
      const sc = Math.max(cw / t.vw, ch / t.vh);
      const ox = (cw - t.vw * sc) / 2; const oy = (ch - t.vh * sc) / 2;
      const pad = t.box.width * 0.12;
      const w = (t.box.width + pad * 2) * sc; const h = (t.box.height + pad * 2) * sc;
      const x = cw - ((t.box.x - pad) * sc + ox) - w; const y = (t.box.y - pad * 1.4) * sc + oy;   // front camera is mirrored
      el.style.opacity = '1';
      el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
      el.style.width = `${Math.round(w)}px`; el.style.height = `${Math.round(h)}px`;
      el.dataset.tone = tone;
    };
    const open = async () => {
      if (!video.current) throw new Error('no video');
      stopCamera(stream); stream = null;
      stream = await startCamera(video.current, 'user');
      try {
        const tr = stream.getVideoTracks()[0];
        const caps = (tr.getCapabilities?.() ?? {}) as Record<string, unknown>;
        if (Array.isArray(caps.focusMode) && (caps.focusMode as string[]).includes('continuous'))
          await tr.applyConstraints({ advanced: [{ focusMode: 'continuous' }] } as unknown as MediaTrackConstraints);
      } catch { /* optional */ }
    };
    const ask = (descriptor: number[]) => new Promise<boolean>((res) => {
      st.current.pend = res;
      frame.current?.contentWindow?.postMessage({ sfxbm: 'face', descriptor }, origin);
      setTimeout(() => { if (st.current.pend === res) { st.current.pend = null; res(false); } }, 12000);
    });
    (async () => {
      try { await Promise.all([loadFaceEngine(), open()]); }
      catch (e) { if (alive) setHint(`Camera error: ${e instanceof Error ? e.message : String(e)}`); return; }
      let lastMiss: { d: number[]; at: number } | null = null;
      let lastTime = -1; let frozen = Date.now(); let focusAt = 0; let errors = 0;
      while (alive) {
        const v = video.current;
        if (!v || document.hidden || !st.current.active) { drawBox(null, 'idle'); await sleep(120); continue; }   // camera stays on, nothing is analysed
        if (v.currentTime !== lastTime) { lastTime = v.currentTime; frozen = Date.now(); }
        else if (Date.now() - frozen > 4000) { try { await open(); } catch { await sleep(1000); } frozen = Date.now(); continue; }
        let t: Tracked | null = null;
        try { t = await track(v); errors = 0; } catch { errors++; await sleep(errors > 5 ? 800 : 100); continue; }
        if (!st.current.active) continue;
        const msg = readiness(t);
        drawBox(t, !msg ? 'ok' : t ? 'bad' : 'idle');
        setHint(msg);
        if (msg || !t) { await sleep(t ? 40 : 90); continue; }
        if (Date.now() < st.current.cool) { setHint(''); await sleep(150); continue; }
        if (Date.now() - focusAt > 1500) { focusAt = Date.now(); focusOn(stream, t, true); }
        let desc: Float32Array | null = null;
        try { desc = await describeAt(v, t.box); } catch { await sleep(100); continue; }
        if (!desc || !alive || !st.current.active) continue;
        const d = Array.from(desc);
        if (lastMiss && Date.now() - lastMiss.at < 1500 && distance(lastMiss.d, d) < FACE_QUALITY.consistent) { await sleep(200); continue; }
        setHint('Checking…');
        const ok = await ask(d);
        if (ok) { st.current.active = false; setShown(false); drawBox(null, 'idle'); setHint(''); }     // the page now shows the employee; it re-activates us after the asset is scanned
        else { lastMiss = { d, at: Date.now() }; await sleep(600); }
      }
    })();
    return () => { alive = false; stopCamera(stream); };
  }, [needCam, origin]);

  return (
    <div className="host-screen">
      <iframe ref={frame} className="host-frame" src={target} title="SFXBM" allow="camera; microphone" />
      <div className="host-cam" style={{ left: slot.x, top: slot.y, width: slot.w, height: slot.h, visibility: needCam && shown ? 'visible' : 'hidden' }}>
        <video ref={video} className="face-video mirror" playsInline muted />
        <div ref={boxRef} className="face-box" data-tone="idle" />
        {hint && <div className="face-hint">{hint}</div>}
      </div>
    </div>
  );
}
