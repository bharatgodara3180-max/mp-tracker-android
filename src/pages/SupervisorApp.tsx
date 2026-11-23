/**
 * Supervisor app: login -> select your work area -> entry page (Deploy / OUT assign by Face, QR or Manual).
 * Top-right icons: current deployment (area-wise), Handover (give an MP of my area to another area)
 * and Notifications (handovers given to my area -> Receive). No MP moves between areas without
 * handover + takeover.
 */
import { useEffect, useRef, useState } from 'react';
import { get, imageUrl, post } from '../lib/api';
import { useAuth } from '../hooks/useAuth';
import { useRefData } from '../hooks/useRefData';
import { useLiveQuery } from '../hooks/useLive';
import { fmtTime } from '../lib/format';
import type { Area, MpLive } from '../lib/types';
import { Button, Loading, useToast, VersionTag } from '../components/ui';
import { InstallAppButton } from '../components/InstallApp';
import { playSound } from '../components/FaceKiosk';
import { ScanPanel, type ScanId, type ScanReply } from '../components/ScanPanel';
import { GateEnrolButton } from '../components/GateEnrol';

interface Transfer { id: string; employee_id: string; employee_code: string; full_name: string; from_area: string; from_code: string;
  to_area: string; to_code: string; created_at: string; given_by: string | null; has_photo: boolean }
type Sheet = null | 'deployment' | 'handover' | 'inbox';
type OutPurpose = 'PICKUP' | 'LUNCH' | 'OTHER';

const Icon = {
  deployment: <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></svg>,
  handover: <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 8h13l-3-3" /><path d="M20 16H7l3 3" /></svg>,
  bell: <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 8 3 8H3s3-1 3-8" /><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0" /></svg>,
  logout: <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="M16 17l5-5-5-5" /><path d="M21 12H9" /></svg>,
};

