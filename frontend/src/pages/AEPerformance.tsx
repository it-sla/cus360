import React, { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import type { AEPerformanceItem, AECustomer, AeTarget } from '../api';
import ReactECharts from 'echarts-for-react';
import { useNavigate } from 'react-router-dom';
import {
  Download, Calendar, Users, Building2, Activity,
  ArrowUpRight, ArrowDownRight, RefreshCw, X, Search,
} from 'lucide-react';

/* ── date range control ─────────────────────────────────────────────── */

const DATE_PRESET_GROUPS = [
  { label: 'Quick Ranges', options: [
    { value: 'today', label: 'Today' },
    { value: 'last_7_days', label: 'Last 7 Days' },
    { value: 'last_30_days', label: 'Last 30 Days' },
    { value: 'last_90_days', label: 'Last 90 Days' },
  ]},
  { label: 'Calendar Period', options: [
    { value: 'this_month', label: 'This Month (MTD)' },
    { value: 'last_month', label: 'Last Month' },
    { value: 'this_quarter', label: 'This Quarter' },
    { value: 'last_quarter', label: 'Last Quarter' },
    { value: 'this_year', label: 'This Year (YTD)' },
    { value: 'last_year', label: 'Last Year' },
  ]},
  { label: 'By Year', options: [
    { value: 'year_2026', label: '2026' },
    { value: 'year_2025', label: '2025' },
    { value: 'year_2024', label: '2024' },
  ]},
  { label: 'All History', options: [{ value: 'all_time', label: 'All Time' }]},
];
const TIMEFRAME_LABELS: Record<string, string> = Object.fromEntries(
  DATE_PRESET_GROUPS.flatMap(g => g.options).map(o => [o.value, o.label]).concat([['custom', 'Custom Range']])
);
const TODAY_ISO = new Date().toISOString().slice(0, 10);
function isoDaysAgo(n: number) { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); }
function fmtShortDate(iso: string) {
  if (!iso) return '';
  const d = new Date(`${iso}T00:00:00`);
  return isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function DateRangeControl({ timeframe, dateFrom, dateTo, bounds, onPreset, onCustom }: {
  timeframe: string; dateFrom: string; dateTo: string; bounds?: { c_start: string; c_end: string };
  onPreset: (v: string) => void; onCustom: (f: string, t: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const isCustom = timeframe === 'custom';
  const isFiltered = timeframe !== 'this_month';
  const [showCustom, setShowCustom] = useState(isCustom);
  const [draftFrom, setDraftFrom] = useState(dateFrom || isoDaysAgo(29));
  const [draftTo, setDraftTo] = useState(dateTo || TODAY_ISO);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; maxHeight: number } | null>(null);

  // Fixed positioning, computed and clamped to the actual viewport every time the panel
  // opens or the window resizes. `absolute right-0` broke on narrow panes: the trigger
  // button itself gets pushed off-screen by the sidebar before the panel ever renders,
  // so anchoring the panel to it (rather than the viewport) let it spill past both edges
  // and overlap the sidebar/content behind it.
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
  React.useEffect(() => {
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
        className={`h-9 pl-8 ${isFiltered ? 'pr-8' : 'pr-3'} bg-[#18181b] border border-[#27272a] rounded-lg hover:bg-[#27272a] transition-colors flex flex-col items-start justify-center relative min-w-[150px]`}
      >
        <Calendar size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
        <span className="text-xs font-bold text-slate-200 leading-tight">{label}</span>
        {resolved && !isCustom && <span className="text-[9.5px] text-slate-500 font-semibold leading-tight">{resolved}</span>}
      </button>
      {isFiltered && (
        <button
          onClick={(e) => { e.stopPropagation(); setOpen(false); onPreset('this_month'); }}
          title="Clear date filter"
          className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 rounded-md text-slate-500 hover:text-slate-200 hover:bg-[#27272a] transition-colors"
        >
          <X size={13} />
        </button>
      )}
      {open && pos && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            style={{ position: 'fixed', top: pos.top, left: pos.left, width: PANEL_WIDTH, maxHeight: pos.maxHeight }}
            className="z-50 bg-[#18181b] border border-[#27272a] rounded-xl shadow-2xl p-3 space-y-3 overflow-y-auto"
          >
            {DATE_PRESET_GROUPS.map(g => (
              <div key={g.label}>
                <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1.5 px-0.5">{g.label}</div>
                <div className="grid grid-cols-2 gap-1">
                  {g.options.map(o => (
                    <button key={o.value} onClick={() => { onPreset(o.value); setOpen(false); }}
                      className={`px-2 py-1.5 rounded-lg text-xs font-semibold text-left transition-colors ${
                        timeframe === o.value ? 'bg-blue-600 text-white' : 'bg-[#09090b] text-slate-300 hover:bg-[#27272a]'}`}>
                      {o.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
            <div className="border-t border-[#27272a] pt-3">
              {isFiltered && (
                <button onClick={() => { onPreset('this_month'); setOpen(false); }}
                  className="w-full px-2 py-1.5 rounded-lg text-xs font-semibold text-left mb-2 text-rose-400 hover:bg-rose-950/40 transition-colors flex items-center gap-1.5">
                  <X size={12} /> Clear Filter
                </button>
              )}
              <button onClick={() => setShowCustom(true)}
                className={`w-full px-2 py-1.5 rounded-lg text-xs font-semibold text-left mb-2 transition-colors ${
                  isCustom ? 'bg-blue-600 text-white' : 'bg-[#09090b] text-slate-300 hover:bg-[#27272a]'}`}>
                Custom Range{isCustom && dateFrom && dateTo ? `: ${fmtShortDate(dateFrom)} – ${fmtShortDate(dateTo)}` : ''}
              </button>
              {showCustom && (
                <div className="space-y-2 bg-[#09090b] rounded-lg p-2.5 border border-[#27272a]">
                  <div className="flex items-center gap-2">
                    <div className="flex-1">
                      <label className="block text-[9px] font-bold uppercase text-slate-500 mb-0.5">From</label>
                      <input type="date" value={draftFrom} max={draftTo || TODAY_ISO} onChange={e => setDraftFrom(e.target.value)}
                        className="w-full h-8 px-2 bg-[#18181b] border border-[#27272a] rounded-md text-xs font-medium text-slate-200 outline-none focus:border-blue-500" />
                    </div>
                    <div className="flex-1">
                      <label className="block text-[9px] font-bold uppercase text-slate-500 mb-0.5">To</label>
                      <input type="date" value={draftTo} min={draftFrom} max={TODAY_ISO} onChange={e => setDraftTo(e.target.value)}
                        className="w-full h-8 px-2 bg-[#18181b] border border-[#27272a] rounded-md text-xs font-medium text-slate-200 outline-none focus:border-blue-500" />
                    </div>
                  </div>
                  <button onClick={() => { if (!draftFrom || !draftTo) return; const f = draftFrom <= draftTo ? draftFrom : draftTo; const t = draftFrom <= draftTo ? draftTo : draftFrom; onCustom(f, t); setOpen(false); }}
                    disabled={!draftFrom || !draftTo}
                    className="w-full h-8 bg-blue-600 text-white text-xs font-bold rounded-md disabled:opacity-40 hover:bg-blue-500 transition-colors">
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

/* ── small building blocks ──────────────────────────────────────────── */

const Select = ({ value, onChange, children, icon: Icon }: any) => (
  <div className="relative">
    {Icon && <Icon size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />}
    <select value={value} onChange={onChange}
      className={`h-9 ${Icon ? 'pl-8' : 'pl-3'} pr-7 bg-[#18181b] border border-[#27272a] rounded-lg text-xs font-semibold text-slate-200 outline-none hover:bg-[#27272a] cursor-pointer appearance-none`}>
      {children}
    </select>
    <div className="absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none text-slate-500 text-[10px]">▼</div>
  </div>
);

function Delta({ pct }: { pct: number }) {
  if (pct === 0) return <span className="text-slate-500 text-xs shrink-0">—</span>;
  const up = pct > 0;
  return (
    <span className={`inline-flex items-center gap-0.5 font-bold text-xs shrink-0 ${up ? 'text-emerald-400' : 'text-rose-400'}`}>
      {up ? <ArrowUpRight size={11} /> : <ArrowDownRight size={11} />}{Math.abs(pct).toFixed(0)}%
    </span>
  );
}

const fmt$ = (v: number) => `$${v >= 1_000_000 ? (v / 1_000_000).toFixed(2) + 'M' : v >= 1000 ? (v / 1000).toFixed(1) + 'k' : v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
const fmtN = (v: number) => (v || 0).toLocaleString();

// Targets are stored per calendar month; the performance period can be any range.
// A target "for this period" is the sum of every month the range touches — full
// months, not pro-rated days, so a period that clips a month still counts it whole.
function monthsInRange(startISO?: string, endISO?: string): Array<{ year: number; month: number }> {
  if (!startISO || !endISO) return [];
  const start = new Date(`${startISO}T00:00:00`);
  const end = new Date(`${endISO}T00:00:00`);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) return [];
  const out: Array<{ year: number; month: number }> = [];
  let y = start.getFullYear();
  let m = start.getMonth() + 1;
  const endY = end.getFullYear();
  const endM = end.getMonth() + 1;
  while (y < endY || (y === endY && m <= endM)) {
    out.push({ year: y, month: m });
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

function attainmentTone(pct: number) {
  if (pct >= 100) return 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20';
  if (pct >= 70) return 'text-amber-400 bg-amber-500/10 border-amber-500/20';
  return 'text-rose-400 bg-rose-500/10 border-rose-500/20';
}

const STATUS_STYLE: Record<string, string> = {
  Active: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  Warning: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  Dormant: 'bg-rose-500/10 text-rose-400 border-rose-500/20',
  Unknown: 'bg-slate-500/10 text-slate-400 border-slate-500/20',
};

/* ── page ───────────────────────────────────────────────────────────── */

export default function AEPerformance() {
  const navigate = useNavigate();
  const [timeframe, setTimeframe] = useState('this_month');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [compareMode, setCompareMode] = useState('pop');
  const [aeFilter, setAeFilter] = useState('');
  const [segmentFilter, setSegmentFilter] = useState('');
  const [selectedAE, setSelectedAE] = useState<string | null>(null);
  const [drillStatus, setDrillStatus] = useState<string>('all');

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['ae-performance', timeframe, dateFrom, dateTo, compareMode, segmentFilter],
    queryFn: () => api.getAEPerformance({
      timeframe,
      date_from: timeframe === 'custom' && dateFrom ? dateFrom : undefined,
      date_to: timeframe === 'custom' && dateTo ? dateTo : undefined,
      compare_mode: compareMode,
      segment: segmentFilter || undefined,
    }),
  });

  const all: AEPerformanceItem[] = data?.items ?? [];
  const uniqueAEs = useMemo(() => all.map(a => a.ae).sort(), [all]);

  // Revenue targets for the period — targets live per calendar month/year, so pull
  // whichever year(s) the resolved date range actually touches (usually one, two if
  // a custom range crosses a year boundary).
  const periodMonths = useMemo(() => monthsInRange(data?.bounds?.c_start, data?.bounds?.c_end), [data?.bounds]);
  const startYear = periodMonths[0]?.year;
  const endYear = periodMonths[periodMonths.length - 1]?.year;

  const targetsStartYearQuery = useQuery({
    queryKey: ['aeTargets', startYear],
    queryFn: () => api.getAeTargets({ year: startYear }),
    enabled: !!startYear,
  });
  const targetsEndYearQuery = useQuery({
    queryKey: ['aeTargets', endYear],
    queryFn: () => api.getAeTargets({ year: endYear }),
    enabled: !!endYear && endYear !== startYear,
  });

  const targetByAe = useMemo(() => {
    const monthKeys = new Set(periodMonths.map(m => `${m.year}-${m.month}`));
    const rows: AeTarget[] = [
      ...(targetsStartYearQuery.data ?? []),
      ...(endYear !== startYear ? (targetsEndYearQuery.data ?? []) : []),
    ];
    const map: Record<string, number> = {};
    for (const t of rows) {
      if (!monthKeys.has(`${t.year}-${t.month}`)) continue;
      if (t.revenue_target == null) continue;
      map[t.ae_code] = (map[t.ae_code] ?? 0) + t.revenue_target;
    }
    return map;
  }, [periodMonths, targetsStartYearQuery.data, targetsEndYearQuery.data, startYear, endYear]);

  const list = useMemo(
    () => (aeFilter ? all.filter(a => a.ae === aeFilter) : all),
    [all, aeFilter]
  );

  const totals = useMemo(() => {
    const t = { revenue: 0, prevRevenue: 0, shipments: 0, prevShipments: 0, weight: 0, pieces: 0,
                companies: 0, active: 0, warning: 0, dormant: 0, reactivated: 0, newCustomers: 0 };
    list.forEach(a => {
      t.revenue += a.revenue; t.prevRevenue += a.prev_revenue;
      t.shipments += a.shipments; t.prevShipments += a.prev_shipments;
      t.weight += a.weight; t.pieces += a.pieces; t.companies += a.companies;
      t.active += a.active; t.warning += a.warning; t.dormant += a.dormant;
      t.reactivated += a.reactivated; t.newCustomers += a.new_customers;
    });
    return t;
  }, [list]);

  const pct = (cur: number, prev: number) => (!prev ? (cur ? 100 : 0) : Math.round(((cur - prev) / prev) * 1000) / 10);

  const th = data?.health_thresholds;

  const drillAE = selectedAE ? all.find(a => a.ae === selectedAE) : null;
  const drillCustomers: AECustomer[] = useMemo(() => {
    if (!drillAE) return [];
    if (drillStatus === 'all') return drillAE.customers;
    if (drillStatus === 'new') return drillAE.customers.filter(c => c.is_new);
    if (drillStatus === 'reactivated') return drillAE.customers.filter(c => c.is_reactivated);
    return drillAE.customers.filter(c => c.status === drillStatus);
  }, [drillAE, drillStatus]);

  const exportCsv = () => {
    const head = ['AE','Revenue','Prev Revenue','Growth %','Share %','Shipments','Companies','Active','Warning','Dormant','New','Reactivated','Avg Rev/Customer','Weight (kg)','Pieces'];
    const body = list.map(a => [a.ae, a.revenue, a.prev_revenue, a.revenue_growth_pct, a.revenue_share_pct,
      a.shipments, a.companies, a.active, a.warning, a.dormant, a.new_customers, a.reactivated,
      a.avg_revenue_per_customer, a.weight, a.pieces]);
    const csv = [head, ...body].map(r => r.map(v => `"${String(v ?? '')}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `ae-performance-${data?.bounds.c_start ?? ''}_${data?.bounds.c_end ?? ''}.csv`;
    a.click(); URL.revokeObjectURL(url);
  };

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center min-h-[600px]">
        <div className="flex flex-col items-center gap-3 bg-[#18181b] p-10 rounded-2xl border border-[#27272a]">
          <RefreshCw className="animate-spin text-blue-400" size={32} />
          <span className="font-semibold text-slate-300 text-sm">Loading AE Performance…</span>
        </div>
      </div>
    );
  }

  const chartBase = {
    tooltip: { trigger: 'axis', backgroundColor: '#18181b', borderColor: '#27272a', textStyle: { color: '#fafafa', fontSize: 12 } },
    grid: { top: 24, right: 16, bottom: 28, left: 60 },
    xAxis: { type: 'category', data: list.map(a => a.ae), axisLabel: { color: '#a1a1aa', fontWeight: 'bold', interval: 0, rotate: list.length > 6 ? 30 : 0 }, axisLine: { lineStyle: { color: '#27272a' } } },
  };

  return (
    <div className="flex-1 overflow-y-auto relative">
      {isFetching && <div className="h-0.5 bg-gradient-to-r from-blue-500 via-indigo-500 to-blue-600 animate-pulse w-full sticky top-0 z-50" />}

      <div className="p-6 max-w-[1600px] mx-auto space-y-6">

        {/* header */}
        <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-black text-slate-50 tracking-tight">AE Performance</h1>
            <p className="mt-1 text-xs text-slate-400 font-medium">
              <span className="font-bold text-slate-200">{list.length}</span> account executives ·{' '}
              <span className="font-bold text-slate-200">{fmtN(totals.companies)}</span> customers ·{' '}
              <span className="font-bold text-slate-200">{fmt$(totals.revenue)}</span> revenue
              {data?.bounds && <> · <span className="font-bold text-slate-200">{fmtShortDate(data.bounds.c_start)} – {fmtShortDate(data.bounds.c_end)}</span></>}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <DateRangeControl
              timeframe={timeframe} dateFrom={dateFrom} dateTo={dateTo} bounds={data?.bounds}
              onPreset={(v) => { setTimeframe(v); setDateFrom(''); setDateTo(''); }}
              onCustom={(f, t) => { setTimeframe('custom'); setDateFrom(f); setDateTo(t); }}
            />
            <Select icon={Activity} value={compareMode} onChange={(e: any) => setCompareMode(e.target.value)}>
              <option value="pop">vs Previous Period</option>
              <option value="yoy">vs Same Period Last Year</option>
            </Select>
            <Select icon={Users} value={aeFilter} onChange={(e: any) => setAeFilter(e.target.value)}>
              <option value="">All AEs</option>
              {uniqueAEs.map(ae => <option key={ae} value={ae}>{ae}</option>)}
            </Select>
            <Select icon={Building2} value={segmentFilter} onChange={(e: any) => setSegmentFilter(e.target.value)}>
              <option value="">All Segments</option>
              {(data?.segments ?? []).filter(s => s !== 'Unclassified').map(s => <option key={s} value={s}>{s}</option>)}
            </Select>
            <button onClick={exportCsv}
              className="h-9 flex items-center gap-2 bg-[#18181b] border border-[#27272a] text-slate-300 px-3 rounded-lg hover:bg-[#27272a] transition-colors text-xs font-bold">
              <Download size={14} /> Export CSV
            </button>
          </div>
        </div>

        {/* KPI row */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            { label: 'Revenue', value: fmt$(totals.revenue), delta: pct(totals.revenue, totals.prevRevenue), sub: `prev ${fmt$(totals.prevRevenue)}` },
            { label: 'Shipments', value: fmtN(totals.shipments), delta: pct(totals.shipments, totals.prevShipments), sub: `prev ${fmtN(totals.prevShipments)}` },
            { label: 'Customers', value: fmtN(totals.companies), sub: `${fmt$(totals.companies ? totals.revenue / totals.companies : 0)} avg` },
            { label: 'Active', value: fmtN(totals.active), sub: `≤ ${th?.active_days ?? 30} days`, tone: 'text-emerald-400' },
          ].map((k, i) => (
            <div key={i} className="bg-[#18181b] p-4 rounded-xl border border-[#27272a] overflow-hidden min-w-0">
              <div className="text-slate-400 text-[10px] font-bold uppercase tracking-wider mb-1.5 truncate">{k.label}</div>
              <div className="flex items-baseline gap-1.5 flex-wrap">
                <div className={`text-xl font-black ${k.tone ?? 'text-slate-50'} truncate max-w-full`}>{k.value}</div>
                {k.delta !== undefined && <Delta pct={k.delta} />}
              </div>
              {k.sub && <div className="text-[10px] text-slate-500 font-semibold mt-1 truncate">{k.sub}</div>}
            </div>
          ))}
        </div>

        {/* charts */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-[#18181b] p-5 rounded-xl border border-[#27272a]">
            <h3 className="text-sm font-bold text-slate-50 mb-1">Revenue by AE</h3>
            <p className="text-[11px] text-slate-500 font-medium mb-3">Current period vs {compareMode === 'yoy' ? 'same period last year' : 'previous period'}</p>
            <ReactECharts style={{ height: 300 }} option={{
              ...chartBase,
              legend: { data: ['Current', 'Previous', 'Target'], textStyle: { color: '#a1a1aa', fontSize: 11 }, top: 0, right: 0 },
              yAxis: { type: 'value', axisLabel: { formatter: (v: any) => `$${v / 1000}k`, color: '#a1a1aa' }, splitLine: { lineStyle: { color: '#27272a' } } },
              series: [
                { name: 'Current', type: 'bar', data: list.map(a => a.revenue), itemStyle: { color: '#3b82f6', borderRadius: [4, 4, 0, 0] } },
                { name: 'Previous', type: 'bar', data: list.map(a => a.prev_revenue), itemStyle: { color: '#3f3f46', borderRadius: [4, 4, 0, 0] } },
                {
                  name: 'Target', type: 'scatter', symbol: 'diamond', symbolSize: 10,
                  data: list.map(a => targetByAe[a.ae] ?? null),
                  itemStyle: { color: '#f59e0b', borderColor: '#09090b', borderWidth: 1.5 },
                },
              ],
            }} />
          </div>
          <div className="bg-[#18181b] p-5 rounded-xl border border-[#27272a]">
            <h3 className="text-sm font-bold text-slate-50 mb-1">Portfolio Health by AE</h3>
            <p className="text-[11px] text-slate-500 font-medium mb-3">Based on each customer's true last shipment, all-time</p>
            <ReactECharts style={{ height: 300 }} option={{
              ...chartBase,
              legend: { data: ['Active', 'At Risk', 'Dormant'], textStyle: { color: '#a1a1aa', fontSize: 11 }, top: 0, right: 0 },
              yAxis: { type: 'value', axisLabel: { color: '#a1a1aa' }, splitLine: { lineStyle: { color: '#27272a' } } },
              series: [
                { name: 'Active', type: 'bar', stack: 'h', data: list.map(a => a.active), itemStyle: { color: '#10b981' } },
                { name: 'At Risk', type: 'bar', stack: 'h', data: list.map(a => a.warning), itemStyle: { color: '#f59e0b' } },
                { name: 'Dormant', type: 'bar', stack: 'h', data: list.map(a => a.dormant), itemStyle: { color: '#f43f5e' } },
              ],
            }} />
          </div>
        </div>

        {/* leaderboard */}
        <div className="bg-[#18181b] rounded-xl border border-[#27272a] overflow-hidden">
          <div className="px-5 py-4 border-b border-[#27272a] flex items-center justify-between">
            <div>
              <h3 className="text-sm font-bold text-slate-50">AE Leaderboard</h3>
              <p className="text-[11px] text-slate-500 font-medium mt-0.5">Click any row to inspect that portfolio</p>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs whitespace-nowrap">
              <thead className="bg-[#09090b] border-b border-[#27272a] text-slate-500">
                <tr className="text-[10px] uppercase tracking-widest font-bold">
                  <th className="px-4 py-3">#</th>
                  <th className="px-4 py-3">AE</th>
                  <th className="px-4 py-3 text-right">Revenue</th>
                  <th className="px-4 py-3 text-right">Target</th>
                  <th className="px-4 py-3 text-right">Attainment</th>
                  <th className="px-4 py-3 text-right">Trend</th>
                  <th className="px-4 py-3 text-right">Share</th>
                  <th className="px-4 py-3 text-right">Customers</th>
                  <th className="px-4 py-3 text-right">Avg / Cust.</th>
                  <th className="px-4 py-3 text-right">Shipments</th>
                  <th className="px-4 py-3 text-right">Active</th>
                  <th className="px-4 py-3 text-right">At Risk</th>
                  <th className="px-4 py-3 text-right">Dormant</th>
                  <th className="px-4 py-3 text-right">New</th>
                  <th className="px-4 py-3 text-right">React.</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#27272a]">
                {list.length === 0 && (
                  <tr><td colSpan={15} className="px-5 py-20 text-center text-slate-500">
                    <Search size={28} className="mx-auto mb-3 text-slate-700" />
                    <p className="text-sm font-bold text-slate-400">No AE activity in this period</p>
                    <p className="text-xs mt-1">Try a wider date range or clear the filters.</p>
                  </td></tr>
                )}
                {list.map((a, i) => {
                  const target = targetByAe[a.ae];
                  const attainment = target && target > 0 ? Math.round((a.revenue / target) * 1000) / 10 : null;
                  return (
                  <tr key={a.ae} onClick={() => { setSelectedAE(a.ae); setDrillStatus('all'); }}
                    className={`hover:bg-[#27272a] transition-colors cursor-pointer ${a.ae === 'UNASSIGNED' ? 'bg-amber-500/[0.04]' : ''}`}>
                    <td className="px-4 py-3 text-slate-600 font-mono">{i + 1}</td>
                    <td className="px-4 py-3 font-bold text-slate-50">
                      {a.ae}
                      {a.ae === 'UNASSIGNED' && <span className="ml-2 text-[9px] uppercase font-bold text-amber-400 border border-amber-500/30 rounded px-1 py-0.5">unowned</span>}
                    </td>
                    <td className="px-4 py-3 text-right font-black text-slate-100">{fmt$(a.revenue)}</td>
                    <td className="px-4 py-3 text-right text-slate-400">{target ? fmt$(target) : '—'}</td>
                    <td className="px-4 py-3 text-right">
                      {attainment !== null ? (
                        <span className={`inline-block px-2 py-0.5 text-[10px] font-bold rounded border ${attainmentTone(attainment)}`}>{attainment}%</span>
                      ) : <span className="text-slate-600">—</span>}
                    </td>
                    <td className="px-4 py-3 text-right"><Delta pct={a.revenue_growth_pct} /></td>
                    <td className="px-4 py-3 text-right text-slate-400 font-semibold">{a.revenue_share_pct}%</td>
                    <td className="px-4 py-3 text-right text-slate-300">{fmtN(a.companies)}</td>
                    <td className="px-4 py-3 text-right text-slate-400">{fmt$(a.avg_revenue_per_customer)}</td>
                    <td className="px-4 py-3 text-right text-slate-300">{fmtN(a.shipments)}</td>
                    <td className="px-4 py-3 text-right text-emerald-400 font-semibold">{a.active}</td>
                    <td className="px-4 py-3 text-right text-amber-400 font-semibold">{a.warning}</td>
                    <td className="px-4 py-3 text-right text-rose-400 font-semibold">{a.dormant}</td>
                    <td className="px-4 py-3 text-right text-blue-400">{a.new_customers}</td>
                    <td className="px-4 py-3 text-right text-indigo-400">{a.reactivated}</td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

      </div>

      {/* drill-down drawer */}
      {drillAE && (
        <>
          <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-40" onClick={() => setSelectedAE(null)} />
          <aside className="fixed inset-y-0 right-0 z-50 w-full max-w-[720px] bg-[#09090b] border-l border-[#27272a] shadow-2xl flex flex-col">
            <div className="px-5 py-4 border-b border-[#27272a] flex items-center justify-between shrink-0">
              <div>
                <h2 className="text-lg font-black text-slate-50">{drillAE.ae}</h2>
                <p className="text-[11px] text-slate-500 font-semibold mt-0.5">
                  {fmt$(drillAE.revenue)} · {fmtN(drillAE.companies)} customers · {fmtN(drillAE.shipments)} shipments
                  {data?.bounds && <> · {fmtShortDate(data.bounds.c_start)} – {fmtShortDate(data.bounds.c_end)}</>}
                </p>
              </div>
              <button onClick={() => setSelectedAE(null)} className="p-1.5 text-slate-500 hover:text-slate-200 rounded-md hover:bg-[#27272a]">
                <X size={18} />
              </button>
            </div>

            <div className="px-5 py-3 border-b border-[#27272a] shrink-0 space-y-3">
              <div className="grid grid-cols-5 gap-2">
                {[
                  { k: 'Revenue', v: fmt$(drillAE.revenue), d: drillAE.revenue_growth_pct },
                  targetByAe[drillAE.ae]
                    ? { k: 'Target', v: fmt$(targetByAe[drillAE.ae]), sub: `${Math.round((drillAE.revenue / targetByAe[drillAE.ae]) * 1000) / 10}% attained` }
                    : { k: 'Target', v: 'Not set' },
                  { k: 'Avg / Customer', v: fmt$(drillAE.avg_revenue_per_customer) },
                  { k: 'Avg / Shipment', v: fmt$(drillAE.avg_revenue_per_shipment) },
                  { k: 'Retained', v: `${drillAE.retained_companies}/${drillAE.prev_companies || 0}` },
                ].map(x => (
                  <div key={x.k} className="bg-[#18181b] rounded-lg border border-[#27272a] p-2.5">
                    <div className="text-[9px] font-bold uppercase tracking-wider text-slate-500 truncate">{x.k}</div>
                    <div className="flex items-baseline gap-1.5">
                      <div className="text-sm font-black text-slate-100">{x.v}</div>
                      {x.d !== undefined && <Delta pct={x.d} />}
                    </div>
                    {x.sub && <div className="text-[9px] text-slate-500 font-semibold mt-0.5 truncate">{x.sub}</div>}
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {[
                  { id: 'all', label: `All (${drillAE.customers.length})` },
                  { id: 'Active', label: `Active (${drillAE.active})` },
                  { id: 'Warning', label: `At Risk (${drillAE.warning})` },
                  { id: 'Dormant', label: `Dormant (${drillAE.dormant})` },
                  ...(drillAE.unknown ? [{ id: 'Unknown', label: `Unlinked (${drillAE.unknown})` }] : []),
                  { id: 'new', label: `New (${drillAE.new_customers})` },
                  { id: 'reactivated', label: `Reactivated (${drillAE.reactivated})` },
                ].map(f => (
                  <button key={f.id} onClick={() => setDrillStatus(f.id)}
                    className={`px-2.5 py-1 rounded-lg text-[11px] font-bold border transition-colors ${
                      drillStatus === f.id ? 'bg-blue-600 border-blue-600 text-white' : 'bg-[#18181b] border-[#27272a] text-slate-400 hover:bg-[#27272a]'}`}>
                    {f.label}
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(drillAE.segments).filter(([, n]) => n > 0).map(([seg, n]) => (
                  <span key={seg} className="px-2 py-0.5 rounded text-[10px] font-bold bg-[#18181b] border border-[#27272a] text-slate-400">
                    {seg}: <span className="text-slate-200">{n}</span>
                  </span>
                ))}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-[#09090b] border-b border-[#27272a] text-slate-500 sticky top-0">
                  <tr className="text-[10px] uppercase tracking-widest font-bold">
                    <th className="px-4 py-2.5">Customer</th>
                    <th className="px-3 py-2.5">ICRIS</th>
                    <th className="px-3 py-2.5 text-right">Revenue</th>
                    <th className="px-3 py-2.5 text-right">AWBs</th>
                    <th className="px-3 py-2.5 text-right">Last Shipment</th>
                    <th className="px-3 py-2.5">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#27272a]">
                  {drillCustomers.length === 0 && (
                    <tr><td colSpan={6} className="px-4 py-16 text-center text-slate-500 text-xs">No customers match this filter.</td></tr>
                  )}
                  {drillCustomers.map((c, i) => (
                    <tr key={c.company_id ?? i}
                      onClick={() => c.company_id && navigate(`/app/customers/${c.company_id}`)}
                      className={`transition-colors ${c.company_id ? 'hover:bg-[#18181b] cursor-pointer' : ''}`}>
                      <td className="px-4 py-2.5 font-semibold text-slate-200 max-w-[220px] truncate" title={c.company_name}>
                        {c.company_name}
                        {c.is_new && <span className="ml-1.5 text-[9px] font-bold text-blue-400">NEW</span>}
                        {c.is_reactivated && <span className="ml-1.5 text-[9px] font-bold text-indigo-400">REACTIVATED</span>}
                      </td>
                      <td className="px-3 py-2.5 font-mono text-slate-500">{c.icris_number ?? '—'}</td>
                      <td className="px-3 py-2.5 text-right font-bold text-slate-100">{fmt$(c.revenue)}</td>
                      <td className="px-3 py-2.5 text-right text-slate-400">{c.shipments}</td>
                      <td className="px-3 py-2.5 text-right text-slate-400">
                        {c.last_shipment_date ?? '—'}
                        {c.days_since_last_shipment != null && <span className="text-slate-600 ml-1">({c.days_since_last_shipment}d)</span>}
                      </td>
                      <td className="px-3 py-2.5">
                        <span className={`inline-block px-2 py-0.5 text-[10px] font-bold rounded uppercase border ${STATUS_STYLE[c.status] ?? STATUS_STYLE.Unknown}`}>
                          {c.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </aside>
        </>
      )}
    </div>
  );
}
