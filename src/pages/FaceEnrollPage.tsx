/**
 * Face enrolment: supervisor/ops/admin registers an MP's face (5 live samples, or a photo).
 * Consent is mandatory and audited. The server refuses a face that already belongs to
 * someone else, so one person cannot be enrolled under two employee codes.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { del, get, imageUrl, post } from '../lib/api';
import { useAuth } from '../hooks/useAuth';
import { analyse, cameraProblem, describeAt, distance, loadFaceEngine, snapshot, startCamera, stopCamera, track, type Tracked } from '../lib/face';
import { fmtDateTime } from '../lib/format';
import { Button, ErrorBox, Loading, Modal, useAction } from '../components/ui';

interface Row { id: string; employee_code: string; full_name: string; designation: string | null; is_demo: number;
  samples: number; enrolled_at: string | null; enrolled_by: string | null; has_photo: boolean }

export default function FaceEnrollPage() {
  const { profile } = useAuth();
  const { busy, run } = useAction();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [show, setShow] = useState<'all' | 'yes' | 'no'>('all');
  const [target, setTarget] = useState<Row | null>(null);
  const [photo, setPhoto] = useState<{ name: string; url: string } | null>(null);
  const canRemove = profile?.role === 'admin';

  const load = () => get<Row[]>('face/enrollments').then((r) => { setRows(r); setError(null); }).catch((e) => setError(String(e.message ?? e)));
  useEffect(() => { void load(); }, []);

  const list = useMemo(() => (rows ?? []).filter((r) => {
    const t = q.trim().toLowerCase();
    if (t && !r.employee_code.toLowerCase().includes(t) && !r.full_name.toLowerCase().includes(t)) return false;
    return show === 'all' || (show === 'yes' ? r.samples > 0 : r.samples === 0);
  }), [rows, q, show]);
  const done = rows?.filter((r) => r.samples > 0).length ?? 0;

  return (
    <section className="panel">
      <div className="row between wrap">
        <h3>Face enrolment</h3>
        <span className="muted">{done} / {rows?.length ?? 0} MPs enrolled</span>
      </div>
      <p className="muted small">Har MP ka chehra ek baar register kariye — tablet ke kiosk pe IN/OUT isi se hoga. MP ki sahmati (consent) zaroori hai. Achhi roshni, seedha camera ki taraf, chashma/mask hata ke.</p>
      <div className="row gap wrap">
        <input placeholder="Search code or name" value={q} onChange={(e) => setQ(e.target.value)} />
        {(['all', 'no', 'yes'] as const).map((s) => <button key={s} className={`tag ${show === s ? 'on' : ''}`} onClick={() => setShow(s)}>
          {s === 'all' ? 'All' : s === 'yes' ? 'Enrolled' : 'Not enrolled'}</button>)}
      </div>
      <ErrorBox error={error} />
      {!rows ? <Loading /> : <table className="table compact">
        <thead><tr><th>Code</th><th>Name</th><th>Designation</th><th>Face</th><th>Enrolled</th><th /></tr></thead>
        <tbody>{list.slice(0, 300).map((r) => <tr key={r.id}>
          <td className="mono">{r.employee_code}</td><td>{r.full_name}{r.is_demo ? <span className="muted small"> (demo)</span> : null}</td>
          <td>{r.designation ?? ''}</td>
          <td>{r.samples ? <span className="pill tone-green">{r.samples} samples</span> : <span className="pill tone-amber">Not enrolled</span>}</td>
          <td className="small">{r.enrolled_at ? `${fmtDateTime(r.enrolled_at)}${r.enrolled_by ? ` · ${r.enrolled_by}` : ''}` : ''}</td>
          <td className="row gap">
            <Button size="sm" variant={r.samples ? 'ghost' : 'primary'} onClick={() => setTarget(r)}>{r.samples ? 'Re-enrol' : 'Enrol'}</Button>
            {r.has_photo && <Button size="sm" variant="ghost" onClick={async () => { const url = await imageUrl(`face/photo/${r.id}`); if (url) setPhoto({ name: r.full_name, url }); }}>Photo</Button>}
            {canRemove && r.samples > 0 && <Button size="sm" variant="ghost" busy={busy} onClick={async () => {
              if (!confirm(`Remove face enrolment of ${r.full_name}?`)) return;
              if (await run(() => del(`face/enroll/${r.id}`), 'Enrolment removed')) void load();
            }}>Remove</Button>}
          </td></tr>)}</tbody>
      </table>}
      {list.length > 300 && <p className="muted small">Showing first 300 — use search.</p>}
      {target && <EnrollModal row={target} onClose={() => setTarget(null)} onSaved={() => { setTarget(null); void load(); }} />}
      {photo && <Modal title={photo.name} onClose={() => { URL.revokeObjectURL(photo.url); setPhoto(null); }}>
        <img className="face-photo-big" src={photo.url} alt="" />
      </Modal>}
    </section>
  );
}

/* Face ID style enrolment: one straight sample (+ photo), then the head turned slowly in a circle —
   8 directions round the ring, one sample each, so the gate recognises the MP from any angle. */
