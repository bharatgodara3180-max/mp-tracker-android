import { useMemo, useState } from 'react';
import { get, imageUrl, rpc } from '../lib/api';
import { useLiveQuery, useNow } from '../hooks/useLive';
import { useAuth } from '../hooks/useAuth';
import { useRefData } from '../hooks/useRefData';
import type { Device, GateLogRow, MpLive } from '../lib/types';
import { fmtDateTime, fmtDuration, fmtTime } from '../lib/format';
import { DataTable, type Column } from '../components/DataTable';
import { Button, ErrorBox, Loading, Pill, useAction, Field, Modal } from '../components/ui';
import { MpActionModal } from '../components/MpActions';
import { downloadCsv } from '../lib/export';

interface CorrectionReq { id: string; employee_id: string; correction_type: string; payload: Record<string, unknown>; reason: string; status: string; requested_at: string; requested_by: string }

export default function GatePage() {
  const { can } = useAuth();
  const ref = useRefData();
  const now = useNow(5000);
  const { busy, run } = useAction();
  const [fStatus, setFStatus] = useState('');
  const [fDir, setFDir] = useState('');
  const [search, setSearch] = useState('');
  const [corrFor, setCorrFor] = useState<MpLive | null>(null);
  const [pickCode, setPickCode] = useState('');
  const [snap, setSnap] = useState<{ title: string; url: string } | null>(null);

  const data = useLiveQuery(async () => {
    const [devices, log, offline, corr] = await Promise.all([
      get<Device[]>('devices'),
      get<GateLogRow[]>('gate-log', { limit: 500 }),
      get<{ key: string; value: unknown }[]>('settings'),
      can('admin', 'ops_manager') ? get<CorrectionReq[]>('corrections') : Promise.resolve([] as CorrectionReq[]),
    ]);
    const off = offline.find((s) => s.key === 'device_offline_minutes')?.value;
    return { devices: devices.map((d) => ({ ...d, is_active: !!d.is_active })), log, offlineMin: Number(off ?? 5), corr };
  }, ['gate_events', 'devices', 'correction_requests']);

  const log = useMemo(() => (data.data?.log ?? []).filter((g) => (!fStatus || g.processing_status === fStatus) && (!fDir || g.direction === fDir)
    && (!search || `${g.employee_code ?? ''} ${g.full_name ?? ''} ${g.person_ref ?? ''}`.toLowerCase().includes(search.toLowerCase()))), [data.data, fStatus, fDir, search]);
  const latest = data.data?.log.find((g) => g.processing_status === 'APPLIED');

  async function openCorrection() {
    const code = pickCode.trim().replace(/[,()*%\\]/g, '');
    if (!code) return;
    const r = await run(async () => {
      const rows = await get<MpLive[]>('employees/lookup', { q: code });
      if (!rows.length) throw new Error('No employee matches that ID / name');
      if (rows.length > 1) throw new Error('More than one match — use the exact employee ID');
      return rows[0];
    });
    if (r) setCorrFor(r);
  }

  const cols: Column<GateLogRow>[] = [
    { key: 't', header: 'Captured', render: (g) => fmtDateTime(g.event_time), sortValue: (g) => g.event_time },
    { key: 'dir', header: 'Dir', render: (g) => <span className={`gate-${g.direction.toLowerCase()}`}>{g.direction}</span>, sortValue: (g) => g.direction },
    { key: 'emp', header: 'MP', render: (g) => g.full_name ? <>{g.full_name} <span className="muted mono">{g.employee_code}</span></> : <span className="muted">Unmatched: {g.person_ref}</span>, sortValue: (g) => g.full_name },
    { key: 'src', header: 'Source', render: (g) => `${g.source}${g.device_code ? ' · ' + g.device_code : ''}`, sortValue: (g) => g.source },
    { key: 'purpose', header: 'Purpose', render: (g) => g.purpose ?? '—' },
    { key: 'conf', header: 'Match', render: (g) => g.match_confidence !== null ? `${Math.round(Number(g.match_confidence) * 100)}%` : '—' },
    { key: 'st', header: 'Result', render: (g) => <Pill tone={g.processing_status === 'APPLIED' ? 'green' : g.processing_status === 'DUPLICATE' ? 'gray' : g.processing_status === 'REJECTED' ? 'red' : 'orange'}>{g.processing_status}</Pill>, sortValue: (g) => g.processing_status },
    { key: 'note', header: 'Note / reason', render: (g) => <span className="small">{g.processing_note ?? g.reason ?? ''}</span> },
    { key: 'photo', header: 'Photo', render: (g) => g.snapshot ? <Button size="sm" variant="ghost" onClick={async () => {
        const url = await imageUrl(`face/snap/${g.snapshot}`);
        if (url) setSnap({ title: `${g.full_name ?? 'Unknown face'} · ${g.direction} · ${fmtDateTime(g.event_time)}`, url });
      }}>View</Button> : '' },
    { key: 'rx', header: 'Received', render: (g) => <span className="muted">{fmtTime(g.received_at)}</span>, sortValue: (g) => g.received_at },
  ];

  return (
    <div className="page">
      <ErrorBox error={data.error} />
      {!data.data ? <Loading /> : <>
        <section className="device-row">
          {data.data.devices.map((d) => {
            const age = d.last_heartbeat_at ? (now - new Date(d.last_heartbeat_at).getTime()) / 1000 : null;
            const online = d.is_active && age !== null && age < data.data!.offlineMin * 60;
            return (
              <div key={d.id} className={`device-card ${!d.is_active ? 'disabled' : online ? 'online' : 'offline'}`}>
                <div className="row gap"><span className="dot" /><strong>{d.name}</strong><span className="mono muted">{d.device_code}</span></div>
                <div className="small">{!d.is_active ? 'Disabled' : online ? 'Online' : 'OFFLINE'} · heartbeat {age === null ? 'never' : `${fmtDuration(age)} ago`}</div>
                <div className="small muted">Last event {fmtDateTime(d.last_event_at)} · last sync {fmtDateTime(d.last_sync_at)}</div>
                <div className="small muted">Adapter {d.adapter} · {d.direction_mode}{d.pending_events_reported ? ` · ${d.pending_events_reported} queued on device` : ''}{d.firmware ? ` · fw ${d.firmware}` : ''}</div>
              </div>);
          })}
          {latest && <div className="device-card latest">
            <div className="small muted">Latest gate event</div>
            <div className="latest-big"><span className={`gate-${latest.direction.toLowerCase()}`}>{latest.direction}</span> {latest.full_name}</div>
            <div className="small muted">{fmtDateTime(latest.event_time)} · {latest.source}</div>
          </div>}
        </section>

        {(data.data.corr.length > 0 && can('admin')) && <section className="panel">
          <h3>Corrections awaiting approval</h3>
          <table className="table compact"><thead><tr><th>Requested</th><th>Type</th><th>Details</th><th>Reason</th><th /></tr></thead><tbody>
            {data.data.corr.map((c) => <tr key={c.id}><td>{fmtDateTime(c.requested_at)}</td><td>{c.correction_type}</td><td className="small mono">{JSON.stringify(c.payload)}</td><td>{c.reason}</td>
              <td className="row gap">
                <Button size="sm" variant="primary" busy={busy} onClick={() => void run(() => rpc('decide_correction', { p_request_id: c.id, p_approve: true, p_note: 'Approved' }), 'Applied').then(() => data.refresh())}>Approve</Button>
                <Button size="sm" variant="danger" busy={busy} onClick={() => { const n = prompt('Reason for rejection'); if (n) void run(() => rpc('decide_correction', { p_request_id: c.id, p_approve: false, p_note: n }), 'Rejected').then(() => data.refresh()); }}>Reject</Button>
              </td></tr>)}
          </tbody></table>
        </section>}

        {can('admin', 'supervisor', 'gate_operator') && <section className="toolbar">
          <Field label="Manual gate correction"><input placeholder="Employee ID or name" value={pickCode} onChange={(e) => setPickCode(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void openCorrection()} /></Field>
          <Button onClick={() => void openCorrection()} busy={busy}>Open</Button>
          <span className="muted small">Missing or wrong scan? Record the real event with a mandatory reason. Original events are never edited.</span>
        </section>}

        <section className="toolbar">
          <input type="search" className="search" placeholder="Search MP / person ref" value={search} onChange={(e) => setSearch(e.target.value)} />
          <select value={fDir} onChange={(e) => setFDir(e.target.value)} aria-label="Direction"><option value="">IN & OUT</option><option>IN</option><option>OUT</option></select>
          <select value={fStatus} onChange={(e) => setFStatus(e.target.value)} aria-label="Result"><option value="">All results</option>{['APPLIED', 'DUPLICATE', 'SUSPICIOUS', 'OUT_OF_ORDER', 'REJECTED'].map((s) => <option key={s}>{s}</option>)}</select>
          <span className="spacer" />
          <Button size="sm" onClick={() => downloadCsv(log, cols.map((c) => ({ header: c.header, value: (g: GateLogRow) => (c.sortValue ? c.sortValue(g) : '') as string })), 'gate-log')}>CSV</Button>
        </section>
        <DataTable rows={log} columns={cols} rowKey={(g) => g.id} rowClass={(g) => ['SUSPICIOUS', 'OUT_OF_ORDER', 'REJECTED'].includes(g.processing_status) ? 'row-warn' : ''} empty="No gate events yet." />
      </>}
      {snap && <Modal title={snap.title} onClose={() => { URL.revokeObjectURL(snap.url); setSnap(null); }}><img className="face-photo-big" src={snap.url} alt="" /></Modal>}
      {corrFor && <MpActionModal kind="correction" row={corrFor} refData={ref} onClose={() => setCorrFor(null)} onDone={() => void data.refresh()} />}
    </div>
  );
}
