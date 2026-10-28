/**
 * Face enrolment from Workforce profile photos, using only two browser tabs:
 *  1. copy a script (it carries the IDs of MPs without a face)
 *  2. paste it in the Workforce tab's Console -> it opens each employee page, takes the profile photo and
 *     downloads one file "workforce-photos.json"
 *  3. pick that file here -> every photo is checked for one clear face and enrolled.
 * ID = digits at the end of the employee code (SFXPROD12537 -> 12537), else the badge number.
 */
import { useMemo, useRef, useState } from 'react';
import { ApiError, post } from '../lib/api';
import { analyse, loadFaceEngine, snapshot } from '../lib/face';
import { downloadCsv } from '../lib/export';
import { Button, Modal } from './ui';

export interface WfEmp { id?: string; employee_code: string; full_name: string; badge_code: string | null; is_active: boolean | number }
type Row = { code: string; name: string; wid: string; result: 'OK' | 'FAIL'; detail: string };

export const wfId = (e: Pick<WfEmp, 'employee_code' | 'badge_code'>) =>
  (e.employee_code.match(/(\d+)\s*$/) ?? (e.badge_code ?? '').match(/(\d+)\s*$/))?.[1] ?? null;

function consoleScript(ids: string[]): string {
  return `(async () => {
  const IDS = ${JSON.stringify(ids)};
  const XP = "//*[normalize-space()='Profile Photo']/following::img[1]";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const toData = (b) => new Promise((res, rej) => { const f = new FileReader(); f.onload = () => res(f.result); f.onerror = rej; f.readAsDataURL(b); });
  const w = window.open('about:blank', 'mp_wf_photos');
  if (!w) { alert('Popup block hai - address bar mein popup allow kariye aur script dobara chalaiye'); return; }
  const photos = {}, failed = {};
  for (let i = 0; i < IDS.length; i++) {
    const id = IDS[i];
    console.log('[' + (i + 1) + '/' + IDS.length + '] ' + id);
    try {
      w.location.href = location.origin + '/employee/details/' + id;
      await sleep(1200);
      let img = null;
      for (let t = 0; t < 60 && !img; t++) {
        try {
          const d = w.document;
          if (d && d.location.pathname.replace(/\\/+$/, '').endsWith('/' + id)) {
            const n = d.evaluate(XP, d, null, 9, null).singleNodeValue;
            if (n && n.complete && n.naturalWidth > 0) img = n;
          }
        } catch (e) { /* page still loading */ }
        if (!img) await sleep(500);
      }
      if (!img) { failed[id] = 'Profile Photo nahi mili'; continue; }
      const src = img.currentSrc || img.src;
      let data = null;
      try { const r = await fetch(src, { credentials: 'include' }); if (r.ok) data = await toData(await r.blob()); } catch (e) { /* try canvas */ }
      if (!data) {
        try { const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
              c.getContext('2d').drawImage(img, 0, 0); data = c.toDataURL('image/jpeg', 0.92); } catch (e) { /* blocked */ }
      }
      if (data) photos[id] = data; else failed[id] = 'photo download blocked: ' + String(src).slice(0, 150);
    } catch (e) { failed[id] = String(e); }
  }
  try { w.close(); } catch (e) { /* ignore */ }
  const blob = new Blob([JSON.stringify({ source: 'workforce', at: new Date().toISOString(), photos, failed })], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'workforce-photos.json';
  document.body.appendChild(a); a.click(); a.remove();
  console.log('DONE', Object.keys(photos).length, 'photos,', Object.keys(failed).length, 'failed', failed);
  alert('Ho gaya: ' + Object.keys(photos).length + ' photos (file: workforce-photos.json). Fail: ' + Object.keys(failed).length + '. Ab ye file MP Tracker mein chuniye.');
})();`;
}

const readText = (f: File) => f.text();
const readData = (f: File) => new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(f); });