const RING = 8;
const NEED = RING + 1;
const TURN = 0.17;         // how far the head must turn before a direction counts

export function EnrollModal({ row, onClose, onSaved }: { row: Pick<Row, 'id' | 'employee_code' | 'full_name'>; onClose: () => void; onSaved: () => void }) {
  const { busy, run } = useAction();
  const video = useRef<HTMLVideoElement>(null);
  const [facing, setFacing] = useState<'user' | 'environment'>('user');
  const [status, setStatus] = useState('Loading…');
  const [capturing, setCapturing] = useState(false);
  const [samples, setSamples] = useState<number[][]>([]);
  const [ring, setRing] = useState<boolean[]>(() => Array(RING).fill(false));
  const [front, setFront] = useState(false);
  const [photo, setPhoto] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const problem = cameraProblem();
  const capRef = useRef(false);
  capRef.current = capturing;

  useEffect(() => {
    if (problem) return;
    let stream: MediaStream | null = null;
    let alive = true;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    (async () => {
      try {
        setStatus('Loading face models…');
        await loadFaceEngine();
        if (!alive || !video.current) return;
        stream = await startCamera(video.current, facing);
        setStatus('Ready — Start capture dabaiye');
      } catch (e) { setErr(e instanceof Error ? e.message : String(e)); return; }
      let base: { yaw: number; pitch: number; d: Float32Array } | null = null;
      let got: (Float32Array | null)[] = Array(RING).fill(null);
      let last = 0;
      const publish = () => {
        const all = [base?.d, ...got].filter(Boolean) as Float32Array[];
        setSamples(all.map((d) => Array.from(d)));
        setRing(got.map(Boolean)); setFront(!!base);
      };
      while (alive) {
        const v: HTMLVideoElement | null = video.current;
        if (!v || !capRef.current) { base = null; got = Array(RING).fill(null); await sleep(150); continue; }
        let t: Tracked | null = null;
        try { t = await track(v); } catch { await sleep(150); continue; }
        if (!t) { setStatus('Chehra camera mein laaiye'); await sleep(80); continue; }
        if (t.others) { setStatus('Sirf MP camera ke saamne ho'); await sleep(80); continue; }
        if (t.box.width < 70) { setStatus('Thoda paas aaiye'); await sleep(80); continue; }
        if (!base) {   // 1) straight face first (this is also the photo)
          if (Math.abs(t.yaw) > 0.12 || Math.abs(t.roll) > 12) { setStatus('Pehle seedha camera ki taraf dekhiye'); await sleep(80); continue; }
          const d: Float32Array | null = await describeAt(v, t.box).catch(() => null);
          if (!d) continue;
          base = { yaw: t.yaw, pitch: t.pitch, d };
          setPhoto(snapshot(v, 360, 0.8)); publish();
          setStatus('Ab sar dheere dheere gol ghumaiye ↻');
          continue;
        }
        // 2) which way is the head turned? (screen direction, so the ring fills where the face points)
        let dx: number = t.yaw - base.yaw; const dy: number = (t.pitch - base.pitch) * 3;
        if (facing === 'user') dx = -dx;
        const r = Math.hypot(dx, dy);
        const left = got.filter((g) => !g).length;
        if (r < TURN) { setStatus(`Sar dheere dheere gol ghumaiye ↻ (${RING - left}/${RING})`); await sleep(60); continue; }
        if (r > 0.75) { setStatus('Itna zyada nahi — thoda kam ghumaiye'); await sleep(60); continue; }
        const seg = Math.round(((Math.atan2(dy, dx) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2 / RING)) % RING;
        if (got[seg] || Date.now() - last < 200) { await sleep(40); continue; }
        const d: Float32Array | null = await describeAt(v, t.box).catch(() => null);
        if (!alive) break;
        if (!d) continue;
        if (distance(base.d, d) > 0.62) { setStatus('Chehra badal gaya? — sirf MP camera ke saamne ho'); continue; }
        got[seg] = d; last = Date.now(); publish();
        if (got.every(Boolean)) {
          capRef.current = false; setCapturing(false);
          setStatus('Ho gaya ✓ — photo dekhiye aur Save kariye');
          continue;
        }
      }
    })();
    return () => { alive = false; stopCamera(stream); };
  }, [facing, problem]);

  const fromFile = async (file: File) => {
    setErr(null);
    const url = URL.createObjectURL(file);
    try {
      await loadFaceEngine();
      const img = new Image(); img.src = url; await img.decode();
      const fr = await analyse(img, true);
      if (fr.count !== 1 || !fr.descriptor) { setErr(fr.count > 1 ? 'Photo mein ek hi vyakti hona chahiye' : 'Photo mein chehra nahi mila'); return; }
      setSamples([Array.from(fr.descriptor)]); setPhoto(snapshot(img, 360, 0.8)); setStatus('Photo loaded — live capture is more accurate');
    } finally { URL.revokeObjectURL(url); }
  };

  // Paste a photo (Ctrl+V anywhere in this window, or the "Paste photo" button) — copied from WhatsApp / gallery / web
  const fromFileRef = useRef(fromFile);
  fromFileRef.current = fromFile;
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'));
      const f = item?.getAsFile();
      if (f) { e.preventDefault(); setCapturing(false); void fromFileRef.current(f); }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, []);
  const pasteButton = async () => {
    setErr(null);
    try {
      const items = await navigator.clipboard.read();
      for (const it of items) {
        const type = it.types.find((t) => t.startsWith('image/'));
        if (type) { setCapturing(false); await fromFile(new File([await it.getType(type)], 'pasted', { type })); return; }
      }
      setErr('Clipboard mein photo nahi hai — pehle photo Copy kariye');
    } catch {
      setErr('Paste ki permission nahi mili — photo copy karke yahan Ctrl+V dabaiye (phone pe neeche box mein long-press → Paste)');
    }
  };

  const save = async () => {
    capRef.current = false; setCapturing(false);     // 5+ directions are enough if the MP cannot turn further
    const r = await run(() => post('face/enroll', { employee_id: row.id, descriptors: samples, photo, consent }), `${row.full_name} enrolled`);
    if (r) onSaved();
  };

  return (
    <Modal title={`Face enrolment — ${row.full_name} (${row.employee_code})`} onClose={onClose} wide footer={<>
      <Button variant="ghost" onClick={onClose}>Cancel</Button>
      <Button variant="primary" busy={busy} disabled={!samples.length || !consent || (capturing && samples.length < 5)} onClick={() => void save()}>Save enrolment</Button>
    </>}>
      {problem ? <ErrorBox error="Camera is blocked on this http link. Use the HTTPS link or the Chrome flag described in the README (Face kiosk), or upload a photo below." /> : <>
        <div className="face-stage small-stage">
          <video ref={video} className={`face-video ${facing === 'user' ? 'mirror' : ''}`} playsInline muted />
          {capturing || samples.length > 1 ? <FaceRing ring={ring} front={front} /> : null}
          <div className="face-hint">{status}<div className="face-progress"><i style={{ width: `${(samples.length / NEED) * 100}%` }} /></div></div>
        </div>
        <div className="row gap wrap">
          <Button variant="primary" disabled={capturing} onClick={() => { setSamples([]); setPhoto(null); setRing(Array(RING).fill(false)); setFront(false); setCapturing(true); }}>{samples.length ? 'Retake' : 'Start capture'}</Button>
          <Button variant="ghost" onClick={() => setFacing(facing === 'user' ? 'environment' : 'user')}>Switch camera</Button>
        </div>
      </>}
      <ErrorBox error={err} />
      <div className="paste-row">
        <Button variant="primary" onClick={() => void pasteButton()}>Paste photo</Button>
        <div className="paste-box" contentEditable suppressContentEditableWarning onInput={(e) => { (e.target as HTMLElement).innerHTML = ''; }}>
          Photo copy karke yahan paste kariye (Ctrl+V / long-press → Paste)</div>
      </div>
      <label className="small muted">Ya file se: <input type="file" accept="image/*" onChange={(e) => { const f = e.target.files?.[0]; if (f) void fromFile(f); }} /></label>
      {photo && <div className="row gap"><img className="face-thumb" src={photo} alt="" /><span className="small muted">{samples.length} sample(s) ready</span></div>}
      <label className="check"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> MP ne apna chehra gate attendance ke liye register karne ki sahmati di hai (consent recorded)</label>
    </Modal>
  );
}

/** Face ID style ring: 8 parts round the face, each turns green when that direction is captured. */
function FaceRing({ ring, front }: { ring: boolean[]; front: boolean }) {
  const n = ring.length; const R = 46; const gap = 0.12;
  const arc = (i: number) => {
    const a0 = (i - 0.5) * (Math.PI * 2 / n) + gap; const a1 = (i + 0.5) * (Math.PI * 2 / n) - gap;
    const p = (a: number) => `${50 + R * Math.cos(a)} ${50 + R * Math.sin(a)}`;
    return `M ${p(a0)} A ${R} ${R} 0 0 1 ${p(a1)}`;
  };
  return (
    <svg className="face-ring" viewBox="0 0 100 100" aria-hidden>
      <circle cx="50" cy="50" r={R - 6} fill="none" stroke={front ? 'rgba(47,191,113,.55)' : 'rgba(255,255,255,.25)'} strokeWidth="1.2" />
      {ring.map((ok, i) => <path key={i} d={arc(i)} fill="none" strokeLinecap="round" strokeWidth={ok ? 5 : 3.5}
        stroke={ok ? '#2fbf71' : 'rgba(255,255,255,.45)'} />)}
    </svg>
  );
}
