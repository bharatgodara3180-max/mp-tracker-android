import { useEffect, useMemo, useState } from 'react';
import { get } from '../lib/api';
import { useLiveQuery, useNow, useConnection } from '../hooks/useLive';
import { useRefData } from '../hooks/useRefData';
import type { Kpis, MpLive } from '../lib/types';
import { fmtDuration, fmtTime, secondsSince, STATUS_META } from '../lib/format';
import { ErrorBox, Loading, Button } from '../components/ui';
import { MpProfileDrawer } from '../components/MpProfile';

interface Panel { key: string; title: string; capacity: number | null; tone: string; members: MpLive[] }

export default function AreasPage() {
  const ref = useRefData();
  const now = useNow(1000);
  const conn = useConnection();
  const [tv, setTv] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [hideDemo, setHideDemo] = useState(false);

  useEffect(() => {
    document.body.classList.toggle('tv-mode', tv);
    if (tv && document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
    if (!tv && document.fullscreenElement) document.exitFullscreen().catch(() => {});
    return () => document.body.classList.remove('tv-mode');
  }, [tv]);

  const live = useLiveQuery<{ rows: MpLive[]; kpis: Kpis }>(async () => {
    const r = await get<{ rows: MpLive[]; kpis: Kpis }>('live', { include_demo: !hideDemo });
    return { rows: r.rows.filter((x) => x.status !== 'NOT_CHECKED_IN' && x.status !== 'SHIFT_ENDED'), kpis: r.kpis };
  }, ['mp_current_state', 'handover_records', 'alerts', 'work_assignments', 'pickup_assignments'], [hideDemo]);

  const panels = useMemo<Panel[]>(() => {
    const rows = (live.data?.rows ?? []).filter((r) => !hideDemo || !r.is_demo);
    const byArea = new Map<string, MpLive[]>();
    rows.filter((r) => r.status === 'WORKING' && r.area_id && r.out_state !== 'ASSIGNED').forEach((r) => byArea.set(r.area_id!, [...(byArea.get(r.area_id!) ?? []), r]));
    const areaPanels: Panel[] = ref.areas
      .filter((a) => !a.out_purpose && (a.is_active || byArea.has(a.id)))
      .map((a) => ({ key: a.id, title: a.name, capacity: null, tone: 'green', members: byArea.get(a.id) ?? [] }));
    // two panels per OUT option made in Admin -> Areas: Assigned for X -> On X
    const outPanels: Panel[] = ref.areas.filter((a) => a.out_purpose && a.is_active).flatMap((a) => [
      { key: `asg:${a.id}`, title: `Assigned for ${a.name}`, capacity: null, tone: 'amber', members: rows.filter((r) => r.out_state === 'ASSIGNED' && r.out_area_id === a.id) },
      { key: `out:${a.id}`, title: `On ${a.name}`, capacity: null, tone: a.out_purpose === 'LUNCH' ? 'violet' : 'blue', members: rows.filter((r) => r.out_state === 'OUT' && r.out_area_id === a.id) },
    ]);
    return [
      ...areaPanels,
      ...outPanels,
      { key: 'handover', title: 'Handover', capacity: null, tone: 'orange', members: rows.filter((r) => r.status.startsWith('HANDOVER')) },
      { key: 'unassigned', title: 'Unassigned', capacity: null, tone: 'amber', members: rows.filter((r) => r.status === 'INSIDE_UNASSIGNED' && r.out_state !== 'ASSIGNED') },
    ];
  }, [live.data, ref.areas, hideDemo]);

  const k = live.data?.kpis;
  return (
    <div className={`page areas-page ${tv ? 'tv' : ''}`}>
      <section className="toolbar">
        {tv && <div className="tv-title">MP Control Tower <span className="muted">· {new Date(now).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false })}</span></div>}
        {k && <div className="tv-strip">
          <span><b>{k.total_on_shift}</b> on shift</span><span><b>{k.inside}</b> inside</span><span className={k.handover_pending ? 'warn-text' : ''}><b>{k.handover_pending}</b> handover pending</span>
          <span className={k.handover_overdue ? 'delay' : ''}><b>{k.handover_overdue}</b> overdue</span><span><b>{k.unassigned}</b> unassigned</span>
        </div>}
        <span className="spacer" />
        <label className="check"><input type="checkbox" checked={hideDemo} onChange={(e) => setHideDemo(e.target.checked)} /> Hide demo</label>
        {tv && <span className={`conn conn-${conn.status}`}>{conn.status}</span>}
        <Button size="sm" onClick={() => setTv(!tv)}>{tv ? 'Exit TV mode' : 'TV mode'}</Button>
      </section>
      <ErrorBox error={live.error} />
      {live.loading && !live.data ? <Loading /> : (
        <div className="area-grid">
          {panels.map((p) => {
            const pct = p.capacity ? Math.min(100, (p.members.length / p.capacity) * 100) : null;
            return (
              <section key={p.key} className={`area-panel tone-border-${p.tone}`}>
                <header>
                  <h3>{p.title}</h3>
                  <span className="area-count">{p.members.length}{p.capacity ? <small>/{p.capacity}</small> : null}</span>
                </header>
                {pct !== null && <div className="cap-bar" title={`${Math.round(pct)}% of capacity`}><span style={{ width: `${pct}%` }} className={pct >= 100 ? 'full' : pct < 50 ? 'low' : ''} /></div>}
                <div className="area-sub">
                  {p.members.filter((m) => m.current_task).length > 0 && <span>{new Set(p.members.map((m) => m.current_task).filter(Boolean)).size} active tasks</span>}
                </div>
                <ul className="chips">
                  {[...p.members].sort((a, b) => a.status_since.localeCompare(b.status_since)).map((m) => {
                    return (
                      <li key={m.employee_id} className={`chip tone-${STATUS_META[m.status].tone}`} onClick={() => setOpen(m.employee_id)}
                          title={`${m.full_name} · ${STATUS_META[m.status].label}${m.route_ref ? ' · ' + m.route_ref : ''}`}>
                        <span className="chip-name">{m.full_name}</span>
                        <span className="chip-meta">{p.key.length > 20 ? (m.current_task ?? '') : STATUS_META[m.status].short}{m.route_ref ? ` · ${m.route_ref}` : ''}</span>
                        <span className="chip-time mono">{fmtDuration(secondsSince(m.status_since, now))}</span>
                      </li>);
                  })}
                  {!p.members.length && <li className="muted small">—</li>}
                </ul>
              </section>
            );
          })}
        </div>
      )}
      {tv && <footer className="tv-foot muted">Last refresh {fmtTime(conn.lastRefresh ? new Date(conn.lastRefresh).toISOString() : null)}</footer>}
      {open && !tv && <MpProfileDrawer employeeId={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
