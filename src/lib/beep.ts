// success = rising two-tone chime, warning = double beep, error = long low buzz (+ vibrate where the phone allows)
let ctx: AudioContext | null = null;
function audio(): AudioContext | null {
  try {
    const C = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    ctx = ctx ?? new C();
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
    return ctx;
  } catch { return null; }
}
function tone(freq: number, ms: number, type: OscillatorType, vol: number, delay = 0) {
  const c = audio(); if (!c) return;
  try {
    const t0 = c.currentTime + delay / 1000;
    const o = c.createOscillator(); const g = c.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(vol, t0 + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t0 + ms / 1000);
    o.connect(g); g.connect(c.destination); o.start(t0); o.stop(t0 + ms / 1000 + 0.02);
  } catch { /* no audio */ }
}
const vib = (p: number | number[]) => { try { navigator.vibrate?.(p); } catch { /* ignore */ } };
export const beepOk = () => { tone(880, 120, 'sine', 0.5); tone(1320, 180, 'sine', 0.5, 120); vib(60); };
export const beepWarn = () => { tone(900, 130, 'triangle', 0.5); tone(900, 130, 'triangle', 0.5, 190); vib([60, 60, 60]); };
export const beepErr = () => { tone(180, 280, 'sawtooth', 0.45); tone(150, 520, 'sawtooth', 0.45, 300); vib(400); };