export default function SupervisorApp() {
  const { profile, signOut } = useAuth();
  const ref = useRefData();
  const areaKey = `mp-sup-area:${profile?.user_id ?? ''}`;
  const [area, setArea] = useState(() => localStorage.getItem(areaKey) ?? '');
  const [sheet, setSheet] = useState<Sheet>(null);
  const [enrolOpen, setEnrolOpen] = useState(false);     // the enrol window needs the camera
  const [action, setAction] = useState<'deploy' | 'out'>('deploy');
  const [outPick, setOutPick] = useState<string>('LUNCH');   // OUT option id (admin-made) or a plain purpose
  // OUT options come from Admin -> Areas (OUT type); without any, plain Pickup / Lunch / Other
  // Pickup is not an OUT-assign option: MPs are deployed into the Pickup area instead
  const outOpts = ref.outOptions.filter((o) => o.out_purpose !== 'PICKUP');
  const allAreas = [...ref.workAreas, ...ref.outOptions.filter((o) => o.out_purpose === 'PICKUP')];   // handover: every area, incl. Pickup
  // the areas the admin ticked for this supervisor (none ticked = all)
  const mine = useLiveQuery<{ area_ids: string[] }>(() => get('supervisor/my-areas'), [], []);
  const pickAreas = allAreas.filter((a) => { const m = mine.data?.area_ids ?? []; return !m.length || m.includes(a.id); });
  const toast = useToast();
  const outChoices: { key: string; label: string; purpose: OutPurpose; areaId?: string }[] = outOpts.length
    ? outOpts.map((o) => ({ key: o.id, label: o.name, purpose: (o.out_purpose ?? 'OTHER') as OutPurpose, areaId: o.id }))
    : [{ key: 'LUNCH', label: 'Lunch', purpose: 'LUNCH' }, { key: 'OTHER', label: 'Other', purpose: 'OTHER' }];
  const outChoice = outChoices.find((c) => c.key === outPick) ?? outChoices[0];
  const purpose = outChoice?.purpose ?? 'LUNCH';
  const [route, setRoute] = useState('');
  // how many MPs are in my area right now (Pickup-type area: assigned for / on pickup)
  const areaLive = useLiveQuery<{ rows: MpLive[] }>(() => (area ? get('live') : Promise.resolve({ rows: [] })),
    ['mp_current_state', 'work_assignments', 'pickup_assignments'], [area], { pollMs: 20000 });
  const areaRow = pickAreas.find((a) => a.id === area);
  const isPickupArea = areaRow?.out_purpose === 'PICKUP';

  const inbox = useLiveQuery<Transfer[]>(() => (area ? get<Transfer[]>('transfer/incoming', { area_id: area }) : Promise.resolve([])), [], [area], { pollMs: 15000 });
  const pending = inbox.data?.length ?? 0;
  const lastPending = useRef(0);
  useEffect(() => { if (pending > lastPending.current) playSound(false); lastPending.current = pending; }, [pending]);

  // choosing a work area opens Deploy with Manual type ready
  const pickArea = (id: string) => {
    setAction('deploy');
    // a supervisor-ID employee is deployed into the chosen area by himself (auto DC IN first when he is not inside)
    post<{ deployed?: boolean; reason?: string }>('supervisor/self-deploy', { area_id: id })
      .then((r) => { if (r && r.deployed === false && r.reason) toast('err', r.reason); void areaLive.refresh(); })
      .catch((e) => toast('err', e instanceof Error ? e.message : String(e)));
    try { localStorage.setItem(areaKey, id); localStorage.setItem('mp-scan-mode', 'manual'); } catch { /* ignore */ }
    setArea(id);
  };
  const changeArea = () => { setSheet(null); try { localStorage.removeItem(areaKey); } catch { /* ignore */ } setArea(''); };
  const logout = () => { try { localStorage.removeItem(areaKey); } catch { /* ignore */ } signOut(); };

  if (ref.loading && !ref.workAreas.length) return <div className="center-screen"><Loading /></div>;

  if (!areaRow) return (
    <div className="kiosk sup-pick">
      <VersionTag />
      <header className="sup-top"><strong>Namaste, {profile?.full_name}</strong><span className="spacer" />
        <button className="btn btn-ghost btn-sm" onClick={logout}>{Icon.logout} Logout</button></header>
      <h2 className="sup-title">Apna Work Area chuniye</h2>
      <div className="area-grid">
        {pickAreas.map((a) => <button key={a.id} className="area-btn" onClick={() => pickArea(a.id)}><b>{a.name}</b><span>{a.code}</span></button>)}
      </div>
      <InstallAppButton label="Phone pe app install karein" className="btn btn-sm install-strip" />
    </div>
  );

  const submit = (id: ScanId) => (action === 'deploy'
    ? post<ScanReply>('face/deploy', { ...id, area_id: area })
    : post<ScanReply>('face/assign-out', { ...id, purpose, out_area_id: outChoice?.areaId, area_id: area, route_ref: purpose === 'PICKUP' ? route.trim() || null : null }));

  return (
    <div className="kiosk sup-app">
      <header className="sup-top">
        <button className="sup-area" onClick={changeArea} title="Work area badlein (logout nahi hoga)">
          <span className="muted small">Work area · badlein ▾</span><strong>{areaRow.name}</strong></button>
        <span className="pill tone-green sup-count" title={`${areaRow.name} mein abhi`}>
          <b>{(areaLive.data?.rows ?? []).filter((r) => (isPickupArea
            ? r.out_area_id === area && !!r.out_state
            : r.status === 'WORKING' && r.area_id === area && r.out_state !== 'ASSIGNED')).length}</b> deployed</span>
        <GateEnrolButton inline onOpenChange={setEnrolOpen} />
        {__APP_VERSION__ && <span className="muted small" title="Installed app version">v{__APP_VERSION__}</span>}
        <button className="icon-btn small" onClick={() => { if (confirm('Logout karna hai?')) logout(); }} title="Logout">{Icon.logout}</button>
      </header>
      <div className="sup-icons">
        <button className="round-btn" onClick={() => setSheet('deployment')} title="Current deployment">{Icon.deployment}<span>Deploy list</span></button>
        <button className="round-btn" onClick={() => setSheet('handover')} title="Handover">{Icon.handover}<span>Handover</span></button>
        <button className="round-btn" onClick={() => setSheet('inbox')} title="Notifications">{Icon.bell}<span>Receive</span>
          {pending > 0 && <i className="badge">{pending}</i>}</button>
      </div>

      <div className="action-switch" role="tablist">
        <button role="tab" aria-selected={action === 'deploy'} className={action === 'deploy' ? 'active' : ''} onClick={() => setAction('deploy')}>Deploy</button>
        <button role="tab" aria-selected={action === 'out'} className={action === 'out' ? 'active out' : ''} onClick={() => setAction('out')}>OUT assign</button>
      </div>
      {action === 'out' && <div className="out-purpose">
        <span className="muted small">OUT kis liye:</span>
        {outChoices.map((c) => <button key={c.key} className={`tag ${outChoice?.key === c.key ? 'on' : ''}`} onClick={() => setOutPick(c.key)}>{c.label}</button>)}
        {purpose === 'PICKUP' && <input className="route-input" value={route} onChange={(e) => setRoute(e.target.value)} placeholder="Route / ref (optional)" />}
      </div>}
      <ScanPanel active={sheet === null && !enrolOpen} buttonLabel={action === 'deploy' ? 'Deploy' : 'OUT assign'} submit={submit}
                 onResult={(r) => { if (!r.result.alarm) void areaLive.refresh(); }} />
      <p className="muted small kiosk-foot">{action === 'deploy'
        ? (isPickupArea ? `Scan kiye MP ${areaRow.name} ke liye assign honge ("Assigned for ${areaRow.name}"), gate se OUT hote hi "On ${areaRow.name}".`
          : `Scan kiye MP ${areaRow.name} mein deploy honge. Doosre area wale MP ke liye pehle wahan se handover chahiye.`)
        : 'Gate pe DC OUT sirf assign hue OUT se hoga. 9 ghante baad shift-end OUT ke liye assign ki zarurat nahi.'}</p>

      {sheet === 'deployment' && <DeploymentSheet myArea={area} areas={ref.workAreas} onClose={() => setSheet(null)} />}
      {sheet === 'handover' && <HandoverSheet myArea={areaRow} areas={allAreas} onClose={() => setSheet(null)} />}
      {sheet === 'inbox' && <InboxSheet myArea={areaRow} items={inbox.data ?? []} onChanged={() => void inbox.refresh()} onClose={() => setSheet(null)} />}
    </div>
  );
}

