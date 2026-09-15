import React, { useState, useRef, useEffect } from 'react';
import { Calendar, X } from 'lucide-react';

/**
 * Shared filter primitives for every Business Analytics page (Executive Overview,
 * Business Analytics, Geography, Operations, Customer Analytics, AE Performance).
 * One canonical timeframe preset list, one canonical segment list, one date-range
 * popover — instead of five divergent copies with different option sets and bugs.
 */

export const TIMEFRAME_GROUPS = [
  { label: 'Quick Ranges', options: [
    { value: 'today', label: 'Today' },
    { value: 'yesterday', label: 'Yesterday' },
    { value: 'last_7_days', label: 'Last 7 Days' },
    { value: 'last_30_days', label: 'Last 30 Days' },
    { value: 'last_90_days', label: 'Last 90 Days' },
  ]},
  { label: 'Calendar Period', options: [
    { value: 'this_week', label: 'This Week' },
    { value: 'this_month', label: 'This Month (MTD)' },
    { value: 'last_month', label: 'Last Month' },
    { value: 'this_quarter', label: 'This Quarter (QTD)' },
    { value: 'last_quarter', label: 'Last Quarter' },
    { value: 'this_year', label: 'This Year (YTD)' },
    { value: 'last_year', label: 'Last Year' },
  ]},
  // Real data (shipments, MAWBs, P&L) goes back to 2016 [verified 2026-08-12] — keep this in
  // sync with that floor if older history is ever purged or a real cutoff is found.
  { label: 'By Year', options: Array.from({ length: 11 }, (_, i) => 2026 - i).map(y => ({ value: `year_${y}`, label: String(y) })) },
  { label: 'All History', options: [
    { value: 'all_time', label: 'All Time' },
  ]},
];

export const TIMEFRAME_LABELS: Record<string, string> = Object.fromEntries(
  TIMEFRAME_GROUPS.flatMap(g => g.options).map(o => [o.value, o.label]).concat([['custom', 'Custom Range']])
);

/** Canonical account segments — must match AE_SEGMENTS in backend/app/main.py.
 * Rule for how a company lands in one of these: docs/customer-segmentation-rules.md. */
export const SEGMENTS = ['Key Account', 'Reseller', 'Large Account', 'SME', 'Small Customer'] as const;

export const COMPARE_MODE_OPTIONS = [
  { value: 'pop', label: 'vs Previous Period' },
  { value: 'yoy', label: 'vs Same Period Last Year' },
];

// Local calendar date, not toISOString() — that normalizes to UTC first, which shifts
// the date back a day for any timezone ahead of UTC (e.g. Nepal, UTC+5:45). A "today"
// or "N days ago" default must reflect the browser's own calendar day.
function localIso(d: Date) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
const TODAY_ISO = localIso(new Date());
function isoDaysAgo(n: number) { const d = new Date(); d.setDate(d.getDate() - n); return localIso(d); }
export function fmtShortDate(iso: string) {
  if (!iso) return '';
  const d = new Date(`${iso}T00:00:00`);
  return isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * Resolves a TIMEFRAME_GROUPS preset into concrete { from, to } bounds, client-side.
 * Mirrors get_timeframe_bounds() in backend/app/main.py exactly — used by pages (AWB,
 * MAWB) whose list endpoints take literal date_from/date_to rather than a `timeframe`
 * string the backend resolves itself. Keep these two in sync if either changes.
 */
export function resolveTimeframeDates(tf: string, customFrom?: string, customTo?: string): { from?: string; to?: string } {
  const today = new Date();
  const iso = localIso;
  const addDays = (d: Date, n: number) => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };

  if (tf === 'all_time' || tf === 'all') return {};
  if (tf === 'custom') return { from: customFrom || undefined, to: customTo || undefined };
  if (tf === 'today') return { from: iso(today), to: iso(today) };
  if (tf === 'yesterday') { const d = addDays(today, -1); return { from: iso(d), to: iso(d) }; }
  if (tf === 'last_7_days') return { from: iso(addDays(today, -6)), to: iso(today) };
  if (tf === 'last_30_days') return { from: iso(addDays(today, -29)), to: iso(today) };
  if (tf === 'last_90_days') return { from: iso(addDays(today, -89)), to: iso(today) };
  if (tf === 'this_week') { const daysSinceSun = today.getDay(); const start = addDays(today, -daysSinceSun); return { from: iso(start), to: iso(addDays(start, 6)) }; }
  if (tf === 'this_month') return { from: iso(new Date(today.getFullYear(), today.getMonth(), 1)), to: iso(new Date(today.getFullYear(), today.getMonth() + 1, 0)) };
  if (tf === 'last_month') return { from: iso(new Date(today.getFullYear(), today.getMonth() - 1, 1)), to: iso(new Date(today.getFullYear(), today.getMonth(), 0)) };
  if (tf === 'this_quarter') { const qm = Math.floor(today.getMonth() / 3) * 3; return { from: iso(new Date(today.getFullYear(), qm, 1)), to: iso(new Date(today.getFullYear(), qm + 3, 0)) }; }
  if (tf === 'last_quarter') { const qm = Math.floor(today.getMonth() / 3) * 3; return { from: iso(new Date(today.getFullYear(), qm - 3, 1)), to: iso(new Date(today.getFullYear(), qm, 0)) }; }
  if (tf === 'this_year') return { from: `${today.getFullYear()}-01-01`, to: `${today.getFullYear()}-12-31` };
  if (tf === 'last_year') return { from: `${today.getFullYear() - 1}-01-01`, to: `${today.getFullYear() - 1}-12-31` };
  if (tf.startsWith('year_')) { const yr = tf.replace('year_', ''); return { from: `${yr}-01-01`, to: `${yr}-12-31` }; }
  // Unrecognised — same "don't silently misbehave" fallback as the backend: last 30 days.
  return { from: iso(addDays(today, -29)), to: iso(today) };
}

