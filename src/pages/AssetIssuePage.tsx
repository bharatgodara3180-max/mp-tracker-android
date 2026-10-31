/**
 * Asset Desk "Issue" for the operator, built into the app (so the front camera works):
 * pick Pickup / Floor (locked) -> camera fills the screen and finds the face -> employee shown, scan the asset -> issued ->
 * straight back to the camera. The face engine and the camera stay loaded the whole time.
 * Return / Overview / DC-DC open the normal Asset Desk page (<base>?tab=...).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { cameraProblem, loadFaceEngine } from '../lib/face';
import { CameraStage, useFaceCapture, type CaptureOutcome } from '../components/FaceKiosk';
import { beepErr, beepOk, beepWarn } from '../lib/beep';
import { lastLink } from '../lib/native';

const SKEY = 'sfxbm-ad';
const AREA_KEY = 'ad_issue_area';
const AREAS = ['Floor', 'Pickup'];
interface Sess { base: string; token: string; name: string; block: string }
interface Held { asset_id: string; type: string }
interface Emp { emp_id: string; name: string; designation?: string | null; held: Held[] }
interface Msg { kind: 'ok' | 'err' | 'warn'; text: string }
const native = () => (window as unknown as { SFXBMNative?: { setAuth(b: string, t: string): void; clearAuth(): void } }).SFXBMNative;
const store = (k: string, v: string | null) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* ignore */ } };
const load = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };

function initSess(): Sess | null {
  try {
    const h = window.location.hash; const qi = h.indexOf('?');
    if (qi >= 0) {
      const p = new URLSearchParams(h.slice(qi + 1)); const t = p.get('t'); const b = p.get('b');
      if (t && b) {
        const s: Sess = { base: b, token: t, name: p.get('n') ?? '', block: p.get('k') ?? '' };
        store(SKEY, JSON.stringify(s));
        window.history.replaceState(null, '', '#/asset-issue');
        return s;
      }
    }
    return JSON.parse(load(SKEY) ?? 'null') as Sess | null;
  } catch { return null; }
}

function ScanBox({ onSubmit }: { onSubmit: (v: string) => void }) {
  const el = useRef<HTMLInputElement>(null);
  const last = useRef({ v: '', t: 0 });
  useEffect(() => {
    el.current?.focus({ preventScroll: true });
    const t = setInterval(() => { if (document.activeElement !== el.current) el.current?.focus({ preventScroll: true }); }, 500);
    return () => clearInterval(t);
  }, []);
  return (
    <input ref={el} className="ai-scan" type="text" inputMode="none" placeholder="Scan Asset ID" autoComplete="off"
      autoCapitalize="characters" spellCheck={false} enterKeyHint="go"
      onClick={(e) => { const n = e.currentTarget; n.inputMode = 'text'; n.blur(); setTimeout(() => n.focus(), 30); }}
      onKeyDown={(e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const n = e.currentTarget; const v = n.value.trim(); n.value = ''; n.inputMode = 'none';
        if (!v) return;
        const now = Date.now();
        if (last.current.v === v && now - last.current.t < 1500) return;
        last.current = { v, t: now };
        onSubmit(v);
      }} />
  );
}

