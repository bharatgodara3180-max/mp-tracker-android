/**
 * Face enrolment: supervisor/ops/admin registers an MP's face (5 live samples, or a photo).
 * Consent is mandatory and audited. The server refuses a face that already belongs to
 * someone else, so one person cannot be enrolled under two employee codes.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { del, get, imageUrl, post } from '../lib/api';
import { useAuth } from '../hooks/useAuth';
import { FACE_QUALITY, analyse, cameraProblem, distance, loadFaceEngine, snapshot, startCamera, stopCamera } from '../lib/face';
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

const NEED = 5;

export function EnrollModal({ row, onClose, onSaved }: { row: Pick<Row, 'id' | 'employee_code' | 'full_name'>; onClose: () => void; onSaved: () => void }) {
  const { busy, run } = useAction();
  const video = useRef<HTMLVideoElement>(null);
  const [facing, setFacing] = useState<'user' | 'environment'>('user');
  const [status, setStatus] = useState('Loading…');
  const [capturing, setCapturing] = useState(false);
  const [samples, setSamples] = useState<number[][]>([]);
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
    (async () => {
      try {
        setStatus('Loading face models…');
        await loadFaceEngine();
        if (!alive || !video.current) return;
        stream = await startCamera(video.current, facing);
        setStatus('Ready — press Start capture');
      } catch (e) { setErr(e instanceof Error ? e.message : String(e)); return; }
      let got: Float32Array[] = [];
      let last = 0;
      while (alive) {
        const v = video.current;
        if (!v || !capRef.current) { got = []; await new Promise((r) => setTimeout(r, 150)); continue; }
        const fr = await analyse(v, true);
        let msg = '';
        if (fr.count === 0) msg = 'No face';
        else if (fr.count > 1) msg = 'Only the MP should be in the frame';
        else if (fr.sizeRatio < FACE_QUALITY.minSize) msg = 'Move closer';
        else if (!fr.centered) msg = 'Centre the face';
        else if (fr.score < FACE_QUALITY.minScore) msg = 'Look straight at the camera';
        if (!msg && fr.descriptor && Date.now() - last > 350) {
          if (got.length && distance(got[0], fr.descriptor) > 0.5) { got = []; msg = 'Face changed — restarting'; }
          else {
            got.push(fr.descriptor); last = Date.now();
            if (got.length === 2) setPhoto(snapshot(v, 360, 0.8));
            setSamples(got.map((d) => Array.from(d)));
            if (got.length >= NEED) { capRef.current = false; setCapturing(false); setStatus('Captured — check the photo and save'); continue; }
            msg = got.length === 1 ? 'Thoda left dekhiye' : got.length === 2 ? 'Thoda right dekhiye' : 'Seedha dekhiye';
          }
        }
        setStatus(msg ? `${msg} (${got.length}/${NEED})` : `Capturing ${got.length}/${NEED}`);
        await new Promise((r) => setTimeout(r, 80));
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
    const r = await run(() => post('face/enroll', { employee_id: row.id, descriptors: samples, photo, consent }), `${row.full_name} enrolled`);
    if (r) onSaved();
  };

  return (
    <Modal title={`Face enrolment — ${row.full_name} (${row.employee_code})`} onClose={onClose} wide footer={<>
      <Button variant="ghost" onClick={onClose}>Cancel</Button>
      <Button variant="primary" busy={busy} disabled={!samples.length || !consent || capturing} onClick={() => void save()}>Save enrolment</Button>
    </>}>
      {problem ? <ErrorBox error="Camera is blocked on this http link. Use the HTTPS link or the Chrome flag described in the README (Face kiosk), or upload a photo below." /> : <>
        <div className="face-stage small-stage">
          <video ref={video} className={`face-video ${facing === 'user' ? 'mirror' : ''}`} playsInline muted />
          <div className="face-hint">{status}<div className="face-progress"><i style={{ width: `${(samples.length / NEED) * 100}%` }} /></div></div>
        </div>
        <div className="row gap wrap">
          <Button variant="primary" disabled={capturing} onClick={() => { setSamples([]); setPhoto(null); setCapturing(true); }}>{samples.length ? 'Retake' : 'Start capture'}</Button>
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