type SelectOption = { value: string; label: string } | { optgroup: true; label: string; options: { value: string; label: string }[] };

/** Generic themed dropdown used for AE / segment / country / origin / destination / compare-mode filters. */
export function FilterSelect({ value, onChange, options, placeholder, icon: Icon }: {
  value: string; onChange: (e: React.ChangeEvent<HTMLSelectElement>) => void;
  options: (string | SelectOption)[]; placeholder?: string; icon?: React.ComponentType<{ size?: number; className?: string }>;
}) {
  return (
    <div className="relative">
      {Icon && <Icon size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />}
      <select
        value={value}
        onChange={onChange}
        className={`h-9 ${Icon ? 'pl-8' : 'pl-3'} pr-7 py-0 bg-white dark:bg-slate-900/50 border border-slate-200 dark:border-slate-800 rounded-lg text-xs font-semibold text-slate-800 dark:text-slate-200 outline-none hover:bg-slate-50 dark:hover:bg-slate-800/50 cursor-pointer appearance-none shadow-sm`}
      >
        {placeholder && <option value="">{placeholder}</option>}
        {options.map((opt) => typeof opt === 'string'
          ? <option key={opt} value={opt}>{opt}</option>
          : 'optgroup' in opt ? (
              <optgroup key={opt.label} label={opt.label}>
                {opt.options.map((sub) => <option key={sub.value} value={sub.value}>{sub.label}</option>)}
              </optgroup>
            ) : (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            )
        )}
      </select>
      <div className="absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none text-slate-400 text-[10px]">▼</div>
    </div>
  );
}

/** Thin FilterSelect wrapper for the period-over-period / year-over-year toggle. */
export function CompareModeSelect({ value, onChange, icon }: {
  value: string; onChange: (e: React.ChangeEvent<HTMLSelectElement>) => void;
  icon?: React.ComponentType<{ size?: number; className?: string }>;
}) {
  return <FilterSelect icon={icon} value={value} onChange={onChange} options={COMPARE_MODE_OPTIONS} />;
}

/**
 * Timeframe + custom date-range popover. One implementation shared by every analytics
 * page instead of five divergent copies. Panel position is clamped to the viewport
 * (rather than `absolute right-0`) so it doesn't spill past the sidebar/edge on narrow panes.
 */
