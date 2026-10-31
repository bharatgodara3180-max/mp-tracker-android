/**
 * Face enrolment: supervisor/ops/admin registers an MP's face (5 live samples, or a photo).
 * Consent is mandatory and audited. The server refuses a face that already belongs to
 * someone else, so one person cannot be enrolled under two employee codes.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { del, get, imageUrl, post } from '../lib/api';
import { useAuth } from '../hooks/useAuth';
import { cameraProblem, frameJpeg, lightHint, loadFaceEngine, startCamera, stopCamera, toJpeg, track, type Tracked } from '../lib/face';
import { MESH_IDX, delaunay, drawMesh } from '../lib/faceMesh';
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

/* Enrolment: the MP looks straight at the camera; 3 clear photos are taken automatically and the SERVER checks them strictly (one frontal, sharp, well-lit face) - anything less is rejected (face found anywhere,
   cut out and enlarged, same as the gate), shown on a round view with the face mesh. */
const NEED = 3;
const RING = NEED;

export function EnrollModal({ row, onClose, onSaved }: { row: Pick<Row, 'id' | 'employee_code' | 'full_name'>; onClose: () => void; onSaved: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [facing, setFacing] = useState<'user' | 'environment'>('user');
  const [status, setStatus] = useState('Loading…');
  const [capturing, setCapturing] = useState(false);
  const [samples, setSamples] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [ring, setRing] = useState<boolean[]>(() => Array(RING).fill(false));
  const [front, setFront] = useState(false);
  const mesh = useRef<HTMLCanvasElement>(null);
  const [consent, setConsent] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const problem = cameraProblem();
  const capRef = useRef(false);
  capRef.current = capturing;
  const retake = useRef(0);

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
      let got: string[] = [];
      let seenRetake = retake.current;
      let last = 0;
      let tris: [number, number, number][] | null = null;
      while (alive) {
        const v: HTMLVideoElement | null = video.current;
        const cv = mesh.current;
        if (!v) { await sleep(150); continue; }
        if (seenRetake !== retake.current) { seenRetake = retake.current; got = []; }      // Retake starts from zero
        if (!capRef.current && got.length && got.length < NEED) got = [];
        let t: Tracked | null = null;
        try { t = await track(v); } catch { await sleep(150); continue; }
        if (!alive) break;
        if (t && !tris) tris = delaunay(MESH_IDX.map((i) => t!.pts[i]));
        if (cv) drawMesh(cv, v, t?.pts ?? null, tris, facing === 'user', capRef.current && got.length ? 'rgba(47,191,113,.95)' : 'rgba(255,255,255,.85)');
        if (!capRef.current) {
          if (got.length < NEED) setStatus(!t ? 'Chehra camera mein laaiye' : (lightHint(v, t.box) || 'Ready — Start capture dabaiye'));
          await sleep(180); continue;
        }
        let msg = '';
        if (!t) msg = 'Chehra camera mein laaiye';
        else if (t.others) msg = 'Sirf MP camera ke saamne ho';
        else if (t.box.width < 110) msg = 'Thoda paas aaiye';
        else if (Math.abs(t.yaw) > 0.18 || Math.abs(t.roll) > 10 || t.pitch < 0.3) msg = 'Seedha camera ki taraf dekhiye';
        else if (t.box.x < 0 || t.box.y < 0 || t.box.x + t.box.width > t.vw || t.box.y + t.box.height > t.vh) msg = 'Pura chehra camera mein laaiye';
        if (msg || !t) { setStatus(`${msg} (${got.length}/${NEED})`); await sleep(70); continue; }
        const lh = lightHint(v, t.box);
        if (lh) { setStatus(`${lh} (${got.length}/${NEED})`); await sleep(120); continue; }     // never take a photo the server would refuse
        if (Date.now() - last < 700) { await sleep(60); continue; }
        const shot = frameJpeg(v);
        if (!shot) continue;
        got.push(shot); last = Date.now();
        setSamples([...got]);
        setRing(Array.from({ length: RING }, (_, i) => i < got.length)); setFront(true);
        if (got.length >= NEED) {
          capRef.current = false; setCapturing(false);
          setStatus('Ho gaya ✓ — consent tick karke Save kariye');
          continue;
        }
        setStatus(`Seedha dekhte rahiye… (${got.length}/${NEED})`);
      }
    })();
    return () => { alive = false; stopCamera(stream); };
  }, [facing, problem]);

  const fromFile = async (file: File) => {
    setErr(null);
    try { setSamples([await toJpeg(file)]); setStatus('Photo loaded — Save par server isko strictly check karega'); }
    catch { setErr('Ye photo khul nahi paayi'); }
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
    setErr(null); setSaving(true);
    try {
      const r = await post<{ ok: boolean; message?: string }>('face/enroll', { employee_id: row.id, photos: samples, consent });
      if (r.ok === false) { alert(r.message ?? 'Reject'); onSaved(); return; }      // already enrolled for someone else: both removed
      onSaved();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }       // e.g. "Photo reject: Photo dhundhli (blur) hai"
    finally { setSaving(false); }
  };

  return (
    <Modal title={`Face enrolment — ${row.full_name} (${row.employee_code})`} onClose={onClose} wide footer={<>
      <Button variant="ghost" onClick={onClose}>Cancel</Button>
      <Button variant="primary" busy={saving} disabled={!samples.length || !consent || capturing} onClick={() => void save()}>Save enrolment</Button>
    </>}>
      {problem ? <ErrorBox error="Camera is blocked on this http link. Use the HTTPS link or the Chrome flag described in the README (Face kiosk), or upload a photo below." /> : <>
        <div className="fid">
          <div className="fid-circle">
            <video ref={video} className={`face-video ${facing === 'user' ? 'mirror' : ''}`} playsInline muted />
            <canvas ref={mesh} className="fid-mesh" />
          </div>
          <FaceRing ring={ring} front={front} />
        </div>
        <div className="fid-hint">{status}<span className="muted small"> · {samples.length}/{NEED}</span></div>
        <div className="row gap wrap">
          <Button variant="primary" disabled={capturing} onClick={() => { retake.current++; setSamples([]); setRing(Array(RING).fill(false)); setFront(false); setCapturing(true); }}>{samples.length ? 'Retake' : 'Start capture'}</Button>
          <Button variant="ghost" onClick={() => setFacing(facing === 'user' ? 'environment' : 'user')}>Switch camera</Button>
        </div>
      </>}
      <label className="check"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> MP ne apna chehra gate attendance ke liye register karne ki sahmati di hai (consent recorded)</label>
      <ErrorBox error={err} />
      <div className="paste-row">
        <Button variant="primary" onClick={() => void pasteButton()}>Paste photo</Button>
        <div className="paste-box" contentEditable suppressContentEditableWarning onInput={(e) => { (e.target as HTMLElement).innerHTML = ''; }}>
          Photo copy karke yahan paste kariye (Ctrl+V / long-press → Paste)</div>
      </div>
      <label className="small muted">Ya file se: <input type="file" accept="image/*" onChange={(e) => { const f = e.target.files?.[0]; if (f) void fromFile(f); }} /></label>
      {samples.length > 0 && <div className="row gap"><img className="face-thumb" src={samples[0]} alt="" /><span className="small muted">{samples.length} photo(s) ready</span></div>}
    </Modal>
  );
}

/** Round progress: ticks all round the view turn green as the 5 samples are taken. */
function FaceRing({ ring, front }: { ring: boolean[]; front: boolean }) {
  const TICKS = 60;
  const done = ring.filter(Boolean).length;
  return (
    <svg className="fid-ring" viewBox="0 0 100 100" aria-hidden>
      {Array.from({ length: TICKS }, (_, k) => {
        const a = (k / TICKS) * Math.PI * 2 - Math.PI / 2;            // fills clockwise from the top
        const ok = front && k < Math.round((done / ring.length) * TICKS);
        const r0 = 44.5; const r1 = ok ? 49.5 : 47.5;
        return <line key={k} x1={50 + r0 * Math.cos(a)} y1={50 + r0 * Math.sin(a)} x2={50 + r1 * Math.cos(a)} y2={50 + r1 * Math.sin(a)}
          stroke={ok ? '#2fbf71' : 'rgba(255,255,255,.55)'} strokeWidth={ok ? 1.3 : 0.8} strokeLinecap="round" />;
      })}
    </svg>
  );
}
