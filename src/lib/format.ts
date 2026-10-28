import type { MpStatus, HandoverStatus, MpLive } from './types';

export const SITE_TZ = 'Asia/Kolkata';

export type Tone = 'green' | 'amber' | 'blue' | 'violet' | 'orange' | 'red' | 'gray' | 'teal';

export const STATUS_META: Record<MpStatus, { label: string; short: string; tone: Tone }> = {
  NOT_CHECKED_IN:       { label: 'Not checked in',            short: 'Not in',      tone: 'gray' },
  INSIDE_UNASSIGNED:    { label: 'Inside · Unassigned',       short: 'Unassigned',  tone: 'amber' },
  WORKING:              { label: 'Working',                   short: 'Working',     tone: 'green' },
  ON_BREAK:             { label: 'On break (inside)',         short: 'Break',       tone: 'violet' },
  OUTSIDE_PICKUP:       { label: 'Outside · On pickup',       short: 'Pickup',      tone: 'blue' },
  OUTSIDE_OFFICIAL:     { label: 'Outside · Official work',   short: 'Official',    tone: 'blue' },
  OUTSIDE_BREAK:        { label: 'Outside · Lunch/break',     short: 'Break out',   tone: 'violet' },
  OUTSIDE_OTHER:        { label: 'Outside · Other',           short: 'Out other',   tone: 'teal' },
  OUTSIDE_UNDECLARED:   { label: 'Outside · Undeclared',      short: 'Undeclared',  tone: 'red' },
  HANDOVER_PENDING:     { label: 'Handover pending',          short: 'HO pending',  tone: 'orange' },
  HANDOVER_IN_PROGRESS: { label: 'Handover in progress',      short: 'HO active',   tone: 'orange' },
  HANDOVER_DISPUTED:    { label: 'Handover disputed',         short: 'HO dispute',  tone: 'red' },
  SHIFT_ENDED:          { label: 'Shift ended',               short: 'Ended',       tone: 'gray' },
};

export function statusLabel(row: Pick<MpLive, 'status' | 'handover_type'> & Partial<Pick<MpLive, 'out_state' | 'out_area_name'>>): string {
  if (row.out_state === 'ASSIGNED' && row.status !== 'WORKING') return `Assigned for ${row.out_area_name ?? 'OUT'}`;
  if (row.out_state === 'OUT') return `On ${row.out_area_name ?? 'OUT'}`;
  if (row.status === 'HANDOVER_PENDING' && row.handover_type === 'PICKUP_RETURN') return 'Returned · Handover pending';
  return STATUS_META[row.status]?.label ?? row.status;
}

export const HANDOVER_META: Record<HandoverStatus, { label: string; tone: Tone }> = {
  PENDING: { label: 'Pending', tone: 'orange' },
  IN_PROGRESS: { label: 'In progress', tone: 'amber' },
  COMPLETED: { label: 'Completed', tone: 'green' },
  DISPUTED: { label: 'Disputed', tone: 'red' },
  REJECTED: { label: 'Rejected', tone: 'red' },
  CANCELLED: { label: 'Cancelled', tone: 'gray' },
};

export const INSIDE_STATUSES: MpStatus[] = ['INSIDE_UNASSIGNED', 'WORKING', 'ON_BREAK', 'HANDOVER_PENDING',
  'HANDOVER_IN_PROGRESS', 'HANDOVER_DISPUTED'];

/** "2h 05m", "12m 30s", "45s" */
export function fmtDuration(totalSeconds: number | null | undefined): string {
  if (totalSeconds === null || totalSeconds === undefined || !Number.isFinite(totalSeconds)) return '—';
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

export function secondsSince(iso: string | null | undefined, now: number = Date.now()): number | null {
  if (!iso) return null;
  return (now - new Date(iso).getTime()) / 1000;
}

/** Positive seconds an MP is past their expected time, else 0. */
export function delaySeconds(expectedIso: string | null | undefined, now: number = Date.now()): number {
  if (!expectedIso) return 0;
  return Math.max(0, (now - new Date(expectedIso).getTime()) / 1000);
}

const timeFmt = new Intl.DateTimeFormat('en-IN', { timeZone: SITE_TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const dateTimeFmt = new Intl.DateTimeFormat('en-IN', {
  timeZone: SITE_TZ, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });

export function fmtTime(iso: string | null | undefined): string {
  return iso ? timeFmt.format(new Date(iso)) : '—';
}
export function fmtDateTime(iso: string | null | undefined): string {
  return iso ? dateTimeFmt.format(new Date(iso)) : '—';
}

/** Today's date in the site timezone as yyyy-mm-dd. */
export function siteToday(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: SITE_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  return parts;
}

export function humanizeKey(k: string): string {
  return k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
