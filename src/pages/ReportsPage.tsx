import { useMemo, useState } from 'react';
import { get } from '../lib/api';
import { useAuth } from '../hooks/useAuth';
import { siteToday, humanizeKey, fmtDateTime } from '../lib/format';
import { autoColumns, downloadCsv, downloadXlsx } from '../lib/export';
import { DataTable, type Column } from '../components/DataTable';
import { Button, ErrorBox, Field, Loading, Empty } from '../components/ui';

type Row = Record<string, unknown>;

const REPORTS: { fn: string; label: string; desc: string; managerOnly?: boolean }[] = [
  { fn: 'report_attendance', label: 'Attendance & time split', desc: 'Per MP per shift (business date — overnight shifts handled): inside/outside, working, unassigned, pickup, break, handover minutes from event timestamps.' },
  { fn: 'report_pickups', label: 'Pickups & delayed returns', desc: 'Departure/return, duration vs expected, delay, resulting handover status.' },
  { fn: 'report_breaks', label: 'Lunch / break', desc: 'Break duration, location, allowed vs exceeded minutes.' },
  { fn: 'report_area_deployment', label: 'Area-wise deployment', desc: 'Distinct MPs, assignments, transfers in and total minutes per area per day.' },
  { fn: 'report_assignments', label: 'Assignment & transfer history', desc: 'Every assignment with duration, end reason, transferred-from area and who assigned.' },
  { fn: 'report_handovers', label: 'Handovers', desc: 'Pending/completed handovers, time to complete, delay vs threshold, receiver, discrepancies.' },
  { fn: 'report_exceptions', label: 'Exceptions / alerts', desc: 'All alerts raised, acknowledgement and resolution times.' },
  { fn: 'report_corrections', label: 'Manual corrections & security', desc: 'Corrections, overrides, approvals and denied attempts (audit trail).', managerOnly: true },
];

const TIME_KEYS = /(_at|_since|checked_in_at|checked_out_at)$/;

