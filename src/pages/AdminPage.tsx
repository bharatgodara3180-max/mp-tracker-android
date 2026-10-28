import { useState } from 'react';
import { del, get, post, put, rpc } from '../lib/api';
import { useLiveQuery } from '../hooks/useLive';
import { useRefData } from '../hooks/useRefData';
import { useAuth } from '../hooks/useAuth';
import type { Area, Device, Shift, AppRole } from '../lib/types';
import { Button, ErrorBox, Field, Loading, Modal, useAction, useToast, Pill } from '../components/ui';
import { fmtDateTime } from '../lib/format';
import { EnrollModal } from './FaceEnrollPage';
import { SAMPLE_HEADERS, SAMPLE_ROWS, prepareRows, type ImportIssue, type ImportRow } from '../lib/employeeImport';

const TABS = ['Areas & blocks', 'Shifts', 'Employees', 'Users & roles', 'Devices', 'Settings', 'Demo data'] as const;
const ROLES: AppRole[] = ['admin', 'ops_manager', 'supervisor', 'gate_operator'];   // MP logins are off

export default function AdminPage() {
  const [tab, setTab] = useState<(typeof TABS)[number]>(TABS[0]);
  return (
    <div className="page">
      <div className="tabs" role="tablist">{TABS.map((t) => <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{t}</button>)}</div>
      {tab === 'Areas & blocks' && <AreasAdmin />}
      {tab === 'Shifts' && <ShiftsAdmin />}
      {tab === 'Employees' && <EmployeesAdmin />}
      {tab === 'Users & roles' && <UsersAdmin />}
      {tab === 'Devices' && <DevicesAdmin />}
      {tab === 'Settings' && <SettingsAdmin />}
      {tab === 'Demo data' && <DemoAdmin />}
    </div>
  );
}

const save = (table: string, row: Record<string, unknown>, id?: string) => (id ? put(`admin/${table}/${id}`, row) : post(`admin/${table}`, row));

