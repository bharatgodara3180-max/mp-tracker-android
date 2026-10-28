/**
 * Employee bulk import from an Excel / CSV file: header matching, cleaning and checks.
 * Pure functions (no SheetJS here) so they can be unit-tested.
 */
export interface ImportRow { employee_code: string; full_name: string; designation: string; shift_code: string; badge_code: string }
export interface ImportIssue { line: number; message: string }

export const SAMPLE_HEADERS = ['employee_code', 'full_name', 'designation', 'shift', 'badge_code'] as const;
export const SAMPLE_ROWS = [
  ['EMP1001', 'Ramesh Kumar', 'Sorter', '09:00-18:00', 'EMP1001'],
  ['EMP1002', 'Sunita Devi', 'Loader', '14:00-23:00', ''],
  ['EMP1003', 'Arjun Singh', 'Picker', '21:30-06:30', ''],
];

const ALIASES: Record<keyof ImportRow, string[]> = {
  employee_code: ['employeecode', 'empcode', 'empid', 'employeeid', 'code', 'id', 'ecode'],
  full_name: ['fullname', 'name', 'employeename', 'empname', 'mpname'],
  designation: ['designation', 'role', 'process', 'work'],
  shift_code: ['shift', 'shiftcode', 'shifttiming', 'shifttime', 'timing'],
  badge_code: ['badgecode', 'badge', 'qr', 'qrcode', 'qrvalue', 'barcode', 'idcard'],
};

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Which file column feeds which field (first matching header wins). */
export function mapHeaders(headers: string[]): Partial<Record<keyof ImportRow, string>> {
  const out: Partial<Record<keyof ImportRow, string>> = {};
  for (const [field, names] of Object.entries(ALIASES) as [keyof ImportRow, string[]][]) {
    const h = headers.find((x) => names.includes(norm(String(x))));
    if (h !== undefined) out[field] = h;
  }
  return out;
}

const text = (v: unknown) => (v === null || v === undefined ? '' : String(v)).trim();

/** Excel may turn "09:00-18:00" into text but a lone time into a fraction of a day — handle both. */
function shiftText(v: unknown): string {
  if (typeof v === 'number' && v > 0 && v < 1) {
    const m = Math.round(v * 24 * 60);
    return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  }
  return text(v);
}

export function prepareRows(raw: Record<string, unknown>[], shiftCodes: string[] = []): { rows: ImportRow[]; issues: ImportIssue[]; missingColumns: string[] } {
  const headers = raw.length ? Object.keys(raw[0]) : [];
  const map = mapHeaders(headers);
  const missingColumns = (['employee_code', 'full_name'] as const).filter((f) => !map[f]);
  const rows: ImportRow[] = [];
  const issues: ImportIssue[] = [];
  if (missingColumns.length) return { rows, issues, missingColumns };
  const seen = new Map<string, number>();
  raw.forEach((r, i) => {
    const line = i + 2;   // row 1 is the header in Excel
    const get = (f: keyof ImportRow) => (map[f] ? r[map[f]!] : undefined);
    const row: ImportRow = {
      employee_code: text(get('employee_code')).toUpperCase(),
      full_name: text(get('full_name')),
      designation: text(get('designation')),
      shift_code: shiftText(get('shift_code')),
      badge_code: text(get('badge_code')),
    };
    if (!row.employee_code && !row.full_name && !row.designation && !row.shift_code) return;   // blank line
    if (!row.employee_code) { issues.push({ line, message: 'Employee code khaali hai' }); return; }
    if (!row.full_name) { issues.push({ line, message: `${row.employee_code}: naam khaali hai` }); return; }
    if (seen.has(row.employee_code)) { issues.push({ line, message: `${row.employee_code} file mein dobara hai (line ${seen.get(row.employee_code)} bhi)` }); return; }
    const known = new Set(shiftCodes.map((c) => c.toUpperCase()));
    if (row.shift_code && !/^\s*\d{1,2}[:.]\d{2}\s*(-|to|TO)\s*\d{1,2}[:.]\d{2}\s*$/.test(row.shift_code) && !known.has(row.shift_code.toUpperCase().replace(/\s/g, ''))) {
      issues.push({ line, message: `${row.employee_code}: shift "${row.shift_code}" samajh nahi aaya — 09:00-18:00 jaisa likhiye` }); return;
    }
    seen.set(row.employee_code, line);
    rows.push(row);
  });
  return { rows, issues, missingColumns };
}
