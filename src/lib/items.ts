export const ITEM_TYPES = ['SHIPMENT', 'BAG', 'MANIFEST', 'EQUIPMENT', 'DOCUMENT', 'TASK', 'OTHER'] as const;
export type ItemType = (typeof ITEM_TYPES)[number];
export interface ItemInput { item_type: ItemType; reference: string; quantity: number }

/**
 * Parse one item per line. Accepted forms:
 *   BAG, BAG-0091, 1      |  BAG BAG-0091     |  MNF-55120 (type defaults to the fallback)
 * Scanned barcodes pasted one per line therefore just work.
 */
export function parseItems(text: string, fallback: ItemType = 'SHIPMENT'): { items: ItemInput[]; errors: string[] } {
  const items: ItemInput[] = []; const errors: string[] = []; const seen = new Set<string>();
  text.split(/\r?\n/).forEach((line, i) => {
    const raw = line.trim();
    if (!raw) return;
    const parts = raw.split(/[,\t;]|\s+/).map((p) => p.trim()).filter(Boolean);
    let type: ItemType = fallback; let ref = ''; let qty = 1;
    if (parts.length && (ITEM_TYPES as readonly string[]).includes(parts[0].toUpperCase())) {
      type = parts.shift()!.toUpperCase() as ItemType;
    }
    ref = parts.shift() ?? '';
    if (parts.length) {
      const n = Number(parts[0]);
      if (!Number.isInteger(n) || n <= 0) { errors.push(`Line ${i + 1}: quantity "${parts[0]}" is not a positive whole number`); return; }
      qty = n;
    }
    if (!ref) { errors.push(`Line ${i + 1}: missing reference`); return; }
    const key = `${type}:${ref}`;
    if (seen.has(key)) { errors.push(`Line ${i + 1}: duplicate ${ref}`); return; }
    seen.add(key);
    items.push({ item_type: type, reference: ref, quantity: qty });
  });
  return { items, errors };
}