export default function AssetIssuePage() {
  const [s] = useState(initSess);
  const [area, setArea] = useState(() => load(AREA_KEY) ?? '');
  const [picking, setPicking] = useState(() => !load(AREA_KEY));
  const [step, setStep] = useState<'face' | 'asset'>('face');
  const [emp, setEmp] = useState<Emp | null>(null);
  const [msg, setMsg] = useState<Msg | null>(null);
  const [problem] = useState(cameraProblem());
  const stepRef = useRef(step); stepRef.current = step;
  const cool = useRef(0);

  useEffect(() => { void loadFaceEngine().catch(() => {}); }, []);               // loads once, stays for the whole session of this screen
  useEffect(() => { if (s) try { native()?.setAuth(s.base, s.token); } catch { /* ignore */ } }, [s]);
  useEffect(() => { if (!msg || msg.kind === 'err') return; const t = setTimeout(() => setMsg(null), 5000); return () => clearTimeout(t); }, [msg]);
  useEffect(() => {                                                                // forgotten employee page -> back to the camera
    if (step !== 'asset') return;
    const t = setTimeout(() => { setStep('face'); setEmp(null); cool.current = Date.now() + 2000; }, 30000);
    return () => clearTimeout(t);
  }, [step, emp]);

  const logout = useCallback(() => {
    store(SKEY, null);
    try { native()?.clearAuth(); } catch { /* ignore */ }
    window.location.replace(s ? `${s.base}go?out=1` : lastLink());
  }, [s]);

  const call = useCallback(async (path: string, body?: unknown) => {
    if (!s) throw new Error('Login karo');
    let res: Response;
    try {
      res = await fetch(`${s.base}api/${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${s.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch { throw new Error('Server tak nahi pahunch paaye - network check karo'); }
    let data: Record<string, unknown> | null = null;
    try { data = await res.json(); } catch { /* not json */ }
    if (res.status === 401) { logout(); throw new Error('Login expire ho gaya'); }
    if (!res.ok) throw new Error(String(data?.message ?? data?.detail ?? `Error ${res.status}`));
    return data as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  }, [s, logout]);

  const pickingRef = useRef(picking); pickingRef.current = picking;
  const onCapture = useCallback(async (d: number[]): Promise<CaptureOutcome | void> => {
    if (stepRef.current !== 'face' || pickingRef.current || Date.now() < cool.current) return { matched: true, holdMs: 350 };
    try {
      const r = await call('face-identify', { descriptor: d });
      if (!r.matched) { setMsg({ kind: 'err', text: 'Chehra pehchaana nahi gaya' }); beepErr(); return { matched: false }; }
      setEmp({ emp_id: r.emp_id, name: r.name, designation: r.designation, held: r.held ?? [] });
      setStep('asset'); setMsg(null); beepOk();
      return { matched: true, holdMs: 300 };
    } catch (e) { setMsg({ kind: 'err', text: e instanceof Error ? e.message : String(e) }); beepErr(); return { matched: false }; }
  }, [call]);

  const cam = useFaceCapture({ enabled: !!s && !problem, facing: 'user', requireBlink: false, onCapture, onReset: () => {} });

  const onAsset = async (v: string) => {
    if (!emp) return;
    try {
      const r = await call('issue', { emp_id: emp.emp_id, asset_id: v, issue_area: area });
      setMsg(r.auto_in
        ? { kind: 'warn', text: `Issued - it was with ${r.auto_in.emp_name} (${r.auto_in.emp_id}), AUTO IN done` }
        : { kind: 'ok', text: `Issued: ${r.asset_id} -> ${r.emp_name}` });
      if (r.auto_in) beepWarn(); else beepOk();
      cool.current = Date.now() + 3000;
      setStep('face'); setEmp(null);                                                // straight back to the face camera
    } catch (e) { setMsg({ kind: 'err', text: e instanceof Error ? e.message : String(e) }); beepErr(); }
  };

  const pick = (a: string) => { setArea(a); setPicking(false); store(AREA_KEY, a); setMsg(null); };
  const open = (tab: string) => { if (s) window.location.href = `${s.base}?tab=${tab}`; };

  if (!s) {
    return <div className="kiosk"><div className="kiosk-card"><h2>SFXBM</h2><p>Login karo.</p>
      <button className="btn primary" onClick={() => { window.location.href = lastLink(); }}>Login page</button></div></div>;
  }
  return (
    <div className="ai-screen">
      <header className="ai-top">
        <div className="who"><b>{s.name}</b>{s.block ? ` · ${s.block}` : ''}</div>
        <button type="button" onClick={() => open('txn')}>DC-DC Transaction</button>
        <button type="button" onClick={logout}>Logout</button>
      </header>
      {!picking && <div className="ai-area"><span>Issue Area: <b>{area}</b> 🔒</span>
        <button type="button" onClick={() => { setPicking(true); setStep('face'); setEmp(null); }}>Change</button></div>}
      <div className="ai-cam">
        {problem ? <div className="ai-over"><div className="ai-card"><h2>Camera nahi chal raha</h2></div></div>
          : <CameraStage cam={cam} mirror />}
        {msg && !picking && <div className={`ai-msg ${msg.kind}`} onClick={() => setMsg(null)}>{msg.text}</div>}
        {picking && (
          <div className="ai-over">
            <div className="ai-card">
              <h2>Select Issue Area</h2>
              <p className="ai-sub">Select the area this asset is being issued for.</p>
              <div className="ai-row2">{AREAS.map((a) => <button key={a} type="button" className="ai-big" onClick={() => pick(a)}>{a}</button>)}</div>
            </div>
          </div>
        )}
        {!picking && step === 'asset' && emp && (
          <div className="ai-over">
            <div className="ai-card">
              <div className="ai-emp"><div><b>{emp.name}</b><div className="ai-sub">{emp.emp_id} · {emp.designation || '-'}</div></div>
                <button type="button" onClick={() => { setStep('face'); setEmp(null); setMsg(null); cool.current = Date.now() + 2000; }}>Back / Next employee</button></div>
              {emp.held.length > 0 && <div className="ai-held">Currently holding: {emp.held.map((h) => `${h.asset_id} (${h.type})`).join(', ')}</div>}
              <h2>Step 2 - Scan Asset ID</h2>
              <ScanBox onSubmit={(v) => void onAsset(v)} />
            </div>
            {msg?.kind === 'err' && <div className="ai-errbox">{msg.text}</div>}
          </div>
        )}
      </div>
      <nav className="ai-nav">
        <button type="button" className="on">ISSUE</button>
        <button type="button" onClick={() => open('return')}>RETURN</button>
        <button type="button" onClick={() => open('overview')}>OVERVIEW</button>
      </nav>
    </div>
  );
}