function SheetFrame({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="sheet">
      <header className="sheet-head"><strong>{title}</strong><span className="spacer" /><button className="btn btn-ghost" onClick={onClose}>✕ Band karo</button></header>
      <div className="sheet-body">{children}</div>
    </div>
  );
}

/* ---------- current deployment, area-wise (tap a row -> popup with the list, tap a name -> photo) ---------- */
function DeploymentSheet({ myArea, areas, onClose }: { myArea: string; areas: Area[]; onClose: () => void }) {
  const live = useLiveQuery<{ rows: MpLive[] }>(() => get('live'), [], [], { pollMs: 5000 });
  const [pop, setPop] = useState<{ title: string; ids: string[] } | null>(null);
  const [sel, setSel] = useState<MpLive | null>(null);
  const rows = live.data?.rows ?? [];
  const assigned = (r: MpLive) => r.out_state === 'ASSIGNED';
  const working = (id: string) => rows.filter((r) => r.status === 'WORKING' && r.area_id === id && !assigned(r));
  const unassigned = rows.filter((r) => r.status === 'INSIDE_UNASSIGNED' && !assigned(r));
  const asgPickup = rows.filter((r) => assigned(r) && !!r.pickup_id);
  const asgLunch = rows.filter((r) => assigned(r) && !r.pickup_id);
  const onPickup = rows.filter((r) => ['OUTSIDE_PICKUP', 'OUTSIDE_OFFICIAL', 'OUTSIDE_OTHER'].includes(r.status));
  const onLunch = rows.filter((r) => r.status === 'OUTSIDE_BREAK' || r.status === 'ON_BREAK');
  const ordered = [...areas].sort((a, b) => (a.id === myArea ? -1 : b.id === myArea ? 1 : a.name.localeCompare(b.name)));
  const tm = (t: string | null) => (t ? new Date(t).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '');
  const detail = (r: MpLive) => [r.area_name, r.current_task, r.out_area_name && `→ ${r.out_area_name}`, r.pickup_destination, r.route_ref,
    r.expected_return_at && `wapsi ${tm(r.expected_return_at)}`].filter(Boolean).join(' · ');
  const row = (key: string, title: string, list: MpLive[], mine = false) => (
    <div key={key} className={`dep-area ${mine ? 'mine' : ''}`}>
      <button className="dep-head" onClick={() => setPop({ title, ids: list.map((r) => r.employee_id) })}>
        <b>{title}</b>{mine && <span className="pill tone-blue">Mera area</span>}<span className="spacer" />
        <span className="dep-count">{list.length}</span>
      </button>
    </div>);
  const shown = pop ? pop.ids.map((id) => rows.find((r) => r.employee_id === id)).filter((r): r is MpLive => !!r) : [];
  const ov: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.65)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 12 };
  const box: React.CSSProperties = { background: '#161b26', border: '1px solid #2b3446', borderRadius: 12, width: 'min(560px,100%)', maxHeight: '85vh', display: 'flex', flexDirection: 'column', color: '#e8ecf4' };
  return (
    <SheetFrame title="Current deployment (area-wise)" onClose={onClose}>
      {!live.data ? <Loading /> : <>
        {ordered.map((a) => row(a.id, a.name, working(a.id), a.id === myArea))}
        {row('aP', 'ASSIGNED FOR PICKUP', asgPickup)}
        {row('aL', 'ASSIGNED FOR LUNCH', asgLunch)}
        {row('oP', 'ON PICKUP', onPickup)}
        {row('oL', 'ON LUNCH', onLunch)}
        {row('un', 'DC ke andar — kisi area mein nahi', unassigned)}
      </>}
      {pop && <div style={{ ...ov, zIndex: 60 }} onClick={() => setPop(null)}>
        <div style={box} onClick={(e) => e.stopPropagation()}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px', borderBottom: '1px solid #2b3446' }}>
            <b style={{ flex: 1 }}>{pop.title}</b><span className="dep-count">{shown.length}</span>
            <button className="btn btn-ghost btn-sm" onClick={() => setPop(null)}>✕</button>
          </div>
          <div style={{ overflowY: 'auto', padding: '6px 10px 12px' }}>
            {shown.length ? shown.map((r) => (
              <button key={r.employee_id} onClick={() => setSel(r)} style={{ display: 'block', width: '100%', textAlign: 'left', background: 'transparent', border: 0, borderBottom: '1px solid #232b3b', padding: '9px 4px', color: 'inherit', cursor: 'pointer' }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}><b>{r.full_name}</b><span className="mono muted">{r.employee_code}</span>
                  <span style={{ flex: 1 }} /><span className="muted small">{fmtTime(r.status_since)} se</span></div>
                {detail(r) && <div className="muted small" style={{ marginTop: 2 }}>{detail(r)}</div>}
              </button>)) : <p className="muted" style={{ padding: 12 }}>Koi MP nahi</p>}
          </div>
        </div>
      </div>}
      {sel && <div style={{ ...ov, zIndex: 70 }} onClick={() => setSel(null)}>
        <div style={{ ...box, width: 'min(320px,100%)', alignItems: 'center', padding: 16, gap: 8 }} onClick={(e) => e.stopPropagation()}>
          <BigPhoto id={sel.employee_id} />
          <b style={{ fontSize: 18 }}>{sel.full_name}</b><span className="mono muted">{sel.employee_code}</span>
          {detail(sel) && <span className="muted small">{detail(sel)}</span>}
          <button className="btn btn-ghost btn-sm" onClick={() => setSel(null)}>Band karo</button>
        </div>
      </div>}
    </SheetFrame>
  );
}

