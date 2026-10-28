import { lazy, Suspense, useEffect, useState } from 'react';
import { HashRouter, Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './hooks/useAuth';
import { useConnection } from './hooks/useLive';
import { useOpenAlerts } from './hooks/useAlerts';
import { get, post } from './lib/api';
import { fmtTime } from './lib/format';
import type { AppRole } from './lib/types';
import { appMode, appServer, isNativeApp } from './lib/native';
import { Button, ErrorBox, Field, Loading, ToastProvider } from './components/ui';

const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const HandoverPage = lazy(() => import('./pages/HandoverPage'));
const AreasPage = lazy(() => import('./pages/AreasPage'));
const AlertsPage = lazy(() => import('./pages/AlertsPage'));
const GatePage = lazy(() => import('./pages/GatePage'));
const ReportsPage = lazy(() => import('./pages/ReportsPage'));
const AdminPage = lazy(() => import('./pages/AdminPage'));
const KioskPage = lazy(() => import('./pages/KioskPage'));
const MyStatusPage = lazy(() => import('./pages/MyStatusPage'));
const FaceKioskPage = lazy(() => import('./pages/FaceKioskPage'));
const FaceEnrollPage = lazy(() => import('./pages/FaceEnrollPage'));
const DeployPage = lazy(() => import('./pages/DeployPage'));
const DcGatePage = lazy(() => import('./pages/DcGatePage'));
const AppSetupPage = lazy(() => import('./pages/AppSetupPage'));

const STAFF: AppRole[] = ['admin', 'ops_manager', 'supervisor'];
const NAV: { to: string; label: string; roles: AppRole[] }[] = [
  { to: '/', label: 'Live MPs', roles: STAFF },
  { to: '/handovers', label: 'Handovers', roles: [...STAFF, 'mp'] },
  { to: '/areas', label: 'Area view', roles: STAFF },
  { to: '/alerts', label: 'Alerts', roles: [...STAFF, 'gate_operator'] },
  { to: '/gate', label: 'Gate', roles: [...STAFF, 'gate_operator'] },
  { to: '/reports', label: 'Reports', roles: STAFF },
  { to: '/admin', label: 'Admin', roles: ['admin'] },
  { to: '/me', label: 'My status', roles: ['mp'] },
  { to: '/face-enroll', label: 'Faces', roles: STAFF },
  { to: '/deploy', label: 'Deploy', roles: STAFF },
  { to: '/face-kiosk', label: 'DC IN/OUT', roles: ['gate_operator', 'admin'] },
  { to: '/kiosk', label: 'QR kiosk', roles: ['gate_operator', 'admin'] },
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
  if (appMode() === 'supervisor' && ['admin', 'ops_manager', 'supervisor'].includes(role)) return '/deploy';   // Android app
  return role === 'mp' ? '/me' : role === 'gate_operator' ? '/face-kiosk' : '/';
}

function Shell() {
  const { profile, loading, error } = useAuth();
  const loc = useLocation();
  const wait = <div className="center-screen"><Loading /></div>;
  // Android app: setup first; a gate tablet always shows the gate screen (no login)
  if (isNativeApp() && (loc.pathname === '/app-setup' || !appServer() || !appMode())) return <Suspense fallback={wait}><AppSetupPage /></Suspense>;
  if (isNativeApp() && appMode() === 'gate') return <Suspense fallback={wait}><DcGatePage /></Suspense>;
  // gate tablet: fixed link, no login
  if (loc.pathname === '/dc-gate') return <Suspense fallback={<div className="center-screen"><Loading /></div>}><DcGatePage /></Suspense>;
  if (loading) return <div className="center-screen"><Loading label="Signing in…" /></div>;
  if (!profile) return <LoginPage initialError={error} />;

  const allowed = (path: string) => NAV.find((n) => n.to === path)?.roles.includes(profile.role) ?? false;
  const guard = (path: string, el: JSX.Element) => (allowed(path) ? el : <Navigate to={home(profile.role)} replace />);
  const kiosk = ['/kiosk', '/face-kiosk', '/deploy'].includes(loc.pathname);

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
            <Route path="/me" element={guard('/me', <MyStatusPage />)} />
            <Route path="/kiosk" element={guard('/kiosk', <KioskPage />)} />
            <Route path="/face-kiosk" element={guard('/face-kiosk', <FaceKioskPage />)} />
            <Route path="/face-enroll" element={guard('/face-enroll', <FaceEnrollPage />)} />
            <Route path="/deploy" element={guard('/deploy', <DeployPage />)} />
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
  const alertsOn = can('admin', 'ops_manager', 'supervisor', 'gate_operator');
  const { alerts, muted, setMuted } = useOpenAlerts(alertsOn);
  const [navOpen, setNavOpen] = useState(false);
  const critical = alerts.filter((a) => a.severity === 'CRITICAL' && a.status === 'OPEN').length;
  return (
    <header className="topbar">
      <div className="brand"><span className="logo">MP</span><span>Control Tower</span></div>
      <button className="icon-btn nav-toggle" onClick={() => setNavOpen(!navOpen)} aria-label="Menu">☰</button>
      <nav className={navOpen ? 'open' : ''} onClick={() => setNavOpen(false)}>
        {NAV.filter((n) => profile && n.roles.includes(profile.role)).map((n) => (
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
      </form>
    </div>
  );
}
