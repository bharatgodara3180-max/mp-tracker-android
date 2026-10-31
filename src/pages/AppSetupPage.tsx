/**
 * SFXBM first screen. First time: empty box, the user enters a link and it opens.
 * After that the last link that worked is saved and opens by itself on every app start;
 * Android Back (or "App setup") returns here with that link in the box so it can be changed.
 *  - MP Tracker link (gate link, server address :8010, /MP)  -> built-in MP screens (face camera works on plain http)
 *  - any other link (Asset Desk /ASSETS ...)                 -> opened as it is; Android Back returns here
 */
import { useEffect, useRef, useState } from 'react';
import { isLocalhostServer, isMpLink, BOOT_AUTO, lastLink, markLinkChosen, normalizeLink, normalizeServer, openLinkNow, parseGateLink, saveAppSetup, saveLastLink } from '../lib/native';
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
  const [link, setLink] = useState(lastLink());
  const [server, setServer] = useState('');
  const [needServer, setNeedServer] = useState(false);
  const [busy, setBusy] = useState(false);
  const sw = window as unknown as { __sfxbmBusy?: boolean; __sfxbmFailed?: boolean };
  const [opening, setOpening] = useState(BOOT_AUTO || !!sw.__sfxbmBusy);   // cold start: show only a splash while the saved link opens
  const [error, setError] = useState<string | null>(null);

  const go = async (override?: string) => {
    setError(null);
    const raw = (override ?? link).trim();
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
      saveLastLink(raw);
      saveAppSetup(s, 'gate');
      markLinkChosen();
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
      if (!r.ok && !r.status) {
        // the app could not call the API from here (browser security rules on a proxied /MP link) - if the server itself
        // answers, open the link as a normal page instead, exactly like /ASSETS
        try {
          const ctl = new AbortController();
          const t = setTimeout(() => ctl.abort(), 8000);
          await fetch(url, { mode: 'no-cors', signal: ctl.signal });
          clearTimeout(t);
          setBusy(false); saveLastLink(raw); saveAppSetup(null, null); openLinkNow(url); return;
        } catch { /* really unreachable */ }
      }
      setBusy(false);
      if (!r.ok) { setError(r.status ? `The server answered ${r.status}. Check the link.` : 'Cannot reach the server. Is the device on the right network and the link correct?'); return; }
      saveLastLink(raw);
      saveAppSetup(s, 'supervisor');
      markLinkChosen();
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
    saveLastLink(raw);
    saveAppSetup(null, null);
    openLinkNow(url!);
  };

  // cold start: open the saved link by itself (once per app run)
  const auto = useRef(false);
  useEffect(() => {
    if (auto.current) return;
    auto.current = true;
    if (BOOT_AUTO) void go(lastLink()).finally(() => setOpening(false));
    else if (sw.__sfxbmBusy) {                 // the start-up check in index.html is still reaching the server
      const t = setInterval(() => {
        if (sw.__sfxbmBusy) return;
        clearInterval(t); setOpening(false);
        if (sw.__sfxbmFailed) setError('Cannot reach the server. Check your network, or tap Open to retry / change the link.');
      }, 100);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (opening) return <div className="kiosk"><div className="kiosk-card"><h2>SFXBM</h2><p style={{ opacity: 0.7 }}>Opening...</p></div></div>;

  return (
    <div className="kiosk">
      <div className="kiosk-card wide">
        <h2>SFXBM</h2>
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