function BigPhoto({ id }: { id: string }) {
  const [state, setState] = useState<{ url: string | null; done: boolean }>({ url: null, done: false });
  useEffect(() => {
    let u: string | null = null; let alive = true;
    setState({ url: null, done: false });
    void imageUrl(`face/photo/${id}`).then((x) => { u = x; if (alive) setState({ url: x, done: true }); else if (x) URL.revokeObjectURL(x); })
      .catch(() => { if (alive) setState({ url: null, done: true }); });
    return () => { alive = false; if (u) URL.revokeObjectURL(u); };
  }, [id]);
  return state.url ? <img src={state.url} alt="" style={{ width: 240, maxWidth: '100%', borderRadius: 10, objectFit: 'cover' }} />
    : <div className="muted" style={{ padding: '40px 0' }}>{state.done ? 'Photo nahi hai' : 'Photo aa rahi hai…'}</div>;
}

/* ---------- give an MP of my area to another area ---------- */
function HandoverSheet({ myArea, areas, onClose }: { myArea: Area; areas: Area[]; onClose: () => void }) {
  const [target, setTarget] = useState<Area | null>(null);
  const out = useLiveQuery<Transfer[]>(() => get('transfer/outgoing', { area_id: myArea.id }), [], [myArea.id]);
  return (
    <SheetFrame title={target ? `Handover: ${myArea.name} → ${target.name}` : 'Handover — kis area ko dena hai?'} onClose={onClose}>
      {!target ? <>
        <div className="area-grid">
          {areas.filter((a) => a.id !== myArea.id).map((a) => <button key={a.id} className="area-btn" onClick={() => setTarget(a)}><b>{a.name}</b><span>{a.code}</span></button>)}
        </div>
        {(out.data?.length ?? 0) > 0 && <>
          <h4>Diye hue handover (receive hone baaki)</h4>
          <ul className="dep-list">{out.data!.map((t) => <li key={t.id}><span>{t.full_name} <span className="mono muted">{t.employee_code}</span></span>
            <span className="muted small">→ {t.to_area} · {fmtTime(t.created_at)}</span></li>)}</ul>
        </>}
      </> : <>
        <button className="btn btn-ghost btn-sm" onClick={() => setTarget(null)}>← Area badlein</button>
        <p className="small">MP ko scan kariye — wo {target.name} ke supervisor ke paas Receive ke liye chala jayega. Receive hone tak MP {myArea.name} mein hi rahega.</p>
        <ScanPanel active buttonLabel="Handover" submit={(id) => post<ScanReply>('transfer', { ...id, from_area_id: myArea.id, to_area_id: target.id })}
                   onResult={() => void out.refresh()} />
      </>}
    </SheetFrame>
  );
}

