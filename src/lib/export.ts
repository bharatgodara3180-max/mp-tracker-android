export interface ExportColumn<T> {
  header: string;
  value: (row: T) => string | number | boolean | null | undefined;
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  // Neutralise spreadsheet formula injection from user-entered text.
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv<T>(rows: T[], cols: ExportColumn<T>[]): string {
  const head = cols.map((c) => csvCell(c.header)).join(',');
  const body = rows.map((r) => cols.map((c) => csvCell(c.value(r))).join(','));
  return '﻿' + [head, ...body].join('\r\n');
}

function download(blob: Blob, fileName: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export function downloadCsv<T>(rows: T[], cols: ExportColumn<T>[], baseName: string) {
  download(new Blob([toCsv(rows, cols)], { type: 'text/csv;charset=utf-8' }), `${baseName}.csv`);
}

export async function downloadXlsx<T>(rows: T[], cols: ExportColumn<T>[], baseName: string) {
  const { default: writeExcelFile } = await import('write-excel-file/browser');
  const data = [
    cols.map((c) => ({ value: c.header, fontWeight: 'bold' as const })),
    ...rows.map((r) => cols.map((c) => {
      const v = c.value(r);
      return v === undefined ? null : v;
    })),
  ];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const blob = await writeExcelFile(data as any).toBlob();
  download(blob, `${baseName}.xlsx`);
}

/** Build export columns automatically from object keys (for report tables). */
export function autoColumns<T extends Record<string, unknown>>(rows: T[]): ExportColumn<T>[] {
  const keys = rows.length ? Object.keys(rows[0]) : [];
  return keys.map((k) => ({ header: k, value: (r: T) => {
    const v = r[k];
    return v !== null && typeof v === 'object' ? JSON.stringify(v) : (v as string | number | boolean | null);
  } }));
}
