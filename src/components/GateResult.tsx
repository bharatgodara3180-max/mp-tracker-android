/**
 * Gate screen result: big icon + very short text + employee name (large).
 * Used only by the gate kiosk; the supervisor kiosk keeps FullResult.
 * The icon is picked from the server's result label / sub-line.
 */
import type { ReactNode } from 'react';
import type { KioskResult } from './FaceKiosk';

const COLOR = { green: '#16a34a', blue: '#2563eb', red: '#dc2626', amber: '#d97706' } as const;
const P = (d: string, c: string, w = 7) => <path key={d} d={d} fill="none" stroke={c} strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" />;
const door = (c: string) => P('M62 30H34a6 6 0 0 0-6 6v68a6 6 0 0 0 6 6h28', c);
const arrIn = (c: string) => P('M58 70H108M90 52l18 18-18 18', c);
const arrOut = (c: string) => P('M108 70H58M76 52L58 70l18 18', c);
const badge = (c: string, d: string) => (
  <g key="badge"><circle cx="118" cy="112" r="22" fill={c} />
    <g transform="translate(104,98) scale(.55)"><path d={d} fill="none" stroke="#fff" strokeWidth="9" strokeLinecap="round" strokeLinejoin="round" /></g></g>
);
const CHK = 'M6 28l14 14 28-30', CHK2 = 'M2 28l10 10 18-22M22 38l4 4 22-28', X = 'M10 10l32 32M42 10L10 42';
const CLK = 'M26 14v13l9 6M26 4a22 22 0 1 0 .01 0', EX = 'M26 6v26M26 44v1';

function icon(L: string, S: string, tone: string, repeat?: boolean): ReactNode[] {
  const c = COLOR[tone as keyof typeof COLOR] ?? COLOR.green;
  if (L.startsWith('DC IN LATE')) return [door(c), arrIn(c), badge(c, CLK)];
  if (L === 'DC IN') return [door(c), arrIn(c), badge(c, repeat ? CHK2 : CHK)];
  if (L.startsWith('DC OUT REJECTED')) return [door(c), arrOut(c), P('M72 92h22a4 4 0 0 1 4 4v28a4 4 0 0 1-4 4H72a4 4 0 0 1-4-4V96a4 4 0 0 1 4-4zM81 120h4', c, 5), badge(c, X)];
  if (L === 'DC OUT') {
    const g = S.includes('PICKUP') ? P('M70 98h30v22H70zM100 106h12l8 8v6h-20', c, 5)
      : S.includes('OFFICIAL') ? P('M70 102h40v26H70zM82 102v-6h16v6M70 114h40', c, 5)
      : S.includes('LUNCH') ? P('M80 92v14a5 5 0 0 0 10 0V92M85 92v34M104 126V92c-8 4-10 14-10 22h10', c, 5) : badge(c, CHK);
    return [door(c), arrOut(c), g];
  }
  if (L.startsWith('USE ')) return [door(c), arrIn(c), P('M75 13a62 62 0 1 0 .01 0M31 119L119 31', c, 8)];
  if (L.startsWith('PEHCHAAN')) return [P('M75 30c-17 0-30 16-30 38s13 38 30 38 30-16 30-38-13-38-30-38zM20 140c4-26 24-34 55-34s51 8 55 34', c), badge(c, 'M16 16a10 10 0 1 1 14 9c-4 3-4 5-4 9M26 44v1')];
  if (L === 'SAVED') return [P('M30 56h70M82 38l18 18-18 18M120 96H50M68 78L50 96l18 18', c), badge(c, EX)];
  if (L === 'ERROR') return [P('M75 22L136 128H14z', c), P('M75 62v32M75 108v1', c, 8)];
  if (tone === 'red') return [P('M75 13a62 62 0 1 0 .01 0', c), P('M52 52l46 46M98 52L52 98', c, 8)];
  if (tone === 'amber') return [P('M75 13a62 62 0 1 0 .01 0', c), P('M75 40v42M75 104v1', c, 8)];
  return [P('M75 13a62 62 0 1 0 .01 0', c), P('M44 78l22 22 40-48', c, 9)];
}

/** Minimum words under the icon, for anyone who does not know the icon. */
function tag(L: string, S: string, repeat?: boolean): string {
  const x = S.toLowerCase();
  let t: string;
  if (L.startsWith('DC IN LATE')) t = 'IN · LATE';
  else if (L === 'DC IN') t = 'IN';
  else if (L.startsWith('DC OUT REJECTED')) t = 'OUT NAHI · ' + (x.includes('device') ? 'device wapas karo' : x.includes('assign') ? 'OUT assign nahi hai' : 'supervisor se milo');
  else if (L === 'DC OUT') t = 'OUT' + (S.includes('PICKUP') ? ' · PICKUP' : S.includes('OFFICIAL') ? ' · OFFICIAL' : S.includes('LUNCH') ? ' · LUNCH' : S.includes('SHIFT END') ? ' · SHIFT END' : '');
  else if (L === 'USE OUT GATE') t = 'OUT gate pe jao';
  else if (L === 'USE IN GATE') t = 'IN gate pe jao';
  else if (L.startsWith('PEHCHAAN')) t = 'Pehchaan nahi hui';
  else if (L === 'SAVED') t = 'Saved · sync baaki';
  else if (L === 'ERROR') t = 'Error · dobara scan karo';
  else t = L.charAt(0) + L.slice(1).toLowerCase();
  return repeat ? t + ' · pehle ho chuka' : t;
}

export default function GateResult({ result, name, photo, repeat }: {
  result: KioskResult; name?: string | null; code?: string | null; photo?: string | null; note?: string | null; repeat?: boolean;
}) {
  const L = String(result.label || '').toUpperCase();
  const S = String(result.sub || '').toUpperCase();
  const sz = 'min(42vmin, 400px)';
  return (
    <div className={`full-result tone-${result.tone}`} aria-live="assertive" style={{ gap: '3vmin' }}>
      <div style={{ background: '#fff', borderRadius: '8vmin', padding: '4vmin', lineHeight: 0, boxShadow: '0 1vmin 4vmin rgba(0,0,0,.35)' }}>
        <svg viewBox="0 0 150 150" style={{ width: sz, height: sz }}>{icon(L, S, result.tone, repeat)}</svg>
      </div>
      <div style={{ fontWeight: 800, fontSize: '6.5vmin', textAlign: 'center', lineHeight: 1.15, padding: '0 4vmin' }}>{tag(L, S, repeat)}</div>
      {(name || photo) && <div style={{ display: 'flex', alignItems: 'center', gap: '3vmin', justifyContent: 'center', maxWidth: '94vw' }}>
        {photo && <img src={photo} alt="" style={{ width: '16vmin', height: '16vmin', borderRadius: '50%', objectFit: 'cover', border: '1vmin solid #fff', flex: 'none' }} />}
        {name && <div style={{ fontWeight: 900, fontSize: '9vmin', lineHeight: 1.1, textAlign: 'center', wordBreak: 'break-word' }}>{name}</div>}
      </div>}
    </div>
  );
}
