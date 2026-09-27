import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { api } from '@/api';

export type PickedCompany = { id: string; company_name: string };

/** Company search box backed by the company master (`/companies?status=official`, i.e.
 *  non-provisional). The endpoint is AE-scoped server-side, so an ae only ever gets
 *  suggestions for their own customers. 350ms debounce, 2-char minimum. */
export function CompanyPicker({ value, onChange, autoFocus }: { value: PickedCompany | null; onChange: (c: PickedCompany | null) => void; autoFocus?: boolean }) {
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  useEffect(() => { const t = setTimeout(() => setDebouncedQ(q), 350); return () => clearTimeout(t); }, [q]);
  const { data } = useQuery({
    queryKey: ['company-picker', debouncedQ],
    queryFn: () => api.getCompanies({ q: debouncedQ, status: 'official', limit: 8 }),
    enabled: debouncedQ.length >= 2 && !value,
  });
  if (value) {
    return (
      <div className="flex items-center justify-between px-3 py-2 bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-200 dark:border-indigo-800/50 rounded-lg text-xs">
        <span className="font-bold text-indigo-800 dark:text-indigo-300">{value.company_name}</span>
        <button onClick={() => { onChange(null); setQ(''); }} className="text-indigo-500"><X size={13} /></button>
      </div>
    );
  }
  return (
    <div className="relative">
      <input
        autoFocus={autoFocus}
        value={q}
        onChange={e => setQ(e.target.value)}
        placeholder="Search company name or ICRIS…"
        className="w-full h-9 px-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg text-xs font-semibold outline-none focus:border-indigo-400"
      />
      {data && data.items.length > 0 && (
        <div className="absolute z-10 mt-1 w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg shadow-lg max-h-48 overflow-y-auto">
          {data.items.map(c => (
            <button
              key={c.company_id}
              onClick={() => onChange({ id: c.company_id, company_name: c.company_name })}
              className="w-full text-left px-3 py-2 text-xs hover:bg-slate-50 dark:hover:bg-slate-800 border-b border-slate-100 dark:border-slate-800 last:border-0"
            >
              <div className="font-bold text-slate-800 dark:text-slate-200">{c.company_name}</div>
              <div className="font-mono text-[10px] text-slate-500">{c.icris_number}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
