import { GateEnrolButton } from './components/GateEnrol';
import { lazy, Suspense, useEffect, useState } from 'react';
import { HashRouter, Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './hooks/useAuth';
import { useConnection } from './hooks/useLive';
import { useOpenAlerts } from './hooks/useAlerts';
import { get, post } from './lib/api';
import { fmtTime } from './lib/format';
import type { AppRole } from './lib/types';
import { appMode, appServer, BOOT_AUTO, isNativeApp, linkChosenThisRun, markLinkChosen, migrateOnce } from './lib/native';
import { Button, ErrorBox, Field, Loading, ToastProvider } from './components/ui';

const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const HandoverPage = lazy(() => import('./pages/HandoverPage'));
const AreasPage = lazy(() => import('./pages/AreasPage'));
const AlertsPage = lazy(() => import('./pages/AlertsPage'));
const GatePage = lazy(() => import('./pages/GatePage'));
const ReportsPage = lazy(() => import('./pages/ReportsPage'));
const AdminPage = lazy(() => import('./pages/AdminPage'));
const KioskPage = lazy(() => import('./pages/KioskPage'));
const FaceKioskPage = lazy(() => import('./pages/FaceKioskPage'));
const FaceEnrollPage = lazy(() => import('./pages/FaceEnrollPage'));
const SupervisorApp = lazy(() => import('./pages/SupervisorApp'));
const DcGatePage = lazy(() => import('./pages/DcGatePage'));
const AppSetupPage = lazy(() => import('./pages/AppSetupPage'));

// Dashboard: admin (full control) and ops_manager (view only + report downloads).
// Supervisors get the supervisor app, gate operators only the DC IN/OUT screen. MP logins are off.
const DASH: AppRole[] = ['admin', 'ops_manager'];
const NAV: { to: string; label: string; roles: AppRole[]; hidden?: boolean }[] = [
  { to: '/', label: 'Live MPs', roles: DASH },
  { to: '/handovers', label: 'Handovers', roles: DASH },
  { to: '/areas', label: 'Area view', roles: DASH },
  { to: '/alerts', label: 'Alerts', roles: DASH },
  { to: '/gate', label: 'Gate', roles: DASH },
  { to: '/reports', label: 'Reports', roles: DASH },
  { to: '/admin', label: 'Admin', roles: ['admin'] },
  { to: '/face-enroll', label: 'Faces', roles: ['admin'] },
  // not in the dashboard menu
  { to: '/sup', label: 'Supervisor app', roles: ['supervisor', 'admin'], hidden: true },
  { to: '/face-kiosk', label: 'DC IN/OUT', roles: ['gate_operator', 'admin'], hidden: true },
  { to: '/kiosk', label: 'QR kiosk', roles: ['admin'], hidden: true },
];

export default function App() {
  return (
    <ToastProvider>
      <AuthProvider>
        <HashRouter>
          <Shell />
        </HashRouter>
      </AuthProvider>
    </ToastProvider>
  );
}

function home(role: AppRole) {
  return role === 'supervisor' ? '/sup' : role === 'gate_operator' ? '/face-kiosk' : '/';
}

function Shell() {
  const { profile, loading, error } = useAuth();
  const loc = useLocation();
  const wait = <div className="center-screen"><Loading /></div>;
  // SFXBM: every fresh app start begins with the empty link box (a gate tablet, set up by its gate link, still starts straight on its gate screen)
  migrateOnce();
  // cold start with a saved MP link: go straight in, the link box is never shown
  if (BOOT_AUTO && appServer() && appMode() && !linkChosenThisRun()) markLinkChosen();
  if (isNativeApp() && loc.pathname !== '/dc-gate' && !linkChosenThisRun() && !(appMode() === 'gate' && appServer())) return <Suspense fallback={wait}><AppSetupPage /></Suspense>;
  // Android app: setup first; a gate tablet always shows the gate screen (no login)
  if (isNativeApp() && (loc.pathname === '/app-setup' || !appServer() || !appMode())) return <Suspense fallback={wait}><AppSetupPage /></Suspense>;
  if (isNativeApp() && appMode() === 'gate') return <Suspense fallback={wait}><DcGatePage /></Suspense>;
  // gate tablet: fixed link, no login
  if (loc.pathname === '/dc-gate') return <Suspense fallback={<div className="center-screen"><Loading /></div>}><DcGatePage /></Suspense>;
  if (loading) return <div className="center-screen"><Loading label="Signing in…" /></div>;
  if (!profile) return <LoginPage initialError={error} />;

  const allowed = (path: string) => NAV.find((n) => n.to === path)?.roles.includes(profile.role) ?? false;
  const guard = (path: string, el: JSX.Element) => (allowed(path) ? el : <Navigate to={home(profile.role)} replace />);
  const kiosk = ['/kiosk', '/face-kiosk', '/sup'].includes(loc.pathname) || !DASH.includes(profile.role);

  return (
    <div className={`app ${kiosk ? 'app-kiosk' : ''}`}>
      {!kiosk && <Header />}
      <main>
        <Suspense fallback={<Loading />}>
          <Routes>
            <Route path="/" element={guard('/', <DashboardPage />)} />
            <Route path="/handovers" element={guard('/handovers', <HandoverPage />)} />
            <Route path="/areas" element={guard('/areas', <AreasPage />)} />
            <Route path="/alerts" element={guard('/alerts', <AlertsPage />)} />
            <Route path="/gate" element={guard('/gate', <GatePage />)} />
            <Route path="/reports" element={guard('/reports', <ReportsPage />)} />
            <Route path="/admin" element={guard('/admin', <AdminPage />)} />
            <Route path="/kiosk" element={guard('/kiosk', <KioskPage />)} />
            <Route path="/face-kiosk" element={guard('/face-kiosk', <FaceKioskPage />)} />
            <Route path="/face-enroll" element={guard('/face-enroll', <FaceEnrollPage />)} />
            <Route path="/sup" element={guard('/sup', <SupervisorApp />)} />
            <Route path="*" element={<Navigate to={home(profile.role)} replace />} />
          </Routes>
        </Suspense>
      </main>
    </div>
  );
}

function Header() {
  const { profile, signOut, can } = useAuth();
  const conn = useConnection();
  const alertsOn = can('admin', 'ops_manager');
  const { alerts, muted, setMuted } = useOpenAlerts(alertsOn);
  const [navOpen, setNavOpen] = useState(false);
  const critical = alerts.filter((a) => a.severity === 'CRITICAL' && a.status === 'OPEN').length;
  return (
    <header className="topbar">
      <div className="brand"><span className="logo">MP</span><span>Control Tower</span></div>
      <button className="icon-btn nav-toggle" onClick={() => setNavOpen(!navOpen)} aria-label="Menu">☰</button>
      <nav className={navOpen ? 'open' : ''} onClick={() => setNavOpen(false)}>
        {NAV.filter((n) => profile && !n.hidden && n.roles.includes(profile.role)).map((n) => (
          <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => (isActive ? 'active' : '')}>
            {n.label}{n.to === '/alerts' && alerts.length > 0 ? <span className={`badge ${critical ? 'badge-crit' : ''}`}>{alerts.length}</span> : null}
          </NavLink>))}
      </nav>
      <div className="topbar-right">
        <span className={`conn conn-${conn.status}`} title={`Last data refresh ${fmtTime(conn.lastRefresh ? new Date(conn.lastRefresh).toISOString() : null)}`}>
          <span className="dot" />{conn.status === 'live' ? 'Live' : conn.status}
          <span className="muted small"> · {conn.lastRefresh ? fmtTime(new Date(conn.lastRefresh).toISOString()) : '—'}</span>
        </span>
        {alertsOn && <button className={`icon-btn ${muted ? '' : 'on'}`} onClick={() => setMuted(!muted)} title={muted ? 'Sound alerts muted' : 'Sound alerts on'} aria-label={muted ? 'Unmute alerts' : 'Mute alerts'}>{muted ? '🔇' : '🔔'}</button>}
        {profile && ['admin', 'ops_manager', 'supervisor'].includes(profile.role) && <GateEnrolButton inline />}
        <span className="who">{profile?.full_name}<span className="muted small"> · {profile?.role.replace('_', ' ')}</span></span>
        <Button size="sm" variant="ghost" onClick={() => signOut()}>Sign out</Button>
      </div>
    </header>
  );
}

