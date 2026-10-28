/**
 * Durable offline queue for the gate kiosk. Each scan gets a stable client event id
 * at capture time, so re-sending after a network failure can never create duplicates
 * (the server de-duplicates on device + event id).
 */
export interface QueuedScan {
  clientEventId: string;
  scanValue: string;
  direction: 'IN' | 'OUT' | null;
  purpose: string | null;
  capturedAt: string;
  attempts: number;
  lastError?: string;
}

export interface StorageLike {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

export type SendResult = { ok: true; result: unknown } | { ok: false; retryable: boolean; error: string };

/** crypto.randomUUID only exists on HTTPS pages; the LAN kiosk may be plain http. */
export function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(b); else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export class OfflineQueue {
  constructor(private storage: StorageLike, private key = 'mp-kiosk-queue') {}

  all(): QueuedScan[] {
    try { return JSON.parse(this.storage.getItem(this.key) ?? '[]'); } catch { return []; }
  }

  private save(items: QueuedScan[]) { this.storage.setItem(this.key, JSON.stringify(items)); }

  enqueue(s: Omit<QueuedScan, 'attempts' | 'clientEventId' | 'capturedAt'> & Partial<Pick<QueuedScan, 'clientEventId' | 'capturedAt'>>) {
    const item: QueuedScan = {
      clientEventId: s.clientEventId ?? uuid(),
      capturedAt: s.capturedAt ?? new Date().toISOString(),
      attempts: 0, scanValue: s.scanValue, direction: s.direction, purpose: s.purpose,
    };
    this.save([...this.all(), item]);
    return item;
  }

  size() { return this.all().length; }

  /**
   * Send queued scans oldest-first. Stops at the first retryable (network) failure to
   * preserve ordering; drops items the server definitively answered (incl. rejected).
   */
  async flush(send: (s: QueuedScan) => Promise<SendResult>): Promise<{ sent: number; dropped: number; remaining: number; results: unknown[] }> {
    let sent = 0; let dropped = 0; const results: unknown[] = [];
    const items = [...this.all()].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
    while (items.length) {
      const head = items[0];
      const r = await send(head);
      if (r.ok) { sent++; results.push(r.result); items.shift(); this.save(items); continue; }
      if (r.retryable) {
        head.attempts += 1; head.lastError = r.error; this.save(items);
        break;
      }
      dropped++; results.push({ error: r.error, scan: head }); items.shift(); this.save(items);
    }
    return { sent, dropped, remaining: items.length, results };
  }
}

export function isNetworkError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /fetch|network|Failed to fetch|NetworkError|timeout|ECONN|offline/i.test(msg)
    || (typeof navigator !== 'undefined' && navigator.onLine === false);
}