export function DateRangeControl({ timeframe, dateFrom, dateTo, bounds, onPreset, onCustom, defaultPreset = 'this_month' }: {
  timeframe: string; dateFrom: string; dateTo: string; bounds?: { c_start: string; c_end: string };
  onPreset: (v: string) => void; onCustom: (f: string, t: string) => void; defaultPreset?: string;
}) {
  const [open, setOpen] = useState(false);
  const isCustom = timeframe === 'custom';
  const isFiltered = timeframe !== defaultPreset;
  const [showCustom, setShowCustom] = useState(isCustom);
  const [draftFrom, setDraftFrom] = useState(dateFrom || isoDaysAgo(29));
  const [draftTo, setDraftTo] = useState(dateTo || TODAY_ISO);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; maxHeight: number } | null>(null);

  const PANEL_WIDTH = 300;
  const MARGIN = 8;
  const reposition = () => {
    const r = triggerRef.current?.getBoundingClientRect();
    if (!r) return;
    const left = Math.min(Math.max(r.right - PANEL_WIDTH, MARGIN), window.innerWidth - PANEL_WIDTH - MARGIN);
    const top = r.bottom + 8;
    const maxHeight = Math.max(160, window.innerHeight - top - MARGIN);
    setPos({ top, left: Math.max(left, MARGIN), maxHeight });
  };
  useEffect(() => {
    if (!open) return;
    reposition();
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => { window.removeEventListener('resize', reposition); window.removeEventListener('scroll', reposition, true); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const label = isCustom
    ? (dateFrom && dateTo ? `${fmtShortDate(dateFrom)} – ${fmtShortDate(dateTo)}` : 'Custom Range')
    : (TIMEFRAME_LABELS[timeframe] || timeframe);
  const resolved = bounds?.c_start && bounds?.c_end ? `${fmtShortDate(bounds.c_start)} – ${fmtShortDate(bounds.c_end)}` : '';

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        onClick={() => { if (open) { setOpen(false); return; } setShowCustom(isCustom); setDraftFrom(dateFrom || isoDaysAgo(29)); setDraftTo(dateTo || TODAY_ISO); setOpen(true); }}
        className={`h-9 pl-8 ${isFiltered ? 'pr-8' : 'pr-3'} bg-white dark:bg-slate-900/50 border border-slate-200 dark:border-slate-800 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800/50 shadow-sm transition-colors flex flex-col items-start justify-center relative min-w-[148px]`}
      >
        <Calendar size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
        <span className="text-xs font-bold text-slate-800 dark:text-slate-200 leading-tight">{label}</span>
        {resolved && !isCustom && <span className="text-[9.5px] text-slate-400 font-semibold leading-tight">{resolved}</span>}
      </button>
      {isFiltered && (
        <button
          onClick={(e) => { e.stopPropagation(); setOpen(false); onPreset(defaultPreset); }}
          title="Clear date filter"
          className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 rounded-md text-slate-400 hover:text-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 dark:hover:text-slate-200 transition-colors"
        >
          <X size={13} />
        </button>
      )}
      {open && pos && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            style={{ position: 'fixed', top: pos.top, left: pos.left, width: PANEL_WIDTH, maxHeight: pos.maxHeight }}
            className="z-50 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-2xl p-3 space-y-3 overflow-y-auto"
          >
            {TIMEFRAME_GROUPS.map(g => (
              <div key={g.label}>
                <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1.5 px-0.5">{g.label}</div>
                <div className="grid grid-cols-2 gap-1">
                  {g.options.map(o => (
                    <button key={o.value} onClick={() => { onPreset(o.value); setOpen(false); }}
                      className={`px-2 py-1.5 rounded-lg text-xs font-semibold text-left transition-colors ${
                        timeframe === o.value ? 'bg-primary text-white' : 'bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700'}`}>
                      {o.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
            <div className="border-t border-slate-100 dark:border-slate-800 pt-3">
              {isFiltered && (
                <button onClick={() => { onPreset(defaultPreset); setOpen(false); }}
                  className="w-full px-2 py-1.5 rounded-lg text-xs font-semibold text-left mb-2 text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40 transition-colors flex items-center gap-1.5">
                  <X size={12} /> Clear Filter
                </button>
              )}
              <button onClick={() => setShowCustom(true)}
                className={`w-full px-2 py-1.5 rounded-lg text-xs font-semibold text-left mb-2 transition-colors ${
                  isCustom ? 'bg-primary text-white' : 'bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700'}`}>
                Custom Range{isCustom && dateFrom && dateTo ? `: ${fmtShortDate(dateFrom)} – ${fmtShortDate(dateTo)}` : ''}
              </button>
              {showCustom && (
                <div className="space-y-2 bg-slate-50 dark:bg-slate-800 rounded-lg p-2.5 border border-slate-200 dark:border-slate-700">
                  <div className="flex items-center gap-2">
                    <div className="flex-1">
                      <label className="block text-[9px] font-bold uppercase text-slate-400 mb-0.5">From</label>
                      <input type="date" value={draftFrom} max={draftTo || TODAY_ISO} onChange={e => setDraftFrom(e.target.value)}
                        className="w-full h-8 px-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md text-xs font-medium text-slate-800 dark:text-slate-200 outline-none focus:ring-2 focus:ring-primary/20" />
                    </div>
                    <div className="flex-1">
                      <label className="block text-[9px] font-bold uppercase text-slate-400 mb-0.5">To</label>
                      <input type="date" value={draftTo} min={draftFrom} max={TODAY_ISO} onChange={e => setDraftTo(e.target.value)}
                        className="w-full h-8 px-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md text-xs font-medium text-slate-800 dark:text-slate-200 outline-none focus:ring-2 focus:ring-primary/20" />
                    </div>
                  </div>
                  <button onClick={() => { if (!draftFrom || !draftTo) return; const f = draftFrom <= draftTo ? draftFrom : draftTo; const t = draftFrom <= draftTo ? draftTo : draftFrom; onCustom(f, t); setOpen(false); }}
                    disabled={!draftFrom || !draftTo}
                    className="w-full h-8 bg-primary text-white text-xs font-bold rounded-md disabled:opacity-40 hover:bg-blue-700 transition-colors">
                    Apply Range
                  </button>
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
