import { useEffect, useState } from 'react';
import { get, imageUrl } from '../lib/api';
import { useLiveQuery, useNow } from '../hooks/useLive';
import type { MpLive, Alert, GateLogRow, HandoverLive } from '../lib/types';
import { fmtDateTime, fmtDuration, fmtTime, secondsSince, statusLabel, STATUS_META, HANDOVER_META, humanizeKey } from '../lib/format';
import { Pill, Loading, ErrorBox } from './ui';

interface Profile {
  live: MpLive | null;
  timeline: { id: number; event_type: string; from_status: string | null; to_status: string; presence: string; area: string | null; at: string; reason: string | null; actor: string | null }[];
  gate_events: GateLogRow[];
  assignments: { id: string; area: string; task: string | null; started_at: string; ended_at: string | null; end_reason: string | null; minutes: number }[];
  handovers: HandoverLive[];
  breaks: { id: string; break_type: string; location: string; started_at: string; ended_at: string | null; allowed_minutes: number }[];
  pickups: { id: string; purpose: string; destination: string | null; route_ref: string | null; status: string; departed_at: string | null; returned_at: string | null; expected_return_at: string | null }[];
  alerts: Alert[];
}

const TABS = ['Timeline', 'Gate', 'Assignments', 'Handovers', 'Breaks & pickups', 'Alerts'] as const;

