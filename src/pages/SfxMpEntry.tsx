/**
 * Entry used by the SFXBM login page (/ASSETS/go) inside the Android app: an MP Tracker login opens the built-in MP screens
 * (supervisor / gate operator face kiosk) so the camera works. #/sfx-mp?s=<MP server>&t=<token>&h=<screen, e.g. #/face-kiosk>
 */
import { useEffect } from 'react';
import { markLinkChosen, normalizeServer, saveAppSetup } from '../lib/native';
import { token } from '../lib/api';

export default function SfxMpEntry() {
  useEffect(() => {
    const h = window.location.hash; const qi = h.indexOf('?');
    const p = new URLSearchParams(qi >= 0 ? h.slice(qi + 1) : '');
    const s = normalizeServer(p.get('s') ?? ''); const t = p.get('t');
    if (!s || !t) { window.location.hash = '#/app-setup'; return; }
    saveAppSetup(s, 'supervisor');
    token.set(t);
    markLinkChosen();
    window.location.hash = p.get('h') || '#/';
    window.location.reload();
  }, []);
  return <div className="kiosk"><div className="kiosk-card"><h2>SFXBM</h2><p style={{ opacity: 0.7 }}>Opening...</p></div></div>;
}
