import { useMemo, useState } from 'react';
import { get } from '../lib/api';
import { useLiveQuery, useNow } from '../hooks/useLive';
import { useAuth } from '../hooks/useAuth';
import type { HandoverLive } from '../lib/types';
import { fmtDuration, fmtTime, HANDOVER_META, siteToday } from '../lib/format';
import { Pill, Button, ErrorBox, Loading, Empty } from '../components/ui';
import { HandoverActionModal, hoActions, HO_ACTION_LABEL, type HoActionKind } from '../components/HandoverActions';
import { downloadCsv, type ExportColumn } from '../lib/export';

function startOfSiteDay() {
  return new Date(`${siteToday()}T00:00:00+05:30`).toISOString();
}

export default function HandoverPage() {
  const { can, profile } = useAuth();
  const isSup = can('admin', 'ops_manager', 'supervisor');
  const now = useNow(1000);
  const [act, setAct] = useState<{ kind: HoActionKind; h: HandoverLive } | null>(null);
  const [hideDemo] = useState(false);
  const [q, setQ] = useState('');

  const data = useLiveQuery<HandoverLive[]>(() => get<HandoverLive[]>('handovers', { since: startOfSiteDay() }),
    ['handover_records', 'handover_items']);

  const rows = useMemo(() => (data.data ?? []).filter((h) => (!hideDemo || !h.is_demo)
    && (!q || `${h.handover_no} ${h.handing_name} ${h.handing_code} ${h.receiver_name ?? ''} ${h.route_ref ?? ''}`.toLowerCase().includes(q.toLowerCase()))), [data.data, hideDemo, q]);

  const live = (h: HandoverLive) => ({ ...h, age: (now - new Date(h.pending_since).getTime()) / 1000,
    overdue: ['PENDING', 'IN_PROGRESS'].includes(h.status) && !!h.due_at && now > new Date(h.due_at).getTime() });

  const active = rows.filter((h) => ['PENDING', 'IN_PROGRESS'].includes(h.status)).map(live);
  const pending = active.filter((h) => h.status === 'PENDING');
  const inProg = active.filter((h) => h.status === 'IN_PROGRESS');
  const overdue = active.filter((h) => h.overdue);
  const disputed = rows.filter((h) => h.status === 'DISPUTED');
  const completed = rows.filter((h) => h.status === 'COMPLETED');
  const returnedNotHanded = pending.filter((h) => h.is_pickup_return);
  const avgMin = completed.length
    ? completed.reduce((s, h) => s + (new Date(h.completed_at!).getTime() - new Date(h.pending_since).getTime()), 0) / completed.length / 60000 : null;
  const longest = active.reduce<ReturnType<typeof live> | null>((m, h) => (!m || h.age > m.age ? h : m), null);

  const byArea = groupCount(active, (h) => h.destination_area_name ?? 'Unspecified');
  const byReceiver = groupCount(inProg, (h) => h.receiver_name ?? 'Not yet picked up');

  const card = (h0: HandoverLive) => {
    const h = live(h0);
    const acts = profile?.role === 'ops_manager' ? [] : hoActions(h, isSup);   // ops_manager: view only
    return (
      <article key={h.id} className={`ho-card ${h.overdue ? 'overdue' : ''} ${h.status === 'DISPUTED' ? 'disputed' : ''}`}>
        <header>
          <span className="mono">#{h.handover_no}</span>
          <Pill tone={HANDOVER_META[h.status].tone}>{h.awaiting_verification ? 'Awaiting verification' : HANDOVER_META[h.status].label}</Pill>
          {h.overdue && <Pill tone="red">OVERDUE</Pill>}
          {h.is_demo && <span className="demo-tag">DEMO</span>}
        </header>
        <div className="ho-who"><strong>{h.handing_name}</strong> <span className="muted">{h.handing_code}</span></div>
        <div className="small">{h.handover_type.replace('_', ' ')}{h.route_ref ? ` · ${h.route_ref}` : ''}{h.source_label ? ` · from ${h.source_label}` : h.source_area_name ? ` · from ${h.source_area_name}` : ''}</div>
        <div className="small">→ {h.destination_area_name ?? 'any receiving area'}{h.receiver_name ? <> · receiver <strong>{h.receiver_name}</strong></> : null}</div>
        <div className="ho-meta">
          <span>Since {fmtTime(h.pending_since)}</span>
          <span className={`mono ${h.overdue ? 'delay' : ''}`}>{h.status === 'COMPLETED' ? `took ${fmtDuration((new Date(h.completed_at!).getTime() - new Date(h.pending_since).getTime()) / 1000)}` : fmtDuration(h.age)}</span>
          {h.items_total > 0 && <span>{h.items_accepted}/{h.items_total} items</span>}
        </div>
        {h.discrepancy_remarks && <div className="small warn-text">⚠ {h.discrepancy_remarks}</div>}
        {h.pending_reason && <div className="small muted">Pending: {h.pending_reason}</div>}
        {acts.length > 0 && <div className="ho-actions">{acts.map((k) => (
          <Button key={k} size="sm" variant={k === 'accept' || k === 'verify' ? 'primary' : k === 'dispute' || k === 'cancel' ? 'danger' : 'ghost'}
            onClick={() => setAct({ kind: k, h })}>{HO_ACTION_LABEL[k]}</Button>))}</div>}
      </article>
    );
  };

  const exportCols: ExportColumn<HandoverLive>[] = [
    { header: 'No', value: (h) => h.handover_no }, { header: 'Type', value: (h) => h.handover_type }, { header: 'Status', value: (h) => h.status },
    { header: 'Handed over by', value: (h) => `${h.handing_name} (${h.handing_code})` }, { header: 'Received by', value: (h) => h.receiver_name },
    { header: 'Destination', value: (h) => h.destination_area_name }, { header: 'Route', value: (h) => h.route_ref },
    { header: 'Pending since', value: (h) => h.pending_since }, { header: 'Completed', value: (h) => h.completed_at },
    { header: 'Discrepancy', value: (h) => h.discrepancy_remarks },
  ];

  return (
    <div className="page">
      <section className="kpis kpis-sm">
        <Metric label="Pending" value={pending.length} tone="orange" />
        <Metric label="In progress" value={inProg.length} tone="amber" />
        <Metric label="Overdue" value={overdue.length} tone="red" alarm={overdue.length > 0} />
        <Metric label="Disputed" value={disputed.length} tone="red" />
        <Metric label="Completed today" value={completed.length} tone="green" />
        <Metric label="Returned, not handed over" value={returnedNotHanded.length} tone="orange" />
        <Metric label="Avg handover time" value={avgMin === null ? '—' : `${avgMin.toFixed(1)}m`} tone="neutral" />
        <Metric label="Longest pending" value={longest ? fmtDuration(longest.age) : '—'} tone={longest?.overdue ? 'red' : 'neutral'} sub={longest?.handing_name} />
      </section>
      <section className="toolbar">
        <input type="search" className="search" placeholder="Search MP, #, route…" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="spacer" />
        <Button size="sm" onClick={() => downloadCsv(rows, exportCols, `handovers-${siteToday()}`)}>CSV</Button>
      </section>
      <ErrorBox error={data.error} />
      {data.loading && !data.data ? <Loading /> : (
        <div className="ho-layout">
          <div className="ho-board">
            <Column title="Overdue" tone="red" items={overdue} render={card} />
            <Column title="Pending" tone="orange" items={pending.filter((h) => !h.overdue)} render={card} />
            <Column title="In progress" tone="amber" items={inProg.filter((h) => !h.overdue)} render={card} />
            <Column title="Disputed" tone="red" items={disputed} render={card} />
            <Column title="Completed today" tone="green" items={[...completed].reverse()} render={card} />
          </div>
          <aside className="ho-side">
            <h4>Pending by area</h4>
            <ul className="bars">{byArea.map(([k, n]) => <li key={k}><span>{k}</span><b>{n}</b></li>)}{!byArea.length && <li className="muted">None</li>}</ul>
            <h4>Pending by receiver</h4>
            <ul className="bars">{byReceiver.map(([k, n]) => <li key={k}><span>{k}</span><b>{n}</b></li>)}{!byReceiver.length && <li className="muted">None</li>}</ul>
          </aside>
        </div>
      )}
      {act && <HandoverActionModal kind={act.kind} h={act.h} onClose={() => setAct(null)} onDone={() => void data.refresh()}
        selfEmployeeId={profile?.role === 'mp' ? profile.employee_id : null} />}
    </div>
  );
}

function groupCount<T>(items: T[], key: (t: T) => string): [string, number][] {
  const m = new Map<string, number>();
  items.forEach((i) => m.set(key(i), (m.get(key(i)) ?? 0) + 1));
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

function Metric({ label, value, tone, alarm, sub }: { label: string; value: number | string; tone: string; alarm?: boolean; sub?: string }) {
  return <div className={`kpi kpi-${tone} static ${alarm ? 'alarm' : ''}`}><span className="kpi-value">{value}</span><span className="kpi-label">{label}{sub ? ` · ${sub}` : ''}</span></div>;
}

function Column({ title, tone, items, render }: { title: string; tone: string; items: HandoverLive[]; render: (h: HandoverLive) => JSX.Element }) {
  return (
    <section className={`ho-col col-${tone}`}>
      <h3>{title} <span className="count">{items.length}</span></h3>
      <div className="ho-col-body">{items.length ? items.map(render) : <Empty title="Nothing here" />}</div>
    </section>
  );
}
