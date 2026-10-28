/**
 * Android app first-run setup: Gate tablet (DC IN/OUT, no login) or Supervisor (login -> Deploy).
 */
import { useState } from 'react';
import { appMode, appServer, isLocalhostServer, normalizeServer, parseGateLink, saveAppSetup, type AppMode } from '../lib/native';
import { Button, ErrorBox, Field } from '../components/ui';

async function check(url: string, token?: string): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: { 'ngrok-skip-browser-warning': '1', ...(token ? { 'X-MP-Token': token } : {}) } });
    if (res.status === 401) return 'Gate link purana / galat hai — Admin → Devices → Gate link se naya link lijiye.';
    if (!res.ok) return `Server ne ${res.status} diya — address check kariye.`;
    return null;
  } catch {
    return 'Server tak nahi pahunch paaye. Tablet/phone usi WiFi pe hai? Address sahi hai (jaise http://192.168.1.20:8010)?';
  }
}

export default function AppSetupPage() {
  const [mode, setMode] = useState<AppMode | null>(appMode());
  const [link, setLink] = useState('');
  const [server, setServer] = useState(appServer() ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onLink = (v: string) => {
    setLink(v);
    const p = parseGateLink(v);
    if (p?.server && !isLocalhostServer(p.server)) setServer(p.server);
  };

  const saveGate = async () => {
    setError(null);
    const p = parseGateLink(link);
    if (!p) { setError('Ye Gate link nahi lag raha. Admin → Devices → Gate link se poora link copy kariye.'); return; }
    const s = normalizeServer(server || p.server || '');
    if (!s || isLocalhostServer(s)) { setError('Server address daaliye (server PC ka IP, jaise http://192.168.1.20:8010).'); return; }
    setBusy(true);
    const err = await check(`${s}api/face/config`, `kiosk:${p.device}:${p.key}`);
    setBusy(false);
    if (err) { setError(err); return; }
    try { localStorage.setItem('mp-gate-link', JSON.stringify({ d: p.device, k: p.key })); } catch { /* ignore */ }
    saveAppSetup(s, 'gate');
    window.location.hash = '#/dc-gate';
    window.location.reload();
  };

  const saveSupervisor = async () => {
    setError(null);
    const s = normalizeServer(server);
    if (!s || isLocalhostServer(s)) { setError('Server address daaliye (jaise http://192.168.1.20:8010).'); return; }
    setBusy(true);
    const err = await check(`${s}api/health`);
    setBusy(false);
    if (err) { setError(err); return; }
    saveAppSetup(s, 'supervisor');
    window.location.hash = '#/';            // after login the role decides the screen
    window.location.reload();
  };

  return (
    <div className="kiosk">
      <div className="kiosk-card wide">
        <h2>MP Tracker — app setup</h2>
        <p className="muted">Ye device kis kaam ke liye hai?</p>
        <div className="kiosk-modes two">
          <button className={`kiosk-mode ${mode === 'gate' ? 'active' : ''}`} onClick={() => setMode('gate')}>Gate tablet<br /><span className="small">DC IN / OUT</span></button>
          <button className={`kiosk-mode ${mode === 'supervisor' ? 'active' : ''}`} onClick={() => setMode('supervisor')}>Login<br /><span className="small">Supervisor / Admin / Gate operator</span></button>
        </div>
        {mode === 'gate' && <>
          <Field label="Gate link" hint="Admin → Devices → GATE-FACE-TAB-01 → Gate link → Copy, aur yahan paste kariye">
            <textarea rows={3} value={link} onChange={(e) => onLink(e.target.value)} placeholder="https://…/#/dc-gate?d=GATE-FACE-TAB-01&k=…" />
          </Field>
          <Field label="Server address" hint="Server PC ka address. Link 'localhost' wala ho to yahan PC ka IP likhiye.">
            <input value={server} onChange={(e) => setServer(e.target.value)} placeholder="http://192.168.1.20:8010" inputMode="url" autoCapitalize="none" />
          </Field>
          <Button variant="primary" busy={busy} onClick={() => void saveGate()}>Save & start gate</Button>
        </>}
        {mode === 'supervisor' && <>
          <Field label="Server address" hint="DC WiFi pe: http://<server PC ka IP>:8010 · bahar se: https://…ngrok-free.dev">
            <input value={server} onChange={(e) => setServer(e.target.value)} placeholder="http://192.168.1.20:8010" inputMode="url" autoCapitalize="none" />
          </Field>
          <Button variant="primary" busy={busy} onClick={() => void saveSupervisor()}>Save & login</Button>
        </>}
        <ErrorBox error={error} />
      </div>
    </div>
  );
}