export default function ReportsPage() {
  const { can } = useAuth();
  const [fn, setFn] = useState(REPORTS[0].fn);
  const [from, setFrom] = useState(siteToday(-1));
  const [to, setTo] = useState(siteToday());
  const [rows, setRows] = useState<Row[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const hideDemo = false;

  async function runReport() {
    setLoading(true); setErr(null);
    try {
      setRows(await get<Row[]>(`reports/${fn}`, { date_from: from, date_to: to }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e)); setRows(null);
    } finally {
      setLoading(false);
    }
  }

  const shown = useMemo(() => (rows ?? []).filter((r) => !hideDemo || !r.is_demo), [rows, hideDemo]);
  const keyed = useMemo(() => shown.map((r, i) => ({ ...r, __k: String(i) })), [shown]);
  const columns: Column<Row>[] = useMemo(() => {
    const keys = shown.length ? Object.keys(shown[0]).filter((k) => !/_id$/.test(k) && k !== 'is_demo' && k !== 'details') : [];
    return keys.map((k) => ({
      key: k, header: humanizeKey(k),
      render: (r: Row) => {
        const v = r[k];
        if (v === null || v === undefined) return '—';
        if (typeof v === 'string' && TIME_KEYS.test(k)) return fmtDateTime(v);
        if (typeof v === 'boolean') return v ? 'Yes' : '';
        return String(v);
      },
      sortValue: (r: Row) => { const v = r[k]; return typeof v === 'number' ? v : v === null || v === undefined ? null : isFinite(Number(v)) && v !== '' ? Number(v) : String(v); },
    }));
  }, [shown]);

  const summary = useMemo(() => summarise(fn, shown), [fn, shown]);
  const base = `${fn.replace('report_', '')}-${from}_to_${to}`;
  const meta = REPORTS.find((r) => r.fn === fn)!;

  return (
    <div className="page">
      <section className="toolbar wrap">
        <Field label="Report"><select value={fn} onChange={(e) => { setFn(e.target.value); setRows(null); }}>
          {REPORTS.filter((r) => !r.managerOnly || can('admin', 'ops_manager')).map((r) => <option key={r.fn} value={r.fn}>{r.label}</option>)}</select></Field>
        <Field label="From (business date)"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To"><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        <Button variant="primary" busy={loading} onClick={() => void runReport()}>Run report</Button>
        <span className="spacer" />
        <Button size="sm" disabled={!shown.length} onClick={() => downloadCsv(shown, autoColumns(shown), base)}>CSV</Button>
        <Button size="sm" disabled={!shown.length} onClick={() => void downloadXlsx(shown, autoColumns(shown), base)}>Excel</Button>
      </section>
      <p className="muted small">{meta.desc}{rows && rows.length > shown.length ? ` · ${rows.length - shown.length} demo rows hidden` : ''}</p>
      <ErrorBox error={err} />
      {summary.length > 0 && <section className="summary-grid">{summary.map((s) => (
        <div key={s.title} className="panel"><h4>{s.title}</h4>
          <table className="table compact"><tbody>{s.rows.map(([k, v]) => <tr key={k}><td>{k}</td><td className="num">{v}</td></tr>)}</tbody></table></div>))}</section>}
      {loading ? <Loading label="Running report…" /> : rows === null ? <Empty title="Choose a report and date range, then Run." /> :
        <DataTable rows={keyed} columns={columns} rowKey={(r) => String(r.__k)} empty="No records for this period." />}
    </div>
  );
}

function avg(nums: number[]) { return nums.length ? (nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(1) : '—'; }

function groupAvg(rows: Row[], key: string, val: string): [string, string][] {
  const m = new Map<string, number[]>();
  rows.forEach((r) => { const v = Number(r[val]); if (r[val] === null || !isFinite(v)) return; const k = String(r[key] ?? '—'); m.set(k, [...(m.get(k) ?? []), v]); });
  return [...m.entries()].sort((a, b) => Number(avg(b[1])) - Number(avg(a[1]))).slice(0, 10).map(([k, v]) => [`${k} (${v.length})`, `${avg(v)} min`]);
}

function summarise(fn: string, rows: Row[]): { title: string; rows: [string, string][] }[] {
  if (!rows.length) return [];
  if (fn === 'report_handovers') {
    const done = rows.filter((r) => r.status === 'COMPLETED');
    return [
      { title: 'Handover overview', rows: [['Total', String(rows.length)], ['Completed', String(done.length)],
        ['Pending / in progress', String(rows.filter((r) => r.status === 'PENDING' || r.status === 'IN_PROGRESS').length)],
        ['Disputed / rejected', String(rows.filter((r) => r.status === 'DISPUTED' || r.status === 'REJECTED').length)],
        ['Avg completion', `${avg(done.map((r) => Number(r.minutes_to_complete)))} min`],
        ['Delayed beyond threshold', String(rows.filter((r) => Number(r.delay_minutes) > 0).length)]] },
      { title: 'Avg delay by destination area', rows: groupAvg(rows, 'destination_area', 'delay_minutes') },
      { title: 'Avg delay by supervisor', rows: groupAvg(rows, 'supervisor_name', 'delay_minutes') },
      { title: 'Avg completion by receiver', rows: groupAvg(done, 'receiver_name', 'minutes_to_complete') },
    ];
  }
  if (fn === 'report_attendance') {
    const sum = (k: string) => rows.reduce((s, r) => s + Number(r[k] ?? 0), 0);
    const hrs = (m: number) => `${(m / 60).toFixed(1)} h`;
    return [{ title: 'Totals', rows: [['Attendance records', String(rows.length)], ['Working', hrs(sum('working_minutes'))],
      ['Unassigned', hrs(sum('unassigned_minutes'))], ['Pickup / external', hrs(sum('pickup_minutes'))],
      ['Break', hrs(sum('break_minutes'))], ['Handover', hrs(sum('handover_minutes'))], ['Outside', hrs(sum('outside_minutes'))]] }];
  }
  if (fn === 'report_pickups') {
    const delayed = rows.filter((r) => Number(r.delay_minutes) > 0);
    return [{ title: 'Pickups', rows: [['Total', String(rows.length)], ['Delayed returns', String(delayed.length)],
      ['Avg duration', `${avg(rows.filter((r) => r.duration_minutes !== null).map((r) => Number(r.duration_minutes)))} min`],
      ['Avg delay (delayed only)', `${avg(delayed.map((r) => Number(r.delay_minutes)))} min`]] }];
  }
  if (fn === 'report_breaks') {
    return [{ title: 'Breaks', rows: [['Total', String(rows.length)], ['Exceeded', String(rows.filter((r) => Number(r.exceeded_minutes) > 0).length)],
      ['Avg duration', `${avg(rows.map((r) => Number(r.duration_minutes)))} min`]] }];
  }
  return [];
}