/* ---------- handovers given to my area -> receive ---------- */
function InboxSheet({ myArea, items, onChanged, onClose }: { myArea: Area; items: Transfer[]; onChanged: () => void; onClose: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const act = async (t: Transfer, kind: 'receive' | 'reject') => {
    if (kind === 'reject' && !confirm(`${t.full_name} ka handover reject karein?`)) return;
    setBusy(t.id);
    try {
      const r = await post<{ result?: { label: string; sub?: string; alarm?: boolean } }>(`transfer/${t.id}/${kind}`, { area_id: myArea.id });
      if (r.result) { playSound(!!r.result.alarm); toast(r.result.alarm ? 'err' : 'ok', `${r.result.label}${r.result.sub ? ` — ${r.result.sub}` : ''}`); }
      else toast('ok', 'Handover reject kar diya');
    } catch (e) { playSound(true); toast('err', e instanceof Error ? e.message : String(e)); }
    setBusy(null); onChanged();
  };
  return (
    <SheetFrame title={`${myArea.name} ke liye handover`} onClose={onClose}>
      {!items.length ? <p className="muted">Abhi koi handover nahi aaya.</p> : items.map((t) => (
        <div key={t.id} className="inbox-card">
          <Photo id={t.has_photo ? t.employee_id : null} />
          <div className="inbox-info"><b>{t.full_name}</b> <span className="mono muted">{t.employee_code}</span>
            <div className="small">{t.from_area} → <b>{t.to_area}</b></div>
            <div className="muted small">{t.given_by ? `${t.given_by} ne diya · ` : ''}{fmtTime(t.created_at)}</div></div>
          <div className="inbox-actions">
            <Button variant="primary" busy={busy === t.id} onClick={() => void act(t, 'receive')}>Receive</Button>
            <Button variant="ghost" size="sm" disabled={busy === t.id} onClick={() => void act(t, 'reject')}>Reject</Button>
          </div>
        </div>))}
    </SheetFrame>
  );
}

function Photo({ id }: { id: string | null }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let u: string | null = null; let alive = true;
    if (id) void imageUrl(`face/photo/${id}`).then((x) => { u = x; if (alive) setUrl(x); });
    return () => { alive = false; if (u) URL.revokeObjectURL(u); };
  }, [id]);
  return url ? <img className="inbox-photo" src={url} alt="" /> : <div className="inbox-photo empty" />;
}
