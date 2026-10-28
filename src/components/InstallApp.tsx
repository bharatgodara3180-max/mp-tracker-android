import { useEffect, useState } from 'react';
import { canInstall, installApp, isInstalledApp, onInstallChange } from '../lib/pwa';

/** "App install karein" button; shows only when the browser offers installation. */
export function InstallAppButton({ label = 'App install karein', className = 'btn btn-sm' }: { label?: string; className?: string }) {
  const [can, setCan] = useState(canInstall());
  useEffect(() => onInstallChange(() => setCan(canInstall())), []);
  if (!can || isInstalledApp()) return null;
  return <button className={className} onClick={(e) => { e.stopPropagation(); void installApp(); }}>{label}</button>;
}
