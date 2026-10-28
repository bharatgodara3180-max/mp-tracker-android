import { useMemo, useState } from 'react';
import { get, rpc } from '../lib/api';
import { useLiveQuery, useNow } from '../hooks/useLive';
import type { Alert } from '../lib/types';
import { fmtDateTime, fmtDuration, humanizeKey } from '../lib/format';
import { Button, ErrorBox, Loading, Modal, Field, Pill, useAction, Empty } from '../components/ui';
import { MpProfileDrawer } from '../components/MpProfile';

export default function AlertsPage() {
  const now = useNow(5000);
  const [show, setShow] = useState<'open' | 'resolved'>('open');
  const [sev, setSev] = useState('');
  const [type, setType] = useState('');
  const [resolving, setResolving] = useState<Alert | null>(null);
  const [note, setNote] = useState('');
  const [profile, setProfile] = useState<string | null>(null);
  const { busy, run } = useAction();

  const q = useLiveQuery<Alert[]>(() => get<Alert[]>('alerts', { show }), ['alerts'], [show]);

  const rows = useMemo(() => (q.data ?? []).filter((a) => (!sev || a.severity === sev) && (!type || a.alert_type === type))
    .sort((a, b) => sevRank(b.severity) - sevRank(a.severity) || b.first_detected_at.localeCompare(a.first_detected_at)), [q.data, sev, type]);
  const types = [...new Set((q.data ?? []).map((a) => a.alert_type))].sort();

  return (
    <div className="page">
      <section className="toolbar">
        <div className="seg">
          <button className={show === 'open' ? 'active' : ''} onClick={() => setShow('open')}>Open & acknowledged</button>
          <button className={show === 'resolved' ? 'active' : ''} onClick={() => setShow('resolved')}>Resolved (24h)</button>
        </div>
        <select value={sev} onChange={(e) => setSev(e.target.value)} aria-label="Severity"><option value="">All severities</option><option>CRITICAL</option><option>WARNING</option><option>INFO</option></select>
        <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Type"><option value="">All types</option>{types.map((t) => <option key={t} value={t}>{humanizeKey(t)}</option>)}</select>
        <span className="spacer" />
        <span className="muted small">Alerts are raised server-side every minute and auto-resolve when the condition clears.</span>
      </section>
      <ErrorBox error={q.error} />
      {q.loading && !q.data ? <Loading /> : rows.length === 0 ? <Empty title={show === 'open' ? 'No open exceptions' : 'Nothing resolved in the last 24h'} /> : (
        <ul className="alert-cards">
          {rows.map((a) => (
            <li key={a.id} className={`alert-card sev-${a.severity.toLowerCase()} st-${a.status.toLowerCase()}`}>
              <div className="alert-main">
                <div className="row gap">
                  <Pill tone={a.severity === 'CRITICAL' ? 'red' : a.severity === 'WARNING' ? 'orange' : 'gray'}>{a.severity}</Pill>
                  <span className="muted small">{humanizeKey(a.alert_type)}</span>
                  {a.status === 'ACKNOWLEDGED' && <Pill tone="amber">Acknowledged</Pill>}
                  {a.auto_resolved && <Pill tone="green">Auto-resolved</Pill>}
                </div>
                <strong>{a.title}</strong>
                {a.message && <div className="small">{a.message}</div>}
                <div className="muted small">Detected {fmtDateTime(a.first_detected_at)} · open {fmtDuration(((a.resolved_at ? new Date(a.resolved_at).getTime() : now) - new Date(a.first_detected_at).getTime()) / 1000)}
                  {a.resolution_note ? ` · ${a.resolution_note}` : ''}</div>
              </div>
              <div className="alert-actions">
                {a.employee_id && <Button size="sm" variant="ghost" onClick={() => setProfile(a.employee_id)}>View MP</Button>}
                {a.status === 'OPEN' && <Button size="sm" busy={busy} onClick={() => void run(() => rpc('acknowledge_alert', { p_alert_id: a.id }), 'Acknowledged').then(() => q.refresh())}>Acknowledge</Button>}
                {a.status !== 'RESOLVED' && <Button size="sm" variant="primary" onClick={() => { setResolving(a); setNote(''); }}>Resolve</Button>}
              </div>
            </li>))}
        </ul>
      )}
      {resolving && <Modal title={`Resolve: ${resolving.title}`} onClose={() => setResolving(null)}
        footer={<><Button variant="ghost" onClick={() => setResolving(null)}>Cancel</Button>
          <Button variant="primary" busy={busy} onClick={async () => {
            const r = await run(() => rpc('resolve_alert', { p_alert_id: resolving.id, p_note: note }), 'Resolved');
            if (r) { setResolving(null); void q.refresh(); }
          }}>Resolve</Button></>}>
        <p className="muted small">If the underlying condition is still true (e.g. handover still pending), the sweeper will raise a fresh alert.</p>
        <Field label="Resolution note (required)"><textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </Modal>}
      {profile && <MpProfileDrawer employeeId={profile} onClose={() => setProfile(null)} />}
    </div>
  );
}

function sevRank(s: Alert['severity']) { return s === 'CRITICAL' ? 3 : s === 'WARNING' ? 2 : 1; }
