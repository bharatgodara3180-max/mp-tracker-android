import { describe, it, expect } from 'vitest';
import { fmtDuration, delaySeconds, statusLabel } from './format';
import { parseItems } from './items';
import { toCsv } from './export';
import { OfflineQueue, type StorageLike } from './offlineQueue';

const mem = (): StorageLike => { const m = new Map<string, string>(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) }; };

describe('format', () => {
  it('formats durations', () => {
    expect(fmtDuration(45)).toBe('45s');
    expect(fmtDuration(750)).toBe('12m 30s');
    expect(fmtDuration(7500)).toBe('2h 05m');
    expect(fmtDuration(null)).toBe('—');
  });
  it('computes delay only after the expected time', () => {
    const now = Date.parse('2026-10-27T10:00:00Z');
    expect(delaySeconds('2026-10-27T09:50:00Z', now)).toBe(600);
    expect(delaySeconds('2026-10-27T10:10:00Z', now)).toBe(0);
    expect(delaySeconds(null, now)).toBe(0);
  });
  it('labels a pickup-return handover distinctly', () => {
    expect(statusLabel({ status: 'HANDOVER_PENDING', handover_type: 'PICKUP_RETURN' })).toBe('Returned · Handover pending');
    expect(statusLabel({ status: 'HANDOVER_PENDING', handover_type: 'DOCK' })).toBe('Handover pending');
  });
});

describe('handover item parsing', () => {
  it('accepts typed lines and bare scanned references', () => {
    const r = parseItems('BAG, BAG-0091, 2\nMNF-55120\nequipment HHT-3', 'SHIPMENT');
    expect(r.errors).toEqual([]);
    expect(r.items).toEqual([
      { item_type: 'BAG', reference: 'BAG-0091', quantity: 2 },
      { item_type: 'SHIPMENT', reference: 'MNF-55120', quantity: 1 },
      { item_type: 'EQUIPMENT', reference: 'HHT-3', quantity: 1 },
    ]);
  });
  it('flags duplicates and bad quantities', () => {
    const r = parseItems('B-1\nB-1\nBAG B-2 zero');
    expect(r.items).toHaveLength(1);
    expect(r.errors).toHaveLength(2);
  });
});

describe('CSV export', () => {
  it('quotes, escapes and blocks formula injection', () => {
    const csv = toCsv([{ a: 'x,"y"', b: '=HYPERLINK("bad")', c: -5 }], [
      { header: 'A', value: (r) => r.a }, { header: 'B', value: (r) => r.b }, { header: 'C', value: (r) => r.c }]);
    expect(csv).toBe('﻿A,B,C\r\n"x,""y""","\'=HYPERLINK(""bad"")",-5');
  });
});

describe('kiosk offline queue', () => {
  it('keeps scans while offline, then syncs in capture order exactly once', async () => {
    const q = new OfflineQueue(mem());
    q.enqueue({ scanValue: 'B', direction: null, purpose: null, capturedAt: '2026-10-27T06:02:00Z', clientEventId: 'e2' });
    q.enqueue({ scanValue: 'A', direction: null, purpose: null, capturedAt: '2026-10-27T06:01:00Z', clientEventId: 'e1' });

    const offline = await q.flush(async () => ({ ok: false, retryable: true, error: 'Failed to fetch' }));
    expect(offline).toMatchObject({ sent: 0, remaining: 2 });
    expect(q.all().find((s) => s.clientEventId === 'e1')?.attempts).toBe(1);

    const sentIds: string[] = [];
    const online = await q.flush(async (s) => { sentIds.push(s.clientEventId); return { ok: true, result: s.clientEventId }; });
    expect(online).toMatchObject({ sent: 2, remaining: 0 });
    expect(sentIds).toEqual(['e1', 'e2']);
    expect(q.size()).toBe(0);
  });
  it('drops definitively rejected scans but stops at network failures', async () => {
    const q = new OfflineQueue(mem());
    ['1', '2', '3'].forEach((i) => q.enqueue({ scanValue: i, direction: 'IN', purpose: null, capturedAt: `2026-10-27T06:0${i}:00Z` }));
    let n = 0;
    const r = await q.flush(async () => (++n === 1 ? { ok: false, retryable: false, error: 'Unknown badge' } : n === 2 ? { ok: true, result: 1 } : { ok: false, retryable: true, error: 'offline' }));
    expect(r).toMatchObject({ sent: 1, dropped: 1, remaining: 1 });
  });
});
