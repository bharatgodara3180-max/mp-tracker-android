/** Installable app (PWA): service worker registration + the browser's install prompt. */
import { isNativeApp } from './native';

type InstallEvent = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: string }> };
let deferred: InstallEvent | null = null;
const listeners = new Set<() => void>();

export function initPwa() {
  if (isNativeApp()) return;                         // the Android app already has everything on the device
  if ('serviceWorker' in navigator && window.isSecureContext) {
    window.addEventListener('load', () => { void navigator.serviceWorker.register('sw.js').catch(() => {}); });
  }
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e as InstallEvent; listeners.forEach((l) => l()); });
  window.addEventListener('appinstalled', () => { deferred = null; listeners.forEach((l) => l()); });
}

export const canInstall = () => deferred !== null;
export const onInstallChange = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const isInstalledApp = () => window.matchMedia?.('(display-mode: standalone), (display-mode: fullscreen)').matches;

export async function installApp(): Promise<boolean> {
  if (!deferred) return false;
  await deferred.prompt();
  const r = await deferred.userChoice;
  deferred = null; listeners.forEach((l) => l());
  return r.outcome === 'accepted';
}
