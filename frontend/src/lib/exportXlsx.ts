import * as XLSX from 'xlsx';

export type ExportRow = Record<string, string | number | boolean | Date | null | undefined>;
export type ColumnFormat = 'currency' | 'percent' | 'signedPercent' | 'integer' | 'decimal';
export interface ExportSheet {
  name: string;
  rows: ExportRow[];
  // Real Excel number formats (not pre-formatted strings), so the file stays sortable/summable.
  // 'percent' expects fractions (0.25 → 25%).
  formats?: Record<string, ColumnFormat>;
}

const FORMAT_CODES: Record<ColumnFormat, string> = {
  currency: '$#,##0.00',
  percent: '0.0%',
  signedPercent: '+0.0%;-0.0%;0.0%',
  integer: '#,##0',
  decimal: '#,##0.00',
};

// Excel rejects sheet names over 31 chars or containing any of : \ / ? * [ ]
function safeSheetName(name: string, used: Set<string>): string {
  const base = name.replace(/[:\\/?*[\]]/g, ' ').trim().slice(0, 31) || 'Sheet';
  let candidate = base;
  for (let i = 2; used.has(candidate.toLowerCase()); i++) {
    const suffix = ` (${i})`;
    candidate = base.slice(0, 31 - suffix.length) + suffix;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

export function exportXlsx(filename: string, sheets: ExportSheet[]): void {
  const wb = XLSX.utils.book_new();
  const used = new Set<string>();
  for (const { name, rows, formats } of sheets) {
    const sheet = XLSX.utils.json_to_sheet(rows.length ? rows : [{ '': 'No rows' }], { cellDates: true });
    const headers = rows.length ? Object.keys(rows[0]) : [''];
    sheet['!cols'] = headers.map((h) => ({
      wch: Math.min(60, Math.max(h.length, ...rows.slice(0, 500).map((r) => String(r[h] ?? '').length)) + 2),
    }));
    if (formats && rows.length) {
      headers.forEach((h, c) => {
        const fmt = formats[h];
        if (!fmt) return;
        for (let r = 1; r <= rows.length; r++) {
          const cell = sheet[XLSX.utils.encode_cell({ r, c })];
          if (cell && typeof cell.v === 'number') cell.z = FORMAT_CODES[fmt];
        }
      });
    }
    if (rows.length && sheet['!ref']) sheet['!autofilter'] = { ref: sheet['!ref'] };
    XLSX.utils.book_append_sheet(wb, sheet, safeSheetName(name, used));
  }
  // Period-scoped exports already carry their date range in the name; only undated ones get today's date.
  const dated = /\d{4}-\d{2}-\d{2}/.test(filename) ? filename : `${filename}-${new Date().toISOString().slice(0, 10)}`;
  XLSX.writeFile(wb, `${dated}.xlsx`);
}

// For endpoints that cap `limit` server-side: page through with `offset` until a short page
// comes back. Stops at maxRows and reports it so callers can warn instead of silently
// handing the user a partial file.
export async function fetchAllPages<T>(
  fetchPage: (offset: number, limit: number) => Promise<{ items: T[] }>,
  pageSize = 200,
  maxRows = 20000,
): Promise<{ items: T[]; truncated: boolean }> {
  const items: T[] = [];
  for (let offset = 0; offset < maxRows; offset += pageSize) {
    const page = await fetchPage(offset, pageSize);
    items.push(...page.items);
    if (page.items.length < pageSize) return { items, truncated: false };
  }
  return { items, truncated: true };
}

export function warnIfTruncated(truncated: boolean, count: number) {
  if (truncated) window.alert(`Export stopped at ${count.toLocaleString()} rows. Narrow the filters to export the rest.`);
}