export function WorkforcePhotosModal({ employees, enrolled, onClose, onDone }: {
  employees: WfEmp[]; enrolled: Set<string>; onClose: () => void; onDone: () => void;
}) {
  const pending = useMemo(() => employees.filter((e) => e.is_active && e.id && !enrolled.has(e.id) && wfId(e)), [employees, enrolled]);
  const ids = useMemo(() => [...new Set(pending.map((e) => wfId(e)!))], [pending]);
  const [copied, setCopied] = useState(false);
  const [photos, setPhotos] = useState<Record<string, string> | null>(null);
  const [failedFetch, setFailedFetch] = useState<Record<string, string>>({});
  const [consent, setConsent] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [running, setRunning] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const stop = useRef(false);
  const script = useMemo(() => consoleScript(ids), [ids]);

  const copy = async () => {
    try { await navigator.clipboard.writeText(script); setCopied(true); }
    catch { setMsg('Copy nahi hua — neeche box se Ctrl+A, Ctrl+C kariye'); }
  };

  const pickFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setMsg(null); setRows([]);
    const got: Record<string, string> = {};
    let fails: Record<string, string> = {};
    for (const f of [...files]) {
      if (f.name.toLowerCase().endsWith('.json')) {
        try {
          const j = JSON.parse(await readText(f));
          Object.assign(got, j.photos ?? {});
          fails = { ...fails, ...(j.failed ?? {}) };
        } catch { setMsg(`${f.name}: sahi file nahi hai`); }
      } else if (f.type.startsWith('image/')) {
        const id = f.name.match(/(\d+)\D*$/)?.[1];      // 12537.jpg
        if (id) got[id] = await readData(f);
      }
    }
    setPhotos(got); setFailedFetch(fails);
    if (!Object.keys(got).length) setMsg('Is file mein koi photo nahi mili');
  };

  const start = async () => {
    if (!photos) return;
    setRunning(true); stop.current = false; setMsg('Face models load ho rahe hain…');
    await loadFaceEngine();
    setMsg(null);
    const out: Row[] = [];
    const byId = new Map<string, WfEmp[]>();
    pending.forEach((e) => { const k = wfId(e)!; byId.set(k, [...(byId.get(k) ?? []), e]); });
    for (const [wid, data] of Object.entries(photos)) {
      if (stop.current) break;
      const list = byId.get(wid) ?? [];
      if (!list.length) continue;                       // already enrolled / not in MP Tracker
      for (const e of list) {
        const r: Row = { code: e.employee_code, name: e.full_name, wid, result: 'FAIL', detail: '' };
        try {
          const img = new Image(); img.src = data; await img.decode();
          const fr = await analyse(img, true);
          if (fr.count !== 1 || !fr.descriptor) r.detail = fr.count > 1 ? 'Photo mein ek se zyada chehre' : 'Photo mein chehra nahi mila';
          else {
            await post('face/enroll', { employee_id: e.id, descriptors: [Array.from(fr.descriptor)], photo: snapshot(img, 360, 0.8), consent: true });
            r.result = 'OK';
          }
        } catch (err) { r.detail = err instanceof ApiError || err instanceof Error ? err.message : String(err); }
        out.push(r); setRows([...out]);
      }
    }
    for (const [wid, why] of Object.entries(failedFetch)) {
      for (const e of byId.get(wid) ?? []) if (!photos[wid]) out.push({ code: e.employee_code, name: e.full_name, wid, result: 'FAIL', detail: `Workforce: ${why}` });
    }
    setRows([...out]); setRunning(false); onDone();
  };

  const ok = rows.filter((r) => r.result === 'OK').length;
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  return (
    <Modal title="Workforce se face photos" wide onClose={() => { stop.current = true; onClose(); }} footer={<>
      {rows.length > 0 && <Button onClick={() => downloadCsv(rows, [
        { header: 'Employee code', value: (r) => r.code }, { header: 'Workforce ID', value: (r) => r.wid }, { header: 'Name', value: (r) => r.name },
        { header: 'Result', value: (r) => r.result }, { header: 'Detail', value: (r) => r.detail }], `face-import-${stamp}`)}>Report (CSV)</Button>}
      {running ? <Button variant="danger" onClick={() => { stop.current = true; }}>Stop</Button>
        : <Button variant="primary" disabled={!photos || !consent || !Object.keys(photos).length} onClick={() => void start()}>Start enrolment</Button>}
    </>}>
      <p className="small"><b>{pending.length}</b> MP ka face baaki hai{pending.length !== ids.length ? ` (${ids.length} IDs)` : ''}.</p>
      <ol className="wf-steps">
        <li><b>Script copy kariye</b> <Button size="sm" variant="primary" disabled={!ids.length} onClick={() => void copy()}>{copied ? 'Copied ✓' : 'Copy script'}</Button>
          <textarea className="mono wf-script" readOnly value={script} onFocus={(e) => e.target.select()} /></li>
        <li><b>Workforce wale tab mein</b> (workforce.shadowfax.in, login ke saath) <span className="mono">F12</span> → <b>Console</b> → paste → Enter.
          <span className="muted small"> Chrome pehli baar paste rokta hai: Console mein <span className="mono">allow pasting</span> likh ke Enter, phir dobara paste.
          Popup block dikhe to address bar se "Always allow" kariye aur script dobara chalaiye.</span>
          <div className="muted small">Script ek-ek ID ka page kholegi (har MP ~2-3 sec) aur aakhir mein <b>workforce-photos.json</b> download karegi. Tab band mat kariye.</div></li>
        <li><b>Wo file yahan chuniye</b> <input type="file" accept=".json,image/*" multiple onChange={(e) => void pickFiles(e.target.files)} />
          {photos && <span className="small"> · {Object.keys(photos).length} photos{Object.keys(failedFetch).length ? `, ${Object.keys(failedFetch).length} Workforce pe nahi mili` : ''}</span>}
          <div className="muted small">Photo files (jaise 12537.jpg) bhi chun sakte hain.</div></li>
        <li><label className="check"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> In sab MPs ne apna chehra gate attendance ke liye register karne ki sahmati di hai (har MP ke naam pe consent record hoga)</label></li>
      </ol>
      {msg && <div className="error-box">{msg}</div>}
      {rows.length > 0 && <>
        <p className="small"><b>{ok}</b> OK · <b>{rows.length - ok}</b> fail{running ? ' · chal raha hai…' : ''}</p>
        <div className="wf-results"><table className="table compact"><tbody>
          {[...rows].reverse().slice(0, 300).map((r, i) => <tr key={i}><td className="mono">{r.code}</td><td>{r.name}</td>
            <td><span className={`pill tone-${r.result === 'OK' ? 'green' : 'red'}`}>{r.result}</span></td><td className="small">{r.detail}</td></tr>)}
        </tbody></table></div>
      </>}
    </Modal>
  );
}
