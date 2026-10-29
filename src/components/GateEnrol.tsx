/**
 * Gate operator: search an employee and enrol the face; not found -> add the employee (ID + name) and enrol.
 * A face that is already enrolled can only be changed by admin / supervisor (server rule).
 */
import { useEffect, useState } from 'react';
import { get, post, setStaffToken } from '../lib/api';
import { EnrollModal } from '../pages/FaceEnrollPage';
import { Button, Modal, useAction } from './ui';

interface Found { id: string; employee_code: string; full_name: string; designation: string | null; badge_code: string | null; samples: number }

export function GateEnrolButton({ onOpenChange, inline, staffLogin }: {
  onOpenChange?: (open: boolean) => void; inline?: boolean;
  /** gate tablet without a login (gate link): a staff member signs in first, only for this window */
  staffLogin?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const toggle = (v: boolean) => {
    setOpen(v); onOpenChange?.(v);
    if (!v && staffLogin) { setStaffToken(null); setSignedIn(false); }
  };
  return (
    <>
      <button className={inline ? 'people-btn' : 'gate-people'} onClick={() => toggle(true)} aria-label="Employee face enrol" title="Search employee / face enrol">
        <svg viewBox="0 0 24 24" width={inline ? 20 : 28} height={inline ? 20 : 28} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7" />
        </svg>
      </button>
      {open && (staffLogin && !signedIn
        ? <StaffLogin onClose={() => toggle(false)} onDone={() => setSignedIn(true)} />
        : <GateEnrolSheet onClose={() => toggle(false)} />)}
    </>
  );
}

const STAFF = ['admin', 'supervisor', 'gate_operator', 'ops_manager'];

function StaffLogin({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [u, setU] = useState(''); const [p, setP] = useState('');
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const go = async () => {
    setErr(null); setBusy(true);
    try {
      const r = await post<{ token: string; user: { role: string; full_name: string } }>('auth/login', { username: u.trim(), password: p });
      if (!STAFF.includes(r.user.role)) { setErr('Is login se face enrol nahi ho sakta'); return; }
      setStaffToken(r.token); onDone();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return (
    <Modal title="Staff login — face enrol" onClose={onClose} footer={<>
      <Button variant="ghost" onClick={onClose}>Cancel</Button>
      <Button variant="primary" busy={busy} disabled={!u.trim() || !p} onClick={() => void go()}>Login</Button></>}>
      <p className="muted small">Naya employee / face enrol karne ke liye gate operator, supervisor ya admin apna login daale. Window band hote hi login hat jayega.</p>
      <form className="gate-add" onSubmit={(e) => { e.preventDefault(); void go(); }}>
        <label className="field"><span className="field-label">Username</span><input autoFocus autoCapitalize="none" value={u} onChange={(e) => setU(e.target.value)} /></label>
        <label className="field"><span className="field-label">Password</span><input type="password" value={p} onChange={(e) => setP(e.target.value)} /></label>
        <button type="submit" hidden />
      </form>
      {err && <div className="error-box">{err}</div>}
    </Modal>
  );
}

function GateEnrolSheet({ onClose }: { onClose: () => void }) {
  const { busy, run } = useAction();
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<Found[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [adding, setAdding] = useState<{ code: string; name: string; designation: string } | null>(null);
  const [enrol, setEnrol] = useState<{ id: string; employee_code: string; full_name: string } | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    const t = q.trim();
    if (t.length < 2) { setRows(null); return; }
    let alive = true;
    setSearching(true);
    const h = setTimeout(() => {
      get<Found[]>('gate/employees', { q: t }).then((r) => { if (alive) setRows(r); })
        .catch(() => { if (alive) setRows([]); }).finally(() => { if (alive) setSearching(false); });
    }, 300);
    return () => { alive = false; clearTimeout(h); };
  }, [q, done]);

  const add = async () => {
    if (!adding?.code.trim() || !adding.name.trim()) return;
    const r = await run(() => post<{ id: string; employee_code: string; full_name: string }>('gate/employees',
      { employee_code: adding.code, full_name: adding.name, designation: adding.designation || null }), 'Employee add ho gaya');
    if (r) { setAdding(null); setEnrol(r); }
  };

  if (enrol) return <EnrollModal row={enrol} onClose={() => setEnrol(null)}
                                 onSaved={() => { setDone(enrol.full_name); setEnrol(null); }} />;

  return (
    <Modal title="Employee — face enrol" onClose={onClose} footer={<Button onClick={onClose}>Band karein</Button>}>
      {done && <div className="pill tone-green" style={{ alignSelf: 'flex-start' }}>{done} ka face enrol ho gaya ✓</div>}
      {!adding ? <>
        <input className="kiosk-input" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Employee ID / naam / badge likhiye" />
        {searching && <p className="muted small">Dhoondh rahe hain…</p>}
        {rows && rows.length > 0 && <ul className="gate-find">
          {rows.map((r) => <li key={r.id}>
            <div><b>{r.full_name}</b><span className="muted small mono"> {r.employee_code}{r.designation ? ` · ${r.designation}` : ''}</span></div>
            {r.samples > 0
              ? <span className="pill tone-green">Face enrolled</span>
              : <Button size="sm" variant="primary" onClick={() => setEnrol({ id: r.id, employee_code: r.employee_code, full_name: r.full_name })}>Face enrol</Button>}
          </li>)}
        </ul>}
        {rows && !searching && <div className="gate-notfound">
          {rows.length === 0 && <p>Koi employee nahi mila.</p>}
          <Button variant={rows.length ? 'ghost' : 'primary'} onClick={() => setAdding({ code: /\d/.test(q) ? q.trim().toUpperCase() : '', name: /\d/.test(q) ? '' : q.trim(), designation: '' })}>
            + Add new employee</Button>
        </div>}
      </> : <div className="gate-add">
        <h4>Naya employee</h4>
        <label className="field"><span className="field-label">Employee ID</span>
          <input value={adding.code} onChange={(e) => setAdding({ ...adding, code: e.target.value.toUpperCase() })} placeholder="SFXPROD12537" /></label>
        <label className="field"><span className="field-label">Naam</span>
          <input value={adding.name} onChange={(e) => setAdding({ ...adding, name: e.target.value })} placeholder="Poora naam" /></label>
        <label className="field"><span className="field-label">Designation (optional)</span>
          <input value={adding.designation} onChange={(e) => setAdding({ ...adding, designation: e.target.value })} placeholder="GROUND COORDINATOR (GC)" /></label>
        <div className="row gap">
          <Button variant="ghost" onClick={() => setAdding(null)}>Wapas</Button>
          <Button variant="primary" busy={busy} disabled={!adding.code.trim() || !adding.name.trim()} onClick={() => void add()}>Save aur face enrol</Button>
        </div>
        <p className="muted small">Shift, supervisor wagairah baad mein admin bhar dega.</p>
      </div>}
    </Modal>
  );
}