/* ---------- Areas ---------- */
function AreasAdmin() {
  const { areas, loading } = useRefData();
  const { busy, run } = useAction();
  const [edit, setEdit] = useState<Partial<Area> | null>(null);
  if (loading) return <Loading />;
  const submit = async () => {
    if (!edit?.code || !edit.name || !edit.kind) return;
    const row = { code: edit.code, name: edit.name, kind: edit.kind, out_purpose: edit.out_purpose || null, is_active: edit.is_active ?? true };
    if (await run(() => save('areas', row, edit.id), 'Area saved')) setEdit(null);
  };
  const remove = async (a: Area) => {
    if (!confirm(`Delete ${a.name}? (Jiski history hai wo delete nahi hoga — Disable kariye)`)) return;
    await run(() => del(`admin/areas/${a.id}`), 'Area deleted');
  };
  const OUT_LABEL: Record<string, string> = { PICKUP: 'OUT · Pickup', LUNCH: 'OUT · Lunch', OTHER: 'OUT · Other' };
  return (
    <section className="panel">
      <div className="row between"><h3>Areas & OUT options</h3><Button variant="primary" size="sm" onClick={() => setEdit({ kind: 'BLOCK', is_active: true, out_purpose: null })}>Add area</Button></div>
      <p className="muted small">Work areas yahan banaiye — Live dashboard aur supervisor app mein yahi dikhenge. Handover sab areas mein allowed hai.
        OUT option (Lunch / Pickup / Other…) banane ke liye "OUT type" chuniye — supervisor ke OUT assign mein yahi aayenge, aur Live mein har OUT option ke 2 card: "Assigned for …" aur "On …".</p>
      <table className="table compact"><thead><tr><th>Code</th><th>Name</th><th>Kind</th><th>Type</th><th>Status</th><th /></tr></thead>
        <tbody>{areas.map((a) => <tr key={a.id} className={a.is_active ? '' : 'muted'}><td className="mono">{a.code}</td><td>{a.name}</td><td>{a.kind}</td>
          <td>{a.out_purpose ? <Pill tone="blue">{OUT_LABEL[a.out_purpose] ?? a.out_purpose}</Pill> : 'Work area'}</td>
          <td>{a.is_active ? <Pill tone="green">Active</Pill> : <Pill tone="gray">Disabled</Pill>}</td>
          <td><Button size="sm" variant="ghost" onClick={() => setEdit(a)}>Edit</Button>
            <Button size="sm" variant="ghost" busy={busy} onClick={() => void run(() => save('areas', { is_active: !a.is_active }, a.id), a.is_active ? 'Disabled' : 'Enabled')}>{a.is_active ? 'Disable' : 'Enable'}</Button>
            <Button size="sm" variant="ghost" busy={busy} onClick={() => void remove(a)}>Delete</Button></td></tr>)}</tbody></table>
      {edit && <Modal title={edit.id ? `Edit ${edit.name}` : 'Add area / OUT option'} onClose={() => setEdit(null)}
        footer={<><Button variant="ghost" onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" busy={busy} onClick={() => void submit()}>Save</Button></>}>
        <div className="grid2">
          <Field label="Code"><input value={edit.code ?? ''} onChange={(e) => setEdit({ ...edit, code: e.target.value })} placeholder="BLK-D / LUNCH" /></Field>
          <Field label="Name"><input value={edit.name ?? ''} onChange={(e) => setEdit({ ...edit, name: e.target.value })} placeholder="Block D / Lunch" /></Field>
          <Field label="Kind" hint="Apna likhiye (jaise RTS, LOADING BAY) ya list se chuniye">
            <input list="area-kinds" value={edit.kind ?? ''} onChange={(e) => setEdit({ ...edit, kind: e.target.value.toUpperCase() })} placeholder="PRIMARY / DOCK / apna naam" />
            <datalist id="area-kinds">{[...new Set(['PRIMARY', 'SECONDARY', 'STAGING', 'DOCK', 'BLOCK', 'OUT', ...areas.map((a) => a.kind)])].map((k) => <option key={k} value={k} />)}</datalist>
          </Field>
          <Field label="Type" hint="OUT type = ye area OUT option hai (deploy nahi hota)">
            <select value={edit.out_purpose ?? ''} onChange={(e) => setEdit({ ...edit, out_purpose: (e.target.value || null) as Area['out_purpose'], kind: e.target.value && !edit.kind ? 'OUT' : edit.kind })}>
              <option value="">Work area (deploy)</option>
              <option value="LUNCH">OUT · Lunch (45 min return rule)</option>
              <option value="PICKUP">OUT · Pickup</option>
              <option value="OTHER">OUT · Other</option>
            </select>
          </Field>
        </div>
        <label className="check"><input type="checkbox" checked={edit.is_active ?? true} onChange={(e) => setEdit({ ...edit, is_active: e.target.checked })} /> Active</label>
      </Modal>}
    </section>
  );
}

/* ---------- Shifts ---------- */
function ShiftsAdmin() {
  const { shifts } = useRefData();
  const { busy, run } = useAction();
  const [edit, setEdit] = useState<Partial<Shift> | null>(null);
  const submit = async () => {
    if (!edit?.code || !edit.name || !edit.start_time || !edit.end_time) return;
    const row = { code: edit.code, name: edit.name, start_time: edit.start_time.slice(0, 5), end_time: edit.end_time.slice(0, 5), is_active: edit.is_active ?? true };
    if (await run(() => save('shifts', row, edit.id), 'Shift saved')) setEdit(null);
  };
  return (
    <section className="panel">
      <div className="row between"><h3>Shifts</h3><Button size="sm" variant="primary" onClick={() => setEdit({ is_active: true })}>Add shift</Button></div>
      <p className="muted small">An end time earlier than the start time is an overnight shift; attendance is filed under the date the shift started.</p>
      <table className="table compact"><thead><tr><th>Code</th><th>Name</th><th>Start</th><th>End</th><th>Overnight</th><th>Active</th><th /></tr></thead>
        <tbody>{shifts.map((s) => <tr key={s.id}><td className="mono">{s.code}</td><td>{s.name}</td><td>{s.start_time.slice(0, 5)}</td><td>{s.end_time.slice(0, 5)}</td><td>{s.crosses_midnight ? 'Yes' : ''}</td><td>{s.is_active ? 'Yes' : 'No'}</td>
          <td><Button size="sm" variant="ghost" onClick={() => setEdit(s)}>Edit</Button></td></tr>)}</tbody></table>
      {edit && <Modal title={edit.id ? 'Edit shift' : 'Add shift'} onClose={() => setEdit(null)} footer={<><Button variant="ghost" onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" busy={busy} onClick={() => void submit()}>Save</Button></>}>
        <div className="grid2">
          <Field label="Code"><input value={edit.code ?? ''} onChange={(e) => setEdit({ ...edit, code: e.target.value })} /></Field>
          <Field label="Name"><input value={edit.name ?? ''} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
          <Field label="Start"><input type="time" value={edit.start_time?.slice(0, 5) ?? ''} onChange={(e) => setEdit({ ...edit, start_time: e.target.value })} /></Field>
          <Field label="End"><input type="time" value={edit.end_time?.slice(0, 5) ?? ''} onChange={(e) => setEdit({ ...edit, end_time: e.target.value })} /></Field>
        </div>
        <label className="check"><input type="checkbox" checked={edit.is_active ?? true} onChange={(e) => setEdit({ ...edit, is_active: e.target.checked })} /> Active</label>
      </Modal>}
    </section>
  );
}

/* ---------- Employees ---------- */
interface Emp { id?: string; employee_code: string; full_name: string; designation: string | null; default_shift_id: string | null;
  default_supervisor_user_id: string | null; badge_code: string | null; device_person_id: string | null; is_active: boolean | number; is_demo?: boolean | number }

function EmployeesAdmin() {
  const ref = useRefData();
  const { busy, run } = useAction();
  const [q, setQ] = useState('');
  const [edit, setEdit] = useState<Emp | null>(null);
  const [bulk, setBulk] = useState(false);
  const [faceFor, setFaceFor] = useState<{ id: string; employee_code: string; full_name: string } | null>(null);
  const [faceAfterSave, setFaceAfterSave] = useState(true);
  const list = useLiveQuery<Emp[]>(() => get<Emp[]>('admin/employees'), [], []);
  const faces = useLiveQuery<{ id: string; samples: number }[]>(() => get('face/enrollments'), [], []);
  const enrolled = new Set((faces.data ?? []).filter((f) => f.samples > 0).map((f) => f.id));
  const rows = (list.data ?? []).filter((e) => !q || `${e.employee_code} ${e.full_name} ${e.badge_code ?? ''}`.toLowerCase().includes(q.toLowerCase()));

  const submit = async () => {
    if (!edit?.employee_code || !edit.full_name) return;
    const { id, is_demo: _d, ...row } = edit;
    const saved = await run(() => save('employees', { ...row, is_active: !!row.is_active }, id), 'Employee saved') as Emp | undefined;
    if (saved) {
      setEdit(null); list.refresh();
      // new employee -> straight to face capture (can be switched off in the form)
      if (!id && faceAfterSave && saved.id) setFaceFor({ id: saved.id, employee_code: saved.employee_code, full_name: saved.full_name });
    }
  };

  return (
    <section className="panel">
      <div className="row between"><h3>Employees (MP master)</h3>
        <div className="row gap"><input type="search" className="search" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
          <Button size="sm" onClick={() => void downloadSample()}>Download sample</Button>
          <Button size="sm" onClick={() => setBulk(true)}>Bulk import (file)</Button>
          <Button size="sm" variant="primary" onClick={() => setEdit({ employee_code: '', full_name: '', designation: null, default_shift_id: null, default_supervisor_user_id: null, badge_code: null, device_person_id: null, is_active: true })}>Add employee</Button></div></div>
      <ErrorBox error={list.error} />
      <table className="table compact"><thead><tr><th>Code</th><th>Name</th><th>Designation</th><th>Shift</th><th>Supervisor</th><th>Badge / QR</th><th>Face</th><th>Status</th><th /></tr></thead>
        <tbody>{rows.slice(0, 500).map((e) => <tr key={e.id} className={e.is_active ? '' : 'muted'}>
          <td className="mono">{e.employee_code}{e.is_demo ? <span className="demo-tag">DEMO</span> : null}</td><td>{e.full_name}</td><td>{e.designation ?? ''}</td>
          <td>{ref.shifts.find((s) => s.id === e.default_shift_id)?.code ?? ''}</td><td>{ref.supervisors.find((s) => s.user_id === e.default_supervisor_user_id)?.full_name ?? ''}</td>
          <td className="mono">{e.badge_code ?? ''}</td>
          <td>{enrolled.has(e.id!) ? <span className="pill tone-green">Enrolled</span> : <span className="pill tone-amber">Nahi</span>}</td>
          <td>{e.is_active ? 'Active' : 'Inactive'}</td>
          <td className="row gap"><Button size="sm" variant="ghost" onClick={() => setEdit(e)}>Edit</Button>
            {!!e.is_active && <Button size="sm" variant="ghost" onClick={() => setFaceFor({ id: e.id!, employee_code: e.employee_code, full_name: e.full_name })}>{enrolled.has(e.id!) ? 'Face again' : 'Face capture'}</Button>}</td></tr>)}</tbody></table>
      {rows.length > 500 && <p className="muted small">Showing first 500 — refine the search.</p>}
      {edit && <Modal title={edit.id ? `Edit ${edit.full_name}` : 'Add employee'} onClose={() => setEdit(null)} footer={<><Button variant="ghost" onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" busy={busy} onClick={() => void submit()}>Save</Button></>}>
        <div className="grid2">
          <Field label="Employee code"><input value={edit.employee_code} onChange={(e) => setEdit({ ...edit, employee_code: e.target.value })} /></Field>
          <Field label="Full name"><input value={edit.full_name} onChange={(e) => setEdit({ ...edit, full_name: e.target.value })} /></Field>
          <Field label="Designation"><input value={edit.designation ?? ''} onChange={(e) => setEdit({ ...edit, designation: e.target.value })} /></Field>
          <Field label="Default shift"><select value={edit.default_shift_id ?? ''} onChange={(e) => setEdit({ ...edit, default_shift_id: e.target.value })}><option value="">—</option>{ref.shifts.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
          <Field label="Default supervisor"><select value={edit.default_supervisor_user_id ?? ''} onChange={(e) => setEdit({ ...edit, default_supervisor_user_id: e.target.value })}><option value="">—</option>{ref.supervisors.map((s) => <option key={s.user_id} value={s.user_id}>{s.full_name}</option>)}</select></Field>
          <Field label="Badge / QR value" hint="Printed on the ID card for the QR kiosk"><input value={edit.badge_code ?? ''} onChange={(e) => setEdit({ ...edit, badge_code: e.target.value })} /></Field>
        </div>
        <label className="check"><input type="checkbox" checked={!!edit.is_active} onChange={(e) => setEdit({ ...edit, is_active: e.target.checked })} /> Active</label>
        {edit.id
          ? <Button size="sm" onClick={() => { setFaceFor({ id: edit.id!, employee_code: edit.employee_code, full_name: edit.full_name }); setEdit(null); }}>{enrolled.has(edit.id) ? 'Face photo dobara capture karein' : 'Face photo capture karein'}</Button>
          : <label className="check"><input type="checkbox" checked={faceAfterSave} onChange={(e) => setFaceAfterSave(e.target.checked)} /> Save ke baad face photo capture karein</label>}
      </Modal>}
      {faceFor && <EnrollModal row={faceFor} onClose={() => setFaceFor(null)} onSaved={() => { setFaceFor(null); faces.refresh(); }} />}
      {bulk && <BulkImportModal onClose={() => setBulk(false)} onDone={() => { setBulk(false); list.refresh(); }} />}
    </section>
  );
}

/* ---------- Users ---------- */
interface UserRow { id: string; username: string; full_name: string; role: AppRole; employee_id: string | null; is_active: number | boolean }
function UsersAdmin() {
  const { areas } = useRefData();
  const { profile } = useAuth();
  const { busy, run } = useAction();
  const toast = useToast();
  const data = useLiveQuery(async () => {
    const [u, emps] = await Promise.all([
      get<{ users: UserRow[]; supervisor_areas: { user_id: string; area_id: string }[] }>('admin/users'),
      get<{ id: string; employee_code: string; full_name: string; is_active: number }[]>('admin/employees'),
    ]);
    return { ...u, emps: emps.filter((e) => e.is_active) };
  }, [], []);
  const [add, setAdd] = useState<{ username: string; full_name: string; role: AppRole; employee_id: string; password: string } | null>(null);
  const [pw, setPw] = useState<UserRow | null>(null);
  const [newPw, setNewPw] = useState('');

  if (!data.data) return <><ErrorBox error={data.error} /><Loading /></>;
  const d = data.data;
  const update = (u: UserRow, patch: Record<string, unknown>) => run(() => put(`admin/users/${u.id}`, patch), 'User updated').then(() => data.refresh());
  const toggleArea = (userId: string, areaId: string, on: boolean) => run(() => put('admin/supervisor-areas', { user_id: userId, area_id: areaId, on })).then(() => data.refresh());

  return (
    <section className="panel">
      <div className="row between"><h3>Users & roles</h3><Button size="sm" variant="primary" onClick={() => setAdd({ username: '', full_name: '', role: 'supervisor', employee_id: '', password: '' })}>Create user</Button></div>
      <p className="muted small">Logins are stored on this server (no cloud). MP logins (for receiving handovers on phone) must be linked to their employee record. Changing a role or disabling signs that user out everywhere.</p>
      <table className="table compact"><thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Linked employee</th><th>Supervisor areas</th><th>Active</th><th /></tr></thead>
        <tbody>{d.users.map((u) => <tr key={u.id}>
          <td>{u.full_name}</td><td className="mono">{u.username}</td>
          <td><select value={u.role} disabled={busy || u.id === profile?.user_id} onChange={(e) => void update(u, { role: e.target.value })}>{ROLES.map((r) => <option key={r}>{r}</option>)}</select></td>
          <td><select value={u.employee_id ?? ''} disabled={busy} onChange={(e) => void update(u, { employee_id: e.target.value || null })}><option value="">—</option>{d.emps.map((e) => <option key={e.id} value={e.id}>{e.employee_code} · {e.full_name}</option>)}</select></td>
          <td>{u.role === 'supervisor' ? <div className="area-tags">{areas.filter((a) => a.is_active).map((a) => {
            const on = d.supervisor_areas.some((x) => x.user_id === u.id && x.area_id === a.id);
            return <button key={a.id} className={`tag ${on ? 'on' : ''}`} onClick={() => void toggleArea(u.id, a.id, !on)}>{a.code}</button>;
          })}</div> : '—'}</td>
          <td><input type="checkbox" checked={!!u.is_active} disabled={u.id === profile?.user_id} onChange={(e) => void update(u, { is_active: e.target.checked })} aria-label="Active" /></td>
          <td><Button size="sm" variant="ghost" onClick={() => { setPw(u); setNewPw(''); }}>Reset password</Button></td></tr>)}</tbody></table>
      {add && <Modal title="Create user" onClose={() => setAdd(null)} footer={<><Button variant="ghost" onClick={() => setAdd(null)}>Cancel</Button>
        <Button variant="primary" busy={busy} onClick={async () => {
          if (add.password.length < 8) { toast('err', 'Password must be at least 8 characters'); return; }
          if (add.role === 'mp' && !add.employee_id) { toast('err', 'MP login must be linked to an employee'); return; }
          const r = await run(() => post('admin/users', { ...add, employee_id: add.employee_id || null }), 'User created');
          if (r) { setAdd(null); data.refresh(); }
        }}>Create</Button></>}>
        <div className="grid2">
          <Field label="Full name"><input value={add.full_name} onChange={(e) => setAdd({ ...add, full_name: e.target.value })} /></Field>
          <Field label="Username (for login)"><input value={add.username} autoComplete="off" onChange={(e) => setAdd({ ...add, username: e.target.value })} /></Field>
          <Field label="Role"><select value={add.role} onChange={(e) => setAdd({ ...add, role: e.target.value as AppRole })}>{ROLES.map((r) => <option key={r}>{r}</option>)}</select></Field>
          <Field label="Linked employee (required for MP)"><select value={add.employee_id} onChange={(e) => setAdd({ ...add, employee_id: e.target.value })}><option value="">—</option>{d.emps.map((e) => <option key={e.id} value={e.id}>{e.employee_code} · {e.full_name}</option>)}</select></Field>
          <Field label="Password (min 8)"><input type="password" autoComplete="new-password" value={add.password} onChange={(e) => setAdd({ ...add, password: e.target.value })} /></Field>
        </div>
      </Modal>}
      {pw && <Modal title={`Reset password — ${pw.full_name}`} onClose={() => setPw(null)} footer={<><Button variant="ghost" onClick={() => setPw(null)}>Cancel</Button>
        <Button variant="primary" busy={busy} onClick={async () => { if (await run(() => post(`admin/users/${pw.id}/password`, { password: newPw }), 'Password reset')) setPw(null); }}>Reset</Button></>}>
        <Field label="New password (min 8)"><input type="password" autoComplete="new-password" value={newPw} onChange={(e) => setNewPw(e.target.value)} /></Field>
      </Modal>}
    </section>
  );
}

/* ---------- Employee bulk import from a file ---------- */
async function downloadSample() {
  const XLSX = await import('xlsx');
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([[...SAMPLE_HEADERS], ...SAMPLE_ROWS]);
  ws['!cols'] = [{ wch: 16 }, { wch: 24 }, { wch: 16 }, { wch: 14 }, { wch: 16 }];
  // keep codes as text so Excel does not drop leading zeros
  const range = XLSX.utils.decode_range(ws['!ref'] ?? 'A1');
  for (let r = 0; r <= range.e.r; r++) for (const c of [0, 3, 4]) { const ref = XLSX.utils.encode_cell({ r, c }); if (ws[ref]) ws[ref].z = '@'; }
  XLSX.utils.book_append_sheet(wb, ws, 'Employees');
  const help = XLSX.utils.aoa_to_sheet([
    ['Column', 'Zaroori?', 'Kya likhna hai'],
    ['employee_code', 'Haan', 'Har MP ka unique code (jaise EMP1001). Same code dobara import karne pe details update ho jaati hain.'],
    ['full_name', 'Haan', 'MP ka poora naam'],
    ['designation', 'Nahi', 'Sorter / Loader / Picker …'],
    ['shift', 'Nahi', 'Shift timing START-END, jaise 09:00-18:00 ya 21:30-06:30 (raat wali). Nayi timing ki shift apne-aap ban jaati hai. Ya pehle se bani shift ka code (S1).'],
    ['badge_code', 'Nahi', 'ID card ke QR / barcode ki value. Khaali chhodo to employee_code hi use hoga.'],
    [],
    ['Tips', '', 'Pehli line (headings) mat badliye. Example rows hata ke apni list daaliye. Save as .xlsx ya .csv, phir Admin → Employees → Bulk import (file).'],
  ]);
  help['!cols'] = [{ wch: 16 }, { wch: 10 }, { wch: 110 }];
  XLSX.utils.book_append_sheet(wb, help, 'Instructions');
  XLSX.writeFile(wb, 'MP_employees_sample.xlsx');
}

function BulkImportModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { busy, run } = useAction();
  const ref = useRefData();
  const [file, setFile] = useState<string | null>(null);
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [issues, setIssues] = useState<ImportIssue[]>([]);
  const [error, setError] = useState<string | null>(null);

  const readFile = async (f: File) => {
    setError(null); setRows([]); setIssues([]); setFile(f.name);
    try {
      const XLSX = await import('xlsx');
      const wb = XLSX.read(await f.arrayBuffer(), { type: 'array', raw: false });
      const sheet = wb.Sheets[wb.SheetNames.find((n) => /employee/i.test(n)) ?? wb.SheetNames[0]];
      const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '', raw: true });
      const r = prepareRows(raw, ref.shifts.map((x) => x.code));
      if (r.missingColumns.length) { setError(`File mein ye columns nahi mile: ${r.missingColumns.join(', ')}. Sample file ki headings use kariye.`); return; }
      if (!r.rows.length && !r.issues.length) { setError('File mein koi employee row nahi mili.'); return; }
      setRows(r.rows); setIssues(r.issues);
    } catch (e) {
      setError(`File padh nahi paaye: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const doImport = async () => {
    const r = await run(() => post<{ imported: number }>('admin/employees/bulk', { rows }));
    if (r) { alert(`${r.imported} employees import / update ho gaye${issues.length ? ` (${issues.length} rows chhodi gayi)` : ''}`); onDone(); }
  };

  return (
    <Modal wide title="Bulk import employees (file)" onClose={onClose} footer={<>
      <Button variant="ghost" onClick={onClose}>Cancel</Button>
      <Button variant="primary" busy={busy} disabled={!rows.length} onClick={() => void doImport()}>Import {rows.length || ''} employees</Button></>}>
      <p className="small">Excel (.xlsx / .xls) ya CSV file chuniye. Format ke liye <button className="link-btn" onClick={() => void downloadSample()}>sample file download kariye</button>.
        Same employee code dobara aaye to uski details update ho jaati hain.</p>
      <input type="file" accept=".xlsx,.xls,.csv" onChange={(e) => { const f = e.target.files?.[0]; if (f) void readFile(f); e.target.value = ''; }} />
      {file && <p className="small muted">File: <b>{file}</b></p>}
      <ErrorBox error={error} />
      {(rows.length > 0 || issues.length > 0) && <>
        <p className="small"><span className="pill tone-green">{rows.length} ready</span>{issues.length > 0 && <> <span className="pill tone-red">{issues.length} rows mein galti — chhodi jayengi</span></>}</p>
        {issues.length > 0 && <div className="sync-error"><ul>{issues.slice(0, 50).map((i) => <li key={i.line}>Line {i.line}: {i.message}</li>)}</ul>
          {issues.length > 50 && <div>… aur {issues.length - 50}</div>}</div>}
        <table className="table compact"><thead><tr><th>Code</th><th>Name</th><th>Designation</th><th>Shift</th><th>Badge / QR</th></tr></thead>
          <tbody>{rows.slice(0, 15).map((r) => <tr key={r.employee_code}><td className="mono">{r.employee_code}</td><td>{r.full_name}</td><td>{r.designation}</td><td className="mono">{r.shift_code}</td><td className="mono">{r.badge_code || r.employee_code}</td></tr>)}</tbody></table>
        {rows.length > 15 && <p className="small muted">Pehli 15 rows dikha rahe hain (kul {rows.length}).</p>}
      </>}
    </Modal>
  );
}

/* ---------- Devices ---------- */
function DevicesAdmin() {
  const { busy, run } = useAction();
  const list = useLiveQuery<Device[]>(() => get<Device[]>('devices'), [], []);
  const [edit, setEdit] = useState<Partial<Device> | null>(null);
  const [secret, setSecret] = useState<{ code: string; secret: string } | null>(null);
  const [link, setLink] = useState<{ id: string; code: string; url: string } | null>(null);
  const openLink = async (id: string, rotate = false) => {
    const r = await run(() => post<{ device_code: string; key: string }>(`admin/devices/${id}/kiosk-link`, { rotate }), rotate ? 'New link made — the old link has stopped working' : undefined);
    if (r) {
      const base = `${window.location.origin}${window.location.pathname}`;
      setLink({ id, code: r.device_code, url: `${base}#/dc-gate?d=${encodeURIComponent(r.device_code)}&k=${encodeURIComponent(r.key)}` });
      list.refresh();
    }
  };
  const submit = async () => {
    if (!edit?.device_code || !edit.name) return;
    const row = { device_code: edit.device_code, name: edit.name, adapter: edit.adapter ?? 'face_kiosk', direction_mode: edit.direction_mode ?? 'toggle',
                  location_label: edit.location_label ?? null, is_active: edit.is_active ?? true };
    if (await run(() => save('devices', row, edit.id), 'Device saved')) { setEdit(null); list.refresh(); }
  };
  return (
    <section className="panel">
      <div className="row between"><h3>Gate devices</h3><Button size="sm" variant="primary" onClick={() => setEdit({ adapter: 'face_kiosk', direction_mode: 'toggle', is_active: true, location_label: 'DC entrance' })}>Register device</Button></div>
      <p className="muted small">Gate tablet = adapter <b>face_kiosk</b> → save karke "Gate link". Each device signs its requests with its own secret. "Show new secret" rotates it and displays it once — enter it on the tablet / relay. The old secret stops working immediately.</p>
      {!list.data ? <Loading /> : <table className="table compact"><thead><tr><th>Code</th><th>Name</th><th>Adapter</th><th>Direction</th><th>Location</th><th>Heartbeat</th><th>Active</th><th /></tr></thead>
        <tbody>{list.data.map((d) => <tr key={d.id}><td className="mono">{d.device_code}</td><td>{d.name}</td><td>{d.adapter}</td><td>{d.direction_mode}</td><td>{d.location_label ?? ''}</td><td>{fmtDateTime(d.last_heartbeat_at)}</td><td>{d.is_active ? 'Yes' : 'No'}</td>
          <td><Button size="sm" variant="ghost" onClick={() => setEdit({ ...d, is_active: !!d.is_active })}>Edit</Button>
            {d.adapter === 'face_kiosk' && <Button size="sm" variant="primary" busy={busy} onClick={() => void openLink(d.id)}>Gate link</Button>}
            {!['qr_kiosk', 'face_kiosk'].includes(d.adapter) && <Button size="sm" variant="ghost" busy={busy} onClick={async () => {
              if (!confirm(`Rotate the secret for ${d.device_code}? The tablet must be updated with the new one.`)) return;
              const r = await run(() => post<{ secret: string }>(`admin/devices/${d.id}/rotate-secret`));
              if (r) setSecret({ code: d.device_code, secret: r.secret });
            }}>Show new secret</Button>}
            <Button size="sm" variant="ghost" busy={busy} onClick={async () => {
              if (!confirm(`Delete device ${d.device_code}? (Jiske scans hain wo delete nahi hoga — Edit karke Active hataiye)`)) return;
              if (await run(() => del(`admin/devices/${d.id}`), 'Device deleted')) list.refresh();
            }}>Delete</Button></td></tr>)}</tbody></table>}
      {list.data && !list.data.length && <p className="muted small">Koi device nahi. Gate tablet ke liye "Register device" (adapter face_kiosk) dabaiye, phir "Gate link" se link lijiye.</p>}
      {link && <Modal title={`Gate link — ${link.code}`} onClose={() => setLink(null)} footer={<>
        <Button variant="ghost" busy={busy} onClick={() => { if (confirm('Make a new link? The tablet with the old link will stop working until you open the new one.')) void openLink(link.id, true); }}>New link (old stops)</Button>
        <Button variant="primary" onClick={() => setLink(null)}>Done</Button></>}>
        <p className="small">Ye link gate tablet ke Chrome mein kholiye aur bookmark / home-screen pe add kar dijiye. <b>Login nahi chahiye.</b> Is link se sirf DC IN / OUT hota hai — app ka koi aur page nahi khulta.</p>
        <input className="mono" style={{ width: "100%" }} readOnly value={link.url} onFocus={(e) => e.target.select()} />
        <div className="row gap"><Button size="sm" onClick={() => void navigator.clipboard?.writeText(link.url).catch(() => {})}>Copy</Button></div>
        <p className="small muted">Camera ke liye HTTPS chahiye: public link (…/MP/) se kholiye, ya LAN link ke liye tablet Chrome mein <span className="mono">chrome://flags/#unsafely-treat-insecure-origin-as-secure</span> mein server ka address daaliye. Link kisi ko mil jaye to "New link" dabaiye.</p>
      </Modal>}
      {secret && <Modal title={`New secret — ${secret.code}`} onClose={() => setSecret(null)} footer={<Button variant="primary" onClick={() => setSecret(null)}>Done</Button>}>
        <p className="small">Copy this now. It will not be shown again.</p>
        <input className="mono" readOnly value={secret.secret} onFocus={(e) => e.target.select()} />
      </Modal>}
      {edit && <Modal title={edit.id ? 'Edit device' : 'Register device'} onClose={() => setEdit(null)} footer={<><Button variant="ghost" onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" busy={busy} onClick={() => void submit()}>Save</Button></>}>
        <div className="grid2">
          <Field label="Device code"><input value={edit.device_code ?? ''} onChange={(e) => setEdit({ ...edit, device_code: e.target.value })} /></Field>
          <Field label="Name"><input value={edit.name ?? ''} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
          <Field label="Adapter" hint="generic_webhook = documented JSON push; qr_kiosk = this app's kiosk; vendor_* once mapped"><select value={edit.adapter} onChange={(e) => setEdit({ ...edit, adapter: e.target.value })}>
            {['face_kiosk', 'generic_webhook', 'qr_kiosk', 'vendor_template', 'manual'].map((a) => <option key={a}>{a}</option>)}</select></Field>
          <Field label="Direction mode"><select value={edit.direction_mode} onChange={(e) => setEdit({ ...edit, direction_mode: e.target.value })}>
            <option value="toggle">toggle (infer from presence)</option><option value="explicit">explicit (device sends IN/OUT)</option><option value="in_only">entry only</option><option value="out_only">exit only</option></select></Field>
          <Field label="Location"><input value={edit.location_label ?? ''} onChange={(e) => setEdit({ ...edit, location_label: e.target.value })} /></Field>
        </div>
        <label className="check"><input type="checkbox" checked={edit.is_active ?? true} onChange={(e) => setEdit({ ...edit, is_active: e.target.checked })} /> Active</label>
      </Modal>}
    </section>
  );
}

/* ---------- Settings ---------- */
function SettingsAdmin() {
  const { busy, run } = useAction();
  const toast = useToast();
  const list = useLiveQuery<{ key: string; value: unknown; description: string | null }[]>(() => get('settings'), [], []);
  const [draft, setDraft] = useState<Record<string, string>>({});
  if (!list.data) return <Loading />;
  return (
    <section className="panel">
      <h3>Thresholds & rules</h3>
      <p className="muted small">Values are JSON (numbers, true/false, "text", objects). Changes take effect on the next sweep / action and are audited.</p>
      <table className="table compact"><thead><tr><th>Setting</th><th>Value</th><th>Description</th><th /></tr></thead>
        <tbody>{list.data.map((s) => {
          const cur = draft[s.key] ?? JSON.stringify(s.value);
          return <tr key={s.key}><td className="mono">{s.key}</td>
            <td><input className="mono" value={cur} onChange={(e) => setDraft({ ...draft, [s.key]: e.target.value })} /></td>
            <td className="small muted">{s.description}</td>
            <td><Button size="sm" busy={busy} disabled={cur === JSON.stringify(s.value)} onClick={() => {
              let v: unknown;
              try { v = JSON.parse(cur); } catch { toast('err', 'Invalid JSON value'); return; }
              void run(() => put(`admin/settings/${s.key}`, { value: v }), 'Setting saved')
                .then(() => { setDraft((d) => { const n = { ...d }; delete n[s.key]; return n; }); list.refresh(); });
            }}>Save</Button></td></tr>;
        })}</tbody></table>
    </section>
  );
}

function DemoAdmin() {
  const { busy, run } = useAction();
  return (
    <section className="panel">
      <h3>Demo data</h3>
      <p>Demo MPs are flagged <code>is_demo</code>, carry a DEMO badge, and can be hidden on every screen. Use them for training only, and purge before go-live.</p>
      <div className="row gap">
        <Button busy={busy} onClick={() => void run(() => post('admin/seed-demo'), 'Demo MPs added')}>Add 24 demo MPs</Button>
        <Button variant="danger" busy={busy} onClick={() => { if (confirm('Delete ALL demo employees and their events? This cannot be undone.')) void run(() => rpc('purge_demo_data'), 'Demo data purged'); }}>Purge demo data</Button>
      </div>
    </section>
  );
}
