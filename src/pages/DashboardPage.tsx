import { useMemo, useState } from 'react';
import { get } from '../lib/api';
import { useLiveQuery, useNow } from '../hooks/useLive';
import { useRefData } from '../hooks/useRefData';
import { useAuth } from '../hooks/useAuth';
import type { Kpis, MpLive, MpStatus } from '../lib/types';
import { STATUS_META, HANDOVER_META, fmtDuration, fmtTime, fmtDateTime, secondsSince, delaySeconds, statusLabel } from '../lib/format';
import { downloadCsv, downloadXlsx, type ExportColumn } from '../lib/export';
import { DataTable, type Column } from '../components/DataTable';
import { Pill, Button, ErrorBox, Loading } from '../components/ui';
import { MpProfileDrawer } from '../components/MpProfile';
import { MpActionModal, availableActions, ACTION_LABEL, type MpActionKind } from '../components/MpActions';

type KpiDef = { key: keyof Kpis; label: string; tone: string; filter?: (r: MpLive) => boolean };
const KPI_DEFS: KpiDef[] = [
  { key: 'total_on_shift', label: 'On shift', tone: 'neutral', filter: (r) => !['NOT_CHECKED_IN', 'SHIFT_ENDED'].includes(r.status) },
  { key: 'inside', label: 'Inside DC', tone: 'green', filter: (r) => r.presence === 'INSIDE' && !['NOT_CHECKED_IN', 'SHIFT_ENDED'].includes(r.status) },
  { key: 'outside', label: 'Outside DC', tone: 'blue', filter: (r) => r.status.startsWith('OUTSIDE') },
  { key: 'on_pickup', label: 'On pickup', tone: 'blue', filter: (r) => r.status === 'OUTSIDE_PICKUP' },
  { key: 'on_break', label: 'Lunch / break', tone: 'violet', filter: (r) => r.status === 'ON_BREAK' || r.status === 'OUTSIDE_BREAK' },
  { key: 'primary', label: 'Primary', tone: 'green', filter: (r) => r.status === 'WORKING' && r.area_kind === 'PRIMARY' },
  { key: 'secondary', label: 'Secondary', tone: 'green', filter: (r) => r.status === 'WORKING' && r.area_kind === 'SECONDARY' },
  { key: 'staging', label: 'Staging', tone: 'green', filter: (r) => r.status === 'WORKING' && r.area_kind === 'STAGING' },
  { key: 'dock', label: 'Dock', tone: 'green', filter: (r) => r.status === 'WORKING' && r.area_kind === 'DOCK' },
  { key: 'other_blocks', label: 'Other blocks', tone: 'green', filter: (r) => r.status === 'WORKING' && (r.area_kind === 'BLOCK' || r.area_kind === 'OTHER') },
  { key: 'handover_pending', label: 'Handover pending', tone: 'orange', filter: (r) => r.status === 'HANDOVER_PENDING' || r.status === 'HANDOVER_IN_PROGRESS' },
  { key: 'handover_overdue', label: 'Handover overdue', tone: 'red', filter: (r) => (r.status === 'HANDOVER_PENDING' || r.status === 'HANDOVER_IN_PROGRESS') && !!r.handover_due_at && Date.now() > new Date(r.handover_due_at).getTime() },
  { key: 'unassigned', label: 'Unassigned', tone: 'amber', filter: (r) => r.status === 'INSIDE_UNASSIGNED' },
  { key: 'exceptions', label: 'Exceptions', tone: 'red', filter: (r) => r.open_alerts > 0 || delaySeconds(r.expected_by) > 0 || ['OUTSIDE_UNDECLARED', 'HANDOVER_DISPUTED'].includes(r.status) },
];

