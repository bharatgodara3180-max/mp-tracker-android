/**
 * Gate tablet without a login: opened from the fixed link made in Admin → Devices → Gate link
 * (#/dc-gate?d=<device>&k=<key>). The link is remembered on the tablet, so a plain reload works too.
 */
import { useLocation } from 'react-router-dom';
import { setKioskToken } from '../lib/api';
import FaceKioskPage from './FaceKioskPage';

const CRED_KEY = 'mp-gate-link';

export default function DcGatePage() {
  const loc = useLocation();
  const q = new URLSearchParams(loc.search);
  let cred: { d: string; k: string } | null = null;
  if (q.get('d') && q.get('k')) {
    cred = { d: q.get('d')!.toUpperCase(), k: q.get('k')! };
    try { localStorage.setItem(CRED_KEY, JSON.stringify(cred)); } catch { /* ignore */ }
  } else {
    try { cred = JSON.parse(localStorage.getItem(CRED_KEY) ?? 'null'); } catch { cred = null; }
  }
  if (!cred) return (
    <div className="kiosk"><div className="kiosk-card">
      <h2>Gate link adhoora hai</h2>
      <p className="muted">Admin → Devices → <b>Gate link</b> se poora link copy karke is tablet pe kholiye.</p>
    </div></div>
  );
  setKioskToken(`kiosk:${cred.d}:${cred.k}`);
  return <FaceKioskPage fixedDevice={cred.d} />;
}