function LoginPage({ initialError }: { initialError: string | null }) {
  const { signIn } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [err, setErr] = useState<string | null>(initialError);
  const [busy, setBusy] = useState(false);
  const [setup, setSetup] = useState<{ setup_needed: boolean; local: boolean } | null>(null);
  useEffect(() => { get<{ setup_needed: boolean; local: boolean }>('auth/setup-needed').then(setSetup).catch(() => setSetup(null)); }, []);
  const first = setup?.setup_needed;

  return (
    <div className="center-screen login">
      <form className="login-card" onSubmit={async (e) => {
        e.preventDefault(); setBusy(true); setErr(null);
        try {
          if (first) await post('auth/setup', { username, password, full_name: name });
          await signIn(username, password);
        } catch (ex) {
          setErr(ex instanceof Error ? ex.message : String(ex));
        } finally { setBusy(false); }
      }}>
        <div className="brand big"><span className="logo">MP</span><span>Control Tower</span></div>
        <p className="muted">{first ? 'First-time setup — create the administrator account' : 'Manpower tracking, movement & handover'}</p>
        {first && !setup?.local && <ErrorBox error="First-time setup must be done on the server PC itself: open http://localhost:8010 there." />}
        <ErrorBox error={err} />
        {first && <Field label="Your name"><input value={name} onChange={(e) => setName(e.target.value)} required /></Field>}
        <Field label="Username"><input autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required autoCapitalize="none" /></Field>
        <Field label={first ? 'Password (min 8)' : 'Password'}><input type="password" autoComplete={first ? 'new-password' : 'current-password'} value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
        <Button variant="primary" busy={busy} type="submit" disabled={first && !setup?.local}>{first ? 'Create admin & sign in' : 'Sign in'}</Button>
        {isNativeApp() && <button type="button" className="link-btn small muted" onClick={() => { window.location.hash = '#/app-setup'; }}>
          Server: {appServer()} · App setup</button>}
      </form>
    </div>
  );
}
