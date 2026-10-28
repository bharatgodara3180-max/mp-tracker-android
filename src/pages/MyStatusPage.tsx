import { useState } from 'react';
import { get, rpc, requestId } from '../lib/api';
import { useAuth } from '../hooks/useAuth';
import { useLiveQuery, useNow } from '../hooks/useLive';
import type { HandoverLive, MpLive } from '../lib/types';
import { fmtDuration, fmtTime, secondsSince, statusLabel, STATUS_META, HANDOVER_META } from '../lib/format';
import { Button, ErrorBox, Loading, Pill, useAction, Empty } from '../components/ui';
import { HandoverActionModal, type HoActionKind } from '../components/HandoverActions';

export default function MyStatusPage() {
  const { profile } = useAuth();
  const now = useNow(1000);
  const { busy, run } = useAction();
  const [act, setAct] = useState<{ kind: HoActionKind; h: HandoverLive } | null>(null);
  const me = profile?.employee_id;

  const data = useLiveQuery(async () => {
    const [live, hos] = await Promise.all([
      get<{ rows: MpLive[] }>('live'),
      get<HandoverLive[]>('handovers', { active: true }),
    ]);
    const mine = live.rows.filter((r) => r.employee_id === me);
    const incoming = hos.filter((h) => h.handing_employee_id !== me);
    return { me: mine[0] ?? null, incoming };
  }, ['mp_current_state', 'handover_records'], [me]);

  if (!me) return <div className="page"><Empty title="Your login is not linked to an employee record">Ask an administrator to link it.</Empty></div>;
  if (!data.data) return <div className="page"><ErrorBox error={data.error} /><Loading /></div>;
  const m = data.data.me;
  return (
    <div className="page narrow-page">
      {m && <section className="me-card">
        <div className="eyebrow">{m.employee_code}</div>
        <h2>{m.full_name}</h2>
        <Pill tone={STATUS_META[m.status].tone}>{statusLabel(m)}</Pill>
        <div className="me-big mono">{fmtDuration(secondsSince(m.status_since, now))}</div>
        <dl className="facts">
          <div><dt>Area</dt><dd>{m.area_name ?? '—'}{m.current_task ? ` · ${m.current_task}` : ''}</dd></div>
          <div><dt>Supervisor</dt><dd>{m.supervisor_name ?? '—'}</dd></div>
          <div><dt>Last gate</dt><dd>{m.last_gate_direction ?? '—'} {fmtTime(m.last_gate_event_at)}</dd></div>
          {m.handover_status && <div><dt>My handover</dt><dd>#{m.handover_no} {HANDOVER_META[m.handover_status].label}{m.receiver_name ? ` → ${m.receiver_name}` : ''}</dd></div>}
        </dl>
        <div className="row gap">
          {['INSIDE_UNASSIGNED', 'WORKING'].includes(m.status) && <Button busy={busy} onClick={() => void run(() => rpc('start_break', { p_employee_id: me, p_break_type: 'LUNCH', p_expected_version: m.version, p_client_request_id: requestId() }), 'Lunch started').then(() => data.refresh())}>Start lunch</Button>}
          {['INSIDE_UNASSIGNED', 'WORKING'].includes(m.status) && <Button busy={busy} onClick={() => void run(() => rpc('start_break', { p_employee_id: me, p_break_type: 'TEA', p_expected_version: m.version, p_client_request_id: requestId() }), 'Break started').then(() => data.refresh())}>Start tea break</Button>}
          {m.status === 'ON_BREAK' && <Button variant="primary" busy={busy} onClick={() => void run(() => rpc('end_break', { p_employee_id: me, p_expected_version: m.version, p_client_request_id: requestId() }), 'Welcome back').then(() => data.refresh())}>End break</Button>}
        </div>
      </section>}
      <section className="panel">
        <h3>Handovers I can receive</h3>
        <p className="muted small">Accept only after you have physically received the items/responsibility. Use Dispute for any shortage or damage.</p>
        {m && !['WORKING', 'INSIDE_UNASSIGNED'].includes(m.status) && <p className="warn-text small">You must be inside and on duty to receive a handover.</p>}
        {data.data.incoming.length === 0 ? <Empty title="No pending handovers" /> : (
          <ul className="list">{data.data.incoming.map((h) => (
            <li key={h.id} className="list-row">
              <div><strong>#{h.handover_no} {h.handing_name}</strong> <span className="muted">{h.handing_code}</span>
                <div className="small muted">{h.handover_type.replace('_', ' ')}{h.route_ref ? ` · ${h.route_ref}` : ''}{h.destination_area_name ? ` · to ${h.destination_area_name}` : ''} · {h.items_total} items · waiting {fmtDuration((now - new Date(h.pending_since).getTime()) / 1000)}</div></div>
              <div className="row gap">
                <Button size="sm" variant="primary" onClick={() => setAct({ kind: 'accept', h })}>Accept</Button>
                <Button size="sm" variant="danger" onClick={() => setAct({ kind: 'dispute', h })}>Dispute</Button>
              </div>
            </li>))}</ul>)}
      </section>
      {act && <HandoverActionModal kind={act.kind} h={act.h} selfEmployeeId={me} onClose={() => setAct(null)} onDone={() => void data.refresh()} />}
    </div>
  );
}