export function MpProfileDrawer({ employeeId, onClose, actions }: { employeeId: string; onClose: () => void; actions?: React.ReactNode }) {
  const [tab, setTab] = useState<(typeof TABS)[number]>('Timeline');
  const [hours, setHours] = useState(24);
  const now = useNow(1000);
  const q = useLiveQuery<Profile>(async () => {
    return get<Profile>(`profile/${employeeId}`, { hours });
  }, ['mp_current_state', 'gate_events', 'handover_records', 'alerts'], [employeeId, hours]);

  const p = q.data;
  const l = p?.live;
  const [photo, setPhoto] = useState<string | null>(null);
  const [big, setBig] = useState(false);
  useEffect(() => {   // registered face photo of the MP
    let alive = true; let u: string | null = null;
    setPhoto(null);
    void imageUrl(`face/photo/${employeeId}`).then((x) => { u = x; if (alive) setPhoto(x); else if (x) URL.revokeObjectURL(x); });
    return () => { alive = false; if (u) URL.revokeObjectURL(u); };
  }, [employeeId]);

  return (
    <div className="drawer-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside className="drawer" aria-label="MP profile">
        <header className="drawer-head">
          <button className="mp-photo" onClick={() => photo && setBig(true)} title={photo ? 'Photo bada dekhiye' : 'Photo nahi hai'}>
            {photo ? <img src={photo} alt="" /> : <span>No photo</span>}
          </button>
          <div className="drawer-title">
            <div className="eyebrow">{l?.employee_code}{l?.is_demo ? ' · DEMO' : ''}</div>
            <h2>{l?.full_name ?? '…'}</h2>
            {l && <div className="row gap">
              <Pill tone={STATUS_META[l.status].tone}>{statusLabel(l)}</Pill>
              <span className="muted">for {fmtDuration(secondsSince(l.status_since, now))}</span>
              <span className="muted">· {l.presence === 'INSIDE' ? 'Inside DC' : l.presence === 'OUTSIDE' ? 'Outside DC' : 'Unknown'}</span>
            </div>}
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </header>
        {big && photo && <div className="photo-pop" onClick={() => setBig(false)}><img src={photo} alt={l?.full_name ?? ''} /><span>{l?.full_name} · {l?.employee_code}</span></div>}
        <ErrorBox error={q.error} />
        {!p ? <Loading /> : (
          <>
            {l && <dl className="facts">
              <div><dt>Area</dt><dd>{l.area_name ?? '—'}{l.current_task ? ` · ${l.current_task}` : ''}</dd></div>
              <div><dt>Shift</dt><dd>{l.shift_name ?? '—'}{l.checked_in_at ? ` · in ${fmtTime(l.checked_in_at)}` : ''}</dd></div>
              <div><dt>Supervisor</dt><dd>{l.supervisor_name ?? '—'}</dd></div>
              <div><dt>Last gate</dt><dd>{l.last_gate_direction ? `${l.last_gate_direction} ${fmtDateTime(l.last_gate_event_at)}` : '—'}</dd></div>
              <div><dt>Pickup</dt><dd>{l.route_ref || l.pickup_destination ? `${l.route_ref ?? ''} ${l.pickup_destination ?? ''} (${l.pickup_status})` : '—'}</dd></div>
              <div><dt>Handover</dt><dd>{l.handover_status ? `#${l.handover_no} ${HANDOVER_META[l.handover_status].label}${l.receiver_name ? ' → ' + l.receiver_name : ''}` : '—'}</dd></div>
              <div><dt>Expected by</dt><dd>{fmtTime(l.expected_by)}</dd></div>
              <div><dt>Open alerts</dt><dd>{l.open_alerts}</dd></div>
            </dl>}
            {actions}
            <div className="tabs" role="tablist">
              {TABS.map((t) => <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{t}</button>)}
              <select value={hours} onChange={(e) => setHours(Number(e.target.value))} aria-label="History window">
                <option value={12}>12 h</option><option value={24}>24 h</option><option value={72}>3 days</option><option value={168}>7 days</option>
              </select>
            </div>
            <div className="drawer-body">
              {tab === 'Timeline' && <ol className="timeline">
                {[...p.timeline].reverse().map((t) => (
                  <li key={t.id}>
                    <span className="tl-time">{fmtDateTime(t.at)}</span>
                    <span className="tl-dot" />
                    <div>
                      <strong>{humanizeKey(t.event_type)}</strong> → {STATUS_META[t.to_status as keyof typeof STATUS_META]?.label ?? t.to_status}
                      {t.area ? <span className="muted"> · {t.area}</span> : null}
                      {t.reason ? <div className="muted small">“{t.reason}”</div> : null}
                      {t.actor ? <div className="muted small">by {t.actor}</div> : null}
                    </div>
                  </li>))}
                {p.timeline.length === 0 && <li className="muted">No movements in this window.</li>}
              </ol>}
              {tab === 'Gate' && <table className="table compact"><thead><tr><th>Time</th><th>Dir</th><th>Source</th><th>Result</th><th>Note</th></tr></thead>
                <tbody>{p.gate_events.map((g) => <tr key={g.id}><td>{fmtDateTime(g.event_time)}</td><td>{g.direction}</td><td>{g.source}{g.device_code ? ` · ${g.device_code}` : ''}</td>
                  <td><Pill tone={g.processing_status === 'APPLIED' ? 'green' : g.processing_status === 'DUPLICATE' ? 'gray' : 'red'}>{g.processing_status}</Pill></td>
                  <td className="small">{g.processing_note ?? g.reason ?? (g.purpose ? `Purpose: ${g.purpose}` : '')}</td></tr>)}</tbody></table>}
              {tab === 'Assignments' && <table className="table compact"><thead><tr><th>Area</th><th>Task</th><th>Start</th><th>End</th><th>Min</th><th>Ended by</th></tr></thead>
                <tbody>{p.assignments.map((a) => <tr key={a.id}><td>{a.area}</td><td>{a.task ?? '—'}</td><td>{fmtTime(a.started_at)}</td><td>{fmtTime(a.ended_at)}</td><td>{a.minutes}</td><td>{a.end_reason ?? (a.ended_at ? '' : 'active')}</td></tr>)}</tbody></table>}
              {tab === 'Handovers' && <table className="table compact"><thead><tr><th>#</th><th>Type</th><th>Status</th><th>From → To</th><th>Pending since</th><th>Completed</th></tr></thead>
                <tbody>{p.handovers.map((h) => <tr key={h.id}><td>{h.handover_no}</td><td>{h.handover_type}</td><td><Pill tone={HANDOVER_META[h.status].tone}>{HANDOVER_META[h.status].label}</Pill></td>
                  <td>{h.handing_name} → {h.receiver_name ?? '—'}</td><td>{fmtDateTime(h.pending_since)}</td><td>{fmtDateTime(h.completed_at)}</td></tr>)}</tbody></table>}
              {tab === 'Breaks & pickups' && <>
                <h4>Breaks</h4>
                <table className="table compact"><thead><tr><th>Type</th><th>Where</th><th>Start</th><th>End</th><th>Duration</th><th>Allowed</th></tr></thead>
                  <tbody>{p.breaks.map((b) => {
                    const secs = ((b.ended_at ? new Date(b.ended_at).getTime() : now) - new Date(b.started_at).getTime()) / 1000;
                    return <tr key={b.id} className={secs > b.allowed_minutes * 60 ? 'row-warn' : ''}><td>{b.break_type}</td><td>{b.location}</td><td>{fmtTime(b.started_at)}</td><td>{fmtTime(b.ended_at)}</td><td>{fmtDuration(secs)}</td><td>{b.allowed_minutes}m</td></tr>;
                  })}</tbody></table>
                <h4>Pickups / external duty</h4>
                <table className="table compact"><thead><tr><th>Purpose</th><th>Route</th><th>Destination</th><th>Out</th><th>Back</th><th>Expected</th><th>Status</th></tr></thead>
                  <tbody>{p.pickups.map((x) => <tr key={x.id}><td>{x.purpose}</td><td>{x.route_ref ?? '—'}</td><td>{x.destination ?? '—'}</td><td>{fmtTime(x.departed_at)}</td><td>{fmtTime(x.returned_at)}</td><td>{fmtTime(x.expected_return_at)}</td><td>{x.status}</td></tr>)}</tbody></table>
              </>}
              {tab === 'Alerts' && <ul className="alert-list">{p.alerts.map((a) => (
                <li key={a.id} className={`sev-${a.severity.toLowerCase()}`}><strong>{a.title}</strong><span className="muted"> · {fmtDateTime(a.first_detected_at)} · {a.status}</span>{a.message ? <div className="small">{a.message}</div> : null}</li>))}
                {p.alerts.length === 0 && <li className="muted">No exceptions in this window.</li>}</ul>}
            </div>
          </>
        )}
      </aside>
    </div>
  );
}