export default function DashboardPage() {
  const { profile } = useAuth();
  const ref = useRefData();
  const now = useNow(1000);
  const [shift, setShift] = useState('');
  const [hideDemo, setHideDemo] = useState(false);
  const [search, setSearch] = useState('');
  const [fStatus, setFStatus] = useState('');
  const [fArea, setFArea] = useState('');
  const [fKind, setFKind] = useState('');
  const [fSup, setFSup] = useState('');
  const [fRoute, setFRoute] = useState('');
  const [fHo, setFHo] = useState('');
  const [kpiFilter, setKpiFilter] = useState<KpiDef | null>(null);
  const [showOff, setShowOff] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [action, setAction] = useState<{ kind: MpActionKind; row: MpLive } | null>(null);
  const [menu, setMenu] = useState<string | null>(null);

  const live = useLiveQuery<{ rows: MpLive[]; kpis: Kpis }>(async () => {
    return get<{ rows: MpLive[]; kpis: Kpis }>('live', { shift_id: shift || undefined, include_demo: !hideDemo });
  }, ['mp_current_state', 'handover_records', 'alerts', 'work_assignments', 'pickup_assignments'], [shift, hideDemo]);

  const rows = useMemo(() => {
    const all = live.data?.rows ?? [];
    const s = search.trim().toLowerCase();
    return all.filter((r) => {
      if (hideDemo && r.is_demo) return false;
      if (shift && r.shift_id !== shift) return false;
      if (!showOff && !kpiFilter && !fStatus && ['NOT_CHECKED_IN', 'SHIFT_ENDED'].includes(r.status)) return false;
      if (kpiFilter?.filter && !kpiFilter.filter(r)) return false;
      if (fStatus && r.status !== fStatus) return false;
      if (fArea && r.area_id !== fArea) return false;
      if (fKind && r.area_kind !== fKind) return false;
      if (fSup && r.supervisor_user_id !== fSup) return false;
      if (fHo && r.handover_status !== fHo) return false;
      if (fRoute && !(r.route_ref ?? '').toLowerCase().includes(fRoute.toLowerCase())) return false;
      if (s && !`${r.employee_code} ${r.full_name} ${r.area_name ?? ''} ${r.route_ref ?? ''} ${r.current_task ?? ''}`.toLowerCase().includes(s)) return false;
      return true;
    });
  }, [live.data, search, fStatus, fArea, fKind, fSup, fRoute, fHo, kpiFilter, showOff, hideDemo, shift]);

  const columns: Column<MpLive>[] = [
    { key: 'code', header: 'Emp ID', render: (r) => <span className="mono">{r.employee_code}{r.is_demo ? <span className="demo-tag">DEMO</span> : null}</span>, sortValue: (r) => r.employee_code },
    { key: 'name', header: 'MP name', render: (r) => <strong>{r.full_name}</strong>, sortValue: (r) => r.full_name, width: 140 },
    { key: 'status', header: 'Current status', render: (r) => <Pill tone={STATUS_META[r.status].tone}>{statusLabel(r)}</Pill>, sortValue: (r) => r.status, width: 170 },
    { key: 'presence', header: 'In/Out', render: (r) => <span className={`presence p-${r.presence.toLowerCase()}`}>{r.presence === 'UNKNOWN' ? '—' : r.presence}</span>, sortValue: (r) => r.presence },
    { key: 'area', header: 'Area / block', render: (r) => r.area_name ?? '—', sortValue: (r) => r.area_name },
    { key: 'task', header: 'Task', render: (r) => r.current_task ?? '—', sortValue: (r) => r.current_task },
    { key: 'route', header: 'Pickup route / ref', render: (r) => r.route_ref || r.pickup_destination ? <span title={r.pickup_destination ?? ''}>{r.route_ref ?? r.pickup_destination}{r.pickup_status === 'PLANNED' ? ' (planned)' : ''}</span> : '—', sortValue: (r) => r.route_ref },
    { key: 'gate', header: 'Last gate', render: (r) => r.last_gate_direction ? <span className={`gate-${r.last_gate_direction.toLowerCase()}`}>{r.last_gate_direction}</span> : '—', sortValue: (r) => r.last_gate_direction },
    { key: 'gate_t', header: 'Last event', render: (r) => fmtTime(r.last_gate_event_at), sortValue: (r) => r.last_gate_event_at },
    { key: 'since', header: 'Activity start', render: (r) => fmtTime(r.status_since), sortValue: (r) => r.status_since },
    { key: 'dur', header: 'Time in status', render: (r) => <span className="mono">{fmtDuration(secondsSince(r.status_since, now))}</span>, sortValue: (r) => -new Date(r.status_since).getTime() },
    { key: 'ho', header: 'Handover', render: (r) => r.handover_status ? <Pill tone={HANDOVER_META[r.handover_status].tone}>{HANDOVER_META[r.handover_status].label}</Pill> : '—', sortValue: (r) => r.handover_status },
    { key: 'handing', header: 'Handing-over MP', render: (r) => r.handover_id ? r.full_name : '—' },
    { key: 'receiver', header: 'Receiving MP', render: (r) => r.receiver_name ?? '—', sortValue: (r) => r.receiver_name },
    { key: 'sup', header: 'Supervisor', render: (r) => r.supervisor_name ?? '—', sortValue: (r) => r.supervisor_name },
    { key: 'exp', header: 'Expected by', render: (r) => fmtTime(r.expected_by), sortValue: (r) => r.expected_by },
    { key: 'delay', header: 'Delay', render: (r) => { const d = delaySeconds(r.expected_by, now); return d > 0 ? <span className="delay">{fmtDuration(d)}</span> : '—'; }, sortValue: (r) => delaySeconds(r.expected_by) },
    { key: 'upd', header: 'Last updated', render: (r) => <span className="muted">{fmtTime(r.updated_at)}</span>, sortValue: (r) => r.updated_at },
    { key: 'act', header: '', className: 'col-actions', render: (r) => {
      const acts = availableActions(r, profile?.role);
      if (!acts.length) return null;
      return (
        <div className="menu-wrap" onClick={(e) => e.stopPropagation()}>
          <button className="icon-btn" aria-label={`Actions for ${r.full_name}`} onClick={() => setMenu(menu === r.employee_id ? null : r.employee_id)}>⋯</button>
          {menu === r.employee_id && <div className="menu" role="menu">
            {acts.map((k) => <button key={k} role="menuitem" className={k === 'override' || k === 'correction' ? 'danger' : ''}
              onClick={() => { setMenu(null); setAction({ kind: k, row: r }); }}>{ACTION_LABEL[k]}</button>)}
          </div>}
        </div>);
    } },
  ];

  const exportCols: ExportColumn<MpLive>[] = [
    { header: 'Employee ID', value: (r) => r.employee_code }, { header: 'MP Name', value: (r) => r.full_name },
    { header: 'Current Status', value: (r) => statusLabel(r) }, { header: 'Inside/Outside', value: (r) => r.presence },
    { header: 'Area / Block', value: (r) => r.area_name }, { header: 'Task', value: (r) => r.current_task },
    { header: 'Pickup Route / Ref', value: (r) => r.route_ref ?? r.pickup_destination },
    { header: 'Last Gate Event', value: (r) => r.last_gate_direction }, { header: 'Last Event Time', value: (r) => fmtDateTime(r.last_gate_event_at) },
    { header: 'Activity Start', value: (r) => fmtDateTime(r.status_since) },
    { header: 'Minutes In Status', value: (r) => Math.round((secondsSince(r.status_since) ?? 0) / 60) },
    { header: 'Handover Status', value: (r) => r.handover_status }, { header: 'Receiving MP', value: (r) => r.receiver_name },
    { header: 'Supervisor', value: (r) => r.supervisor_name }, { header: 'Expected By', value: (r) => fmtDateTime(r.expected_by) },
    { header: 'Delay Minutes', value: (r) => Math.round(delaySeconds(r.expected_by) / 60) },
    { header: 'Last Updated', value: (r) => fmtDateTime(r.updated_at) }, { header: 'Demo', value: (r) => (r.is_demo ? 'yes' : '') },
  ];

  const k = live.data?.kpis;
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const clearFilters = () => { setSearch(''); setFStatus(''); setFArea(''); setFKind(''); setFSup(''); setFRoute(''); setFHo(''); setKpiFilter(null); };

  return (
    <div className="page" onClick={() => menu && setMenu(null)}>
      <section className="kpis" aria-label="Live counts">
        {KPI_DEFS.map((d) => (
          <button key={d.key} className={`kpi kpi-${d.tone} ${kpiFilter?.key === d.key ? 'active' : ''} ${(d.key === 'handover_overdue' || d.key === 'exceptions') && k && k[d.key] > 0 ? 'alarm' : ''}`}
                  onClick={() => setKpiFilter(kpiFilter?.key === d.key ? null : d)} title="Filter the table">
            <span className="kpi-value">{k ? k[d.key] : '–'}</span>
            <span className="kpi-label">{d.label}</span>
          </button>
        ))}
      </section>

      <section className="toolbar">
        <input type="search" placeholder="Search name, ID, area, route…" value={search} onChange={(e) => setSearch(e.target.value)} className="search" />
        <select value={shift} onChange={(e) => setShift(e.target.value)} aria-label="Shift"><option value="">All shifts</option>{ref.shifts.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
        <select value={fSup} onChange={(e) => setFSup(e.target.value)} aria-label="Supervisor"><option value="">All supervisors</option>{ref.supervisors.map((s) => <option key={s.user_id} value={s.user_id}>{s.full_name}</option>)}</select>
        <select value={fArea} onChange={(e) => setFArea(e.target.value)} aria-label="Block"><option value="">All areas / blocks</option>{ref.areas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
        <select value={fKind} onChange={(e) => setFKind(e.target.value)} aria-label="Work area"><option value="">All work types</option>{['PRIMARY', 'SECONDARY', 'STAGING', 'DOCK', 'BLOCK', 'OTHER'].map((x) => <option key={x}>{x}</option>)}</select>
        <select value={fStatus} onChange={(e) => setFStatus(e.target.value)} aria-label="Status"><option value="">All statuses</option>{(Object.keys(STATUS_META) as MpStatus[]).map((s) => <option key={s} value={s}>{STATUS_META[s].label}</option>)}</select>
        <select value={fHo} onChange={(e) => setFHo(e.target.value)} aria-label="Handover status"><option value="">Any handover</option>{Object.keys(HANDOVER_META).map((s) => <option key={s}>{s}</option>)}</select>
        <input placeholder="Route / ref" value={fRoute} onChange={(e) => setFRoute(e.target.value)} className="narrow" />
        <label className="check"><input type="checkbox" checked={showOff} onChange={(e) => setShowOff(e.target.checked)} /> Show off-shift</label>
        <label className="check"><input type="checkbox" checked={hideDemo} onChange={(e) => setHideDemo(e.target.checked)} /> Hide demo</label>
        <Button size="sm" variant="ghost" onClick={clearFilters}>Clear</Button>
        <span className="spacer" />
        <Button size="sm" onClick={() => downloadCsv(rows, exportCols, `mp-live-${stamp}`)}>CSV</Button>
        <Button size="sm" onClick={() => void downloadXlsx(rows, exportCols, `mp-live-${stamp}`)}>Excel</Button>
      </section>
      {kpiFilter && <div className="filter-chip">Showing: <strong>{kpiFilter.label}</strong> <button onClick={() => setKpiFilter(null)}>✕</button></div>}

      <ErrorBox error={live.error} />
      {live.loading && !live.data ? <Loading /> : (
        <DataTable rows={rows} columns={columns} rowKey={(r) => r.employee_id} onRowClick={(r) => setOpen(r.employee_id)}
          rowClass={(r) => (delaySeconds(r.expected_by, now) > 0 || r.open_alerts > 0 || r.status === 'OUTSIDE_UNDECLARED' ? 'row-alert' : '')}
          empty={live.data?.rows.length ? 'No MPs match these filters.' : 'No MPs yet. Add employees in Admin → Employees (or load demo data).'} />
      )}

      {open && <MpProfileDrawer employeeId={open} onClose={() => setOpen(null)} actions={(() => {
        const r = live.data?.rows.find((x) => x.employee_id === open);
        const acts = r ? availableActions(r, profile?.role) : [];
        return acts.length ? <div className="action-bar">{acts.map((kk) => <Button key={kk} size="sm" variant={kk === 'override' || kk === 'correction' ? 'danger' : 'default'} onClick={() => setAction({ kind: kk, row: r! })}>{ACTION_LABEL[kk]}</Button>)}</div> : null;
      })()} />}
      {action && <MpActionModal kind={action.kind} row={action.row} refData={ref} onClose={() => setAction(null)} onDone={() => void live.refresh()} />}
    </div>
  );
}
