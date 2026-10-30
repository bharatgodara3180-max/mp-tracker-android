/**
 * SFXBM first screen: nothing is pre-filled. The user enters a link and it opens.
 *  - MP Tracker link (gate link, server address :8010, /MP)  -> built-in MP screens (face camera works on plain http)
 *  - any other link (Asset Desk /ASSETS ...)                 -> opened as it is; Android Back returns here
 */
import { useState } from 'react';
import { alreadyOpenedThisRun, isLocalhostServer, isMpLink, normalizeLink, normalizeServer, openLinkNow, parseGateLink, saveAppSetup, saveOpenLink, savedLink } from '../lib/native';
import { Button, ErrorBox } from '../components/ui';

async function reachable(url: string, token?: string): Promise<{ ok: boolean; status?: number }> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8000);
    const res = await fetch(url, { headers: { 'ngrok-skip-browser-warning': '1', ...(token ? { 'X-MP-Token': token } : {}) }, signal: ctl.signal });
    clearTimeout(t);
    return { ok: res.ok, status: res.status };
  } catch { return { ok: false }; }
}

export default function AppSetupPage() {
  const [link, setLink] = useState(savedLink() ?? '');
  const [server, setServer] = useState('');
  const [needServer, setNeedServer] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cameBack = !!savedLink() && alreadyOpenedThisRun();

  const go = async () => {
    setError(null);
    const raw = link.trim();
    const gate = parseGateLink(raw);
    const url = gate ? null : normalizeLink(raw);
    if (!gate && !url) { setError('Enter a valid link.'); return; }

    // ---- MP Tracker gate tablet (no login) ----
    if (gate) {
      const s = normalizeServer(server || gate.server || '');
      if (!s || isLocalhostServer(s)) { setNeedServer(true); setError('This gate link points to localhost - also enter the server address below.'); return; }
      setBusy(true);
      const r = await reachable(`${s}api/face/config`, `kiosk:${gate.device}:${gate.key}`);
      setBusy(false);
      if (r.status === 401) { setError('This gate link is old or wrong. Copy a new one from Admin > Devices > Gate link.'); return; }
      if (!r.ok) { setError('Cannot reach the server. Is the device on the right network and the address correct?'); return; }
      try { localStorage.setItem('mp-gate-link', JSON.stringify({ d: gate.device, k: gate.key })); } catch { /* ignore */ }
      saveAppSetup(s, 'gate');
      window.location.hash = '#/dc-gate';
      window.location.reload();
      return;
    }

    // ---- MP Tracker login (supervisor / admin / gate operator) ----
    if (url && isMpLink(url)) {
      const s = normalizeServer(url);
      if (!s) { setError('Enter a valid link.'); return; }
      setBusy(true);
      const r = await reachable(`${s}api/health`);
      setBusy(false);
      if (!r.ok) { setError(r.status ? `The server answered ${r.status}. Check the link.` : 'Cannot reach the server. Is the device on the right network and the link correct?'); return; }
      saveAppSetup(s, 'supervisor');
      window.location.hash = '#/';
      window.location.reload();
      return;
    }

    // ---- any other link (Asset Desk etc.) ----
    setBusy(true);
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 8000);
      await fetch(url!, { mode: 'no-cors', signal: ctl.signal });
      clearTimeout(t);
    } catch { setBusy(false); setError('Cannot reach this link. Check the address and your network.'); return; }
    setBusy(false);
    saveOpenLink(url!);
    openLinkNow(url!);
  };

  return (
    <div className="kiosk">
      <div className="kiosk-card wide">
        <h2>SFXBM</h2>
        {cameBack && <p className="muted">Enter a different link to switch, or open the same one again.</p>}
        <label className="field">
          <span className="field-label">Link</span>
          <textarea rows={2} value={link} onChange={(e) => { setLink(e.target.value); setError(null); }}
            autoCapitalize="none" autoCorrect="off" spellCheck={false} inputMode="url" autoFocus
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void go(); } }} />
        </label>
        {needServer && (
          <label className="field">
            <span className="field-label">Server address</span>
            <input value={server} onChange={(e) => setServer(e.target.value)} autoCapitalize="none" inputMode="url" />
          </label>
        )}
        <Button variant="primary" busy={busy} disabled={!link.trim()} onClick={() => void go()}>Open</Button>
        <ErrorBox error={error} />
      </div>
    </div>
  );
}
