import React, { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import ReactECharts from 'echarts-for-react';
import { useNavigate } from 'react-router-dom';
import { 
  Search, RefreshCw, X, DollarSign, Users, Package, 
  TrendingUp, Map as ArrowUpRight, ArrowDownRight, MoreVertical,
  Briefcase, Filter, ChevronDown, ChevronRight, Activity
} from 'lucide-react';

import { KpiCard } from '@/components/KpiCard';
import { DateRangeControl, CompareModeSelect, TIMEFRAME_LABELS, fmtShortDate } from '@/components/AnalyticsFilterBar';

/** Revenue-tier quick filter (client-side only) — distinct from the canonical account
 * SEGMENTS list in AnalyticsFilterBar, hence not reusing that name here. */
const SEGMENTS = [
  { id: 'all',   label: 'All' },
  { id: 'Key Account', label: 'Key Account' },
  { id: 'Reseller', label: 'Reseller' },
  { id: 'Large Account', label: 'Large Account' },
  { id: 'SME', label: 'SME' },
  { id: 'Small Customer', label: 'Small Customer' },
];

function CollapsibleSection({
  title, 
  icon: Icon, 
  children, 
  defaultOpen = true 
}: { 
  title: string; 
  icon: any; 
  children: React.ReactNode; 
  defaultOpen?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-slate-100 py-3 first:pt-0 last:border-b-0">
      <button 
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between py-1 text-[11px] font-bold text-slate-800 uppercase tracking-wider hover:text-primary transition-colors"
      >
        <div className="flex items-center gap-2">
          <Icon size={14} className="text-primary" />
          <span>{title}</span>
        </div>
        {isOpen ? <ChevronDown size={14} className="text-slate-400" /> : <ChevronRight size={14} className="text-slate-400" />}
      </button>
      {isOpen && <div className="mt-2.5 space-y-3">{children}</div>}
    </div>
  );
}

function FilterGroup({ label, children }: { label?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      {label && <label className="block text-[10px] font-semibold text-slate-400 uppercase tracking-wider">{label}</label>}
      {children}
    </div>
  );
}

const inputCls = 'w-full h-8 px-2.5 bg-slate-50 border border-slate-200 rounded-lg text-xs font-medium text-slate-800 placeholder:text-slate-400 focus:ring-2 focus:ring-primary/20 focus:border-primary focus:bg-white transition-all outline-none';
const selectCls = `${inputCls} cursor-pointer appearance-none pr-7`;

const DropdownWrapper = ({ children, className = '' }: { children: React.ReactNode, className?: string }) => (
  <div className={`relative ${className}`}>
    {children}
    <div className="absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none text-slate-400 text-[10px]">▼</div>
  </div>
);

function ChartWrapper({ title, children }: { title: string, children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-[16px] border border-[#E2E8F0] p-5 sm:p-6 shadow-[0_2px_4px_rgba(15,23,42,0.04),0_10px_30px_rgba(15,23,42,0.06)] flex flex-col">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-bold text-slate-900 tracking-tight">{title}</h3>
        <button className="text-slate-400 hover:text-slate-600 p-1 rounded-md transition-colors">
          <MoreVertical size={16} />
        </button>
      </div>
      <div className="flex-1 min-h-[360px] relative">
        {children}
      </div>
    </div>
  );
}

function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value);
  React.useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);
    return () => clearTimeout(handler);
  }, [value, delay]);
  return debouncedValue;
}

export default function BusinessAnalytics() {
  const navigate = useNavigate();

  const [filterDrawerOpen, setFilterDrawerOpen] = useState(false);

  const [searchInput, setSearchInput] = useState('');
  const [icrisInput, setIcrisInput] = useState('');
  const [showAllCountries, setShowAllCountries] = useState(false);
  const [showAllAEs, setShowAllAEs] = useState(false);
  
  const debouncedSearch = useDebounce(searchInput, 400);
  const debouncedIcris = useDebounce(icrisInput, 400);

  const [filters, setFilters] = useState({
    timeframe: 'this_month',
    dateFrom: '',
    dateTo: '',
    compareMode: 'pop',
    revenueTier: 'all',
    customerStatus: 'all',
    ae: '',
    country: '',
    minRevenue: '',
    maxRevenue: '',
    growthTrend: 'all',
    sortBy: 'revenue_desc',
  });

  const updateFilter = (key: string, value: any) => setFilters(f => ({ ...f, [key]: value }));
  const resetFilters = () => {
    setSearchInput('');
    setIcrisInput('');
    setFilters({
      timeframe: 'this_month',
      dateFrom: '', dateTo: '', compareMode: 'pop',
      revenueTier: 'all', customerStatus: 'all',
      ae: '', country: '', minRevenue: '', maxRevenue: '', growthTrend: 'all', sortBy: 'revenue_desc',
    });
  };

  const activeFilterCount = (filters.revenueTier !== 'all' ? 1 : 0) + (filters.customerStatus !== 'all' ? 1 : 0)
    + (filters.ae ? 1 : 0) + (filters.country ? 1 : 0) + (filters.minRevenue !== '' ? 1 : 0) + (filters.maxRevenue !== '' ? 1 : 0)
    + (filters.growthTrend !== 'all' ? 1 : 0) + (debouncedSearch ? 1 : 0) + (debouncedIcris ? 1 : 0);

  const { data: d, isLoading, isFetching } = useQuery({
    queryKey: ['analytics', filters.timeframe, filters.dateFrom, filters.dateTo, filters.compareMode],
    queryFn: () => api.getExecutiveDashboard({
      timeframe: filters.timeframe,
      date_from: (filters.timeframe === 'custom' && filters.dateFrom) ? filters.dateFrom : undefined,
      date_to: (filters.timeframe === 'custom' && filters.dateTo) ? filters.dateTo : undefined,
      compare_mode: filters.compareMode
    }),
  });

  const analyticsData = useMemo(() => {
    if (!d?.revenue_analytics?.all_customers) return null;

    let base = d.revenue_analytics.all_customers.map((c: any) => {
      const g = d.revenue_analytics.growth_matrix?.find((gm: any) => gm.company_id === c.company_id) || {};
      return { 
        ...c, 
        growth: g.pct_growth || 0,
        prevRevenue: g.prev_revenue || 0,
        isNew: !!g.is_new,
        diff: g.diff || 0,
        status: g.is_new ? 'New' : (g.prev_revenue > 0 && c.revenue === 0 ? 'Dormant' : ((g.prev_revenue || 0) === 0 && c.revenue === 0 ? 'No Activity' : 'Active')),
        billType: c.revenue > 10000 ? 'Postpaid' : 'Prepaid',
      };
    });

    if (debouncedSearch) {
      const q = debouncedSearch.toLowerCase();
      base = base.filter((c: any) => c.company_name?.toLowerCase().includes(q) || c.icris_number?.toLowerCase().includes(q));
    }
    if (debouncedIcris) base = base.filter((c: any) => c.icris_number?.toLowerCase().includes(debouncedIcris.toLowerCase()));
    if (filters.customerStatus !== 'all') base = base.filter((c: any) => c.status.toLowerCase() === filters.customerStatus.toLowerCase());
    if (filters.revenueTier !== 'all') {
      const t = SEGMENTS.find((x) => x.id === filters.revenueTier);
      if (t) base = base.filter((c: any) => c.segment === t.id);
    }
    if (filters.ae) base = base.filter((c: any) => (c.ae_code || 'UNASSIGNED') === filters.ae);
    if (filters.country) base = base.filter((c: any) => (c.country || 'Unknown') === filters.country);
    if (filters.minRevenue !== '') base = base.filter((c: any) => c.revenue >= Number(filters.minRevenue));
    if (filters.maxRevenue !== '') base = base.filter((c: any) => c.revenue <= Number(filters.maxRevenue));

    // Counted before the growth-trend filter itself, so the button labels always
    // reflect the full set matched by every OTHER active filter, not just whichever trend is selected.
    const growingCount = base.filter((c: any) => c.growth > 0).length;
    const decliningCount = base.filter((c: any) => c.growth < 0).length;

    if (filters.growthTrend === 'growing') base = base.filter((c: any) => c.growth > 0);
    else if (filters.growthTrend === 'declining') base = base.filter((c: any) => c.growth < 0);
    else if (filters.growthTrend === 'flat') base = base.filter((c: any) => c.growth === 0);

    const SORTERS: Record<string, (a: any, b: any) => number> = {
      revenue_desc: (a, b) => b.revenue - a.revenue,
      revenue_asc: (a, b) => a.revenue - b.revenue,
      shipments_desc: (a, b) => b.shipments - a.shipments,
      growth_desc: (a, b) => b.diff - a.diff,
      growth_asc: (a, b) => a.diff - b.diff,
      name_asc: (a, b) => (a.company_name || '').localeCompare(b.company_name || ''),
      recent: (a, b) => new Date(b.last_shipment_date || 0).getTime() - new Date(a.last_shipment_date || 0).getTime(),
    };
    if (filters.sortBy === 'revenue_asc') base = base.filter((c: any) => c.revenue > 0);
    base.sort(SORTERS[filters.sortBy] || SORTERS.revenue_desc);

    const revTotal = base.reduce((sum: number, c: any) => sum + c.revenue, 0);
    const shipTotal = base.reduce((sum: number, c: any) => sum + c.shipments, 0);
    const weightTotal = base.reduce((sum: number, c: any) => sum + (c.weight || 0), 0);

    const countryMap = base.reduce((acc: any, c: any) => {
      const cnt = c.country || 'Unknown';
      if (!acc[cnt]) acc[cnt] = 0;
      acc[cnt] += c.revenue;
      return acc;
    }, {});
    const countries = Object.entries(countryMap).map(([name, rev]) => ({ name, revenue: rev as number })).sort((a,b) => b.revenue - a.revenue);

    const aeMap = base.reduce((acc: any, c: any) => {
      const ae = c.ae_code || 'UNASSIGNED';
      if (!acc[ae]) acc[ae] = 0;
      acc[ae] += c.revenue;
      return acc;
    }, {});
    const aes = Object.entries(aeMap).map(([name, rev]) => ({ name, revenue: rev as number })).sort((a,b) => b.revenue - a.revenue);

    const top10Rev = base.slice(0, 10).reduce((sum: number, c: any) => sum + c.revenue, 0);
    const othersRev = revTotal - top10Rev;
    const concentrationData = [
      { name: 'Top 10 Accounts', value: top10Rev },
      { name: 'All Other Accounts', value: Math.max(0, othersRev) }
    ].filter(d => d.value > 0);

    // Excludes 'No Activity' — accounts that have never shipped with us in either period
    // aren't a status worth charting here, they'd just dwarf every real slice (900+ of ~1000
    // total customers). The filter dropdown and data grid still let you find them explicitly.
    const statusMap = base.reduce((acc: any, c: any) => {
      if (c.status === 'No Activity') return acc;
      acc[c.status] = (acc[c.status] || 0) + 1;
      return acc;
    }, {});
    const statuses = Object.entries(statusMap).map(([name, val]) => ({ name, value: val }));

    const confirmedCount = base.filter((c: any) => !c.is_provisional).length;

    return { base, revTotal, shipTotal, weightTotal, countries, aes, concentrationData, statuses, confirmedCount, growingCount, decliningCount };
  }, [d, filters, debouncedSearch, debouncedIcris]);

  const uniqueCountries = useMemo(() => {
    if (!d?.revenue_analytics?.all_customers) return [];
    const s = new Set(d.revenue_analytics.all_customers.map((c:any) => c.country || 'Unknown'));
    return Array.from(s).sort();
  }, [d]);

  const uniqueAEs = useMemo(() => {
    if (!d?.revenue_analytics?.all_customers) return [];
    const s = new Set(d.revenue_analytics.all_customers.map((c:any) => c.ae_code || 'UNASSIGNED'));
    return Array.from(s).sort();
  }, [d]);

  if (isLoading || !d) {
    return (
      <div className="flex-1 bg-background flex items-center justify-center min-h-[600px]">
        <div className="flex flex-col items-center gap-3 bg-white p-10 rounded-2xl shadow-sm border border-[#E2E8F0]">
          <RefreshCw className="animate-spin text-primary" size={32} />
          <span className="font-semibold text-slate-700 text-sm">Loading BI Workspace...</span>
        </div>
      </div>
    );
  }

  if (!analyticsData) return null;
  const { base, revTotal, shipTotal, countries, aes, concentrationData, statuses, confirmedCount, growingCount, decliningCount } = analyticsData;

  const fmt$ = (v: number) => `$${v >= 1000 ? (v/1000).toFixed(1) + 'k' : v.toLocaleString(undefined, { maximumFractionDigits: 1 })}`;
  const fmtNum = (v: number) => v.toLocaleString();

  const trendData = (d.billing_analytics?.trend || []).map((t: any) => ({
    date: t.period.length >= 10 ? t.period.substring(5, 10) : t.period,
    revenue: t.total_amount, shipments: t.invoice_count,
  }));

  const echartTooltip = { backgroundColor: '#fff', borderColor: '#e2e8f0', textStyle: { color: '#0f172a', fontSize: 12, fontFamily: 'inherit' }, padding: [8, 12] };

  const getActiveFilterChips = () => {
    const chips = [];
    if (filters.timeframe !== 'this_month') {
      const timeLabel = filters.timeframe === 'custom' && filters.dateFrom && filters.dateTo
        ? `${fmtShortDate(filters.dateFrom)} – ${fmtShortDate(filters.dateTo)}`
        : (TIMEFRAME_LABELS[filters.timeframe] || filters.timeframe);
      chips.push({ key: 'timeframe', label: `Period: ${timeLabel}` });
    }
    if (debouncedSearch) chips.push({ key: 'customerSearch', label: `Customer: ${debouncedSearch}` });
    if (debouncedIcris) chips.push({ key: 'icrisSearch', label: `ICRIS: ${debouncedIcris}` });
    if (filters.revenueTier !== 'all') chips.push({ key: 'revenueTier', label: `Segment: ${SEGMENTS.find(t => t.id === filters.revenueTier)?.label}` });
    if (filters.customerStatus !== 'all') chips.push({ key: 'customerStatus', label: `Status: ${filters.customerStatus}` });
    if (filters.ae) chips.push({ key: 'ae', label: `AE: ${filters.ae}` });
    if (filters.country) chips.push({ key: 'country', label: `Country: ${filters.country}` });
    if (filters.minRevenue !== '' || filters.maxRevenue !== '') {
      const lo = filters.minRevenue !== '' ? fmt$(Number(filters.minRevenue)) : '$0';
      const hi = filters.maxRevenue !== '' ? fmt$(Number(filters.maxRevenue)) : '∞';
      chips.push({ key: 'revenueRange', label: `Revenue: ${lo} – ${hi}` });
    }
    if (filters.growthTrend !== 'all') chips.push({ key: 'growthTrend', label: `Trend: ${filters.growthTrend[0].toUpperCase()}${filters.growthTrend.slice(1)}` });
    return chips;
  };

  const activeChips = getActiveFilterChips();
  const hasNarrowingFilter = !!debouncedSearch || !!debouncedIcris || filters.revenueTier !== 'all' || filters.customerStatus !== 'all'
    || !!filters.ae || !!filters.country || filters.minRevenue !== '' || filters.maxRevenue !== '' || filters.growthTrend !== 'all';
  const prefix = hasNarrowingFilter ? 'Filtered' : 'Total';

  return (
    <div className="flex-1 overflow-y-auto bg-background relative">
      {isFetching && <div className="h-0.5 bg-gradient-to-r from-blue-400 via-indigo-500 to-blue-600 animate-pulse w-full sticky top-0 z-50" />}

      {/* ──────────────────────────────────────────────────────────────────── */}
      {/*  SLIDE-OVER FILTER DRAWER                                            */}
      {/* ──────────────────────────────────────────────────────────────────── */}
      {filterDrawerOpen && (
        <>
          {/* Backdrop */}
          <div 
            onClick={() => setFilterDrawerOpen(false)} 
            className="fixed inset-0 bg-slate-900/30 backdrop-blur-xs z-40 transition-opacity"
          />

          {/* Drawer Panel */}
          <aside className="fixed inset-y-0 right-0 z-50 w-[320px] bg-white border-l border-[#E2E8F0] shadow-2xl flex flex-col animate-in slide-in-from-right duration-200">
            {/* Drawer Header */}
            <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50/50 shrink-0">
              <div className="flex items-center gap-2">
                <Filter size={16} className="text-primary" />
                <span className="text-sm font-bold text-slate-900 tracking-tight">Workspace Filters</span>
              </div>
              <button 
                onClick={() => setFilterDrawerOpen(false)}
                className="p-1 text-slate-400 hover:text-slate-700 rounded-md hover:bg-slate-100 transition-colors"
              >
                <X size={16} />
              </button>
            </div>

            {/* Drawer Body */}
            <div className="flex-1 overflow-y-auto px-5 py-3 space-y-1">
              
              {/* CUSTOMERS */}
              <CollapsibleSection title="Customers" icon={Users}>
                <FilterGroup label="Search Company">
                  <div className="relative">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" size={13} />
                    <input type="text" placeholder="Name or ICRIS..." value={searchInput} onChange={(e) => setSearchInput(e.target.value)} className={`${inputCls} pl-8`} />
                  </div>
                </FilterGroup>

                <FilterGroup label="Customer Status">
                  <DropdownWrapper>
                    <select value={filters.customerStatus} onChange={(e) => updateFilter('customerStatus', e.target.value)} className={selectCls}>
                      <option value="all">All Statuses</option>
                      <option value="active">Active</option>
                      <option value="new">New</option>
                      <option value="dormant">Dormant</option>
                      <option value="no activity">No Activity</option>
                    </select>
                  </DropdownWrapper>
                </FilterGroup>

                <FilterGroup label="Customer Segment">
                  <div className="flex flex-wrap gap-1">
                    {SEGMENTS.map((tier) => (
                      <button
                        key={tier.id}
                        onClick={() => updateFilter('revenueTier', tier.id)}
                        className={`px-2 py-1 rounded text-[10px] font-bold border transition-colors ${
                          filters.revenueTier === tier.id ? 'bg-slate-900 border-slate-900 text-white' : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                        }`}
                      >
                        {tier.label}
                      </button>
                    ))}
                  </div>
                </FilterGroup>
              </CollapsibleSection>

              {/* OWNERSHIP & GEOGRAPHY */}
              <CollapsibleSection title="Ownership & Geography" icon={Briefcase}>
                <FilterGroup label="Account Executive">
                  <DropdownWrapper>
                    <select value={filters.ae} onChange={(e) => updateFilter('ae', e.target.value)} className={selectCls}>
                      <option value="">All AEs</option>
                      {uniqueAEs.map((ae: string) => <option key={ae} value={ae}>{ae}</option>)}
                    </select>
                  </DropdownWrapper>
                </FilterGroup>

                <FilterGroup label="Destination Country">
                  <DropdownWrapper>
                    <select value={filters.country} onChange={(e) => updateFilter('country', e.target.value)} className={selectCls}>
                      <option value="">All Countries</option>
                      {uniqueCountries.map((c: string) => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </DropdownWrapper>
                </FilterGroup>
              </CollapsibleSection>

              {/* PERFORMANCE & GROWTH */}
              <CollapsibleSection title="Performance & Growth" icon={TrendingUp}>
                <FilterGroup label="Revenue Range">
                  <div className="flex items-center gap-2">
                    <div className="relative flex-1">
                      <DollarSign className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" size={12} />
                      <input
                        type="number" min="0" placeholder="Min" value={filters.minRevenue}
                        onChange={(e) => updateFilter('minRevenue', e.target.value)}
                        className={`${inputCls} pl-6`}
                      />
                    </div>
                    <span className="text-slate-300 text-xs font-bold">–</span>
                    <div className="relative flex-1">
                      <DollarSign className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" size={12} />
                      <input
                        type="number" min="0" placeholder="Max" value={filters.maxRevenue}
                        onChange={(e) => updateFilter('maxRevenue', e.target.value)}
                        className={`${inputCls} pl-6`}
                      />
                    </div>
                  </div>
                </FilterGroup>

                <FilterGroup label="Revenue Trend">
                  <div className="flex flex-wrap gap-1">
                    {[
                      { id: 'all', label: 'All' },
                      { id: 'growing', label: `Growing (${growingCount})` },
                      { id: 'declining', label: `Declining (${decliningCount})` },
                      { id: 'flat', label: 'Flat' },
                    ].map((t) => (
                      <button
                        key={t.id}
                        onClick={() => updateFilter('growthTrend', t.id)}
                        className={`px-2 py-1 rounded text-[10px] font-bold border transition-colors ${
                          filters.growthTrend === t.id ? 'bg-slate-900 border-slate-900 text-white' : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                        }`}
                      >
                        {t.label}
                      </button>
                    ))}
                  </div>
                  <p className="text-[10px] text-slate-400 font-medium mt-1">Compares revenue to the equivalent prior period.</p>
                </FilterGroup>
              </CollapsibleSection>
            </div>

            {/* Drawer Footer Actions */}
            <div className="p-4 border-t border-slate-200 bg-slate-50 flex flex-col gap-2 shrink-0">
              <div className="grid grid-cols-3 gap-2 text-center bg-white rounded-lg border border-slate-200 p-2">
                <div>
                  <p className="text-sm font-black text-slate-900">{base.length}</p>
                  <p className="text-[9px] font-bold uppercase tracking-wider text-slate-400">of {d.revenue_analytics?.all_customers?.length ?? base.length} match</p>
                </div>
                <div className="border-x border-slate-100">
                  <p className="text-sm font-black text-slate-900">{fmt$(revTotal)}</p>
                  <p className="text-[9px] font-bold uppercase tracking-wider text-slate-400">revenue</p>
                </div>
                <div>
                  <p className="text-sm font-black text-slate-900">
                    <span className="text-emerald-600">{growingCount}↑</span> <span className="text-rose-600">{decliningCount}↓</span>
                  </p>
                  <p className="text-[9px] font-bold uppercase tracking-wider text-slate-400">trend</p>
                </div>
              </div>
              <div className="flex items-center justify-between gap-3 pt-1">
                <button
                  onClick={resetFilters}
                  className="px-3 py-2 text-xs font-bold text-slate-600 hover:text-rose-600 transition-colors"
                >
                  Reset Filters
                </button>
                <button
                  onClick={() => setFilterDrawerOpen(false)}
                  className="px-5 py-2 bg-primary hover:bg-blue-700 text-white font-bold text-xs rounded-lg shadow-sm transition-all"
                >
                  Apply Filters
                </button>
              </div>
            </div>
          </aside>
        </>
      )}

      {/* ──────────────────────────────────────────────────────────────────── */}
      {/*  MAIN WORKSPACE CONTENT                                              */}
      {/* ──────────────────────────────────────────────────────────────────── */}
      <div className="max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
        
        {/* PAGE HEADER SECTION */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h1 className="text-xl sm:text-2xl font-black text-slate-900 tracking-tight">Revenue Analytics</h1>
            <p className="mt-1 text-xs sm:text-sm text-slate-500 font-medium">
              Showing <span className="font-bold text-slate-900">{base.length}</span> Customers · <span className="font-bold text-slate-900">{shipTotal}</span> Shipments · <span className="font-bold text-slate-900">{fmt$(revTotal)}</span> Revenue
              {d.bounds?.c_start && d.bounds?.c_end && (
                <> · <span className="font-bold text-slate-900">{fmtShortDate(d.bounds.c_start)} – {fmtShortDate(d.bounds.c_end)}</span></>
              )}
            </p>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <DateRangeControl
              timeframe={filters.timeframe}
              dateFrom={filters.dateFrom}
              dateTo={filters.dateTo}
              bounds={d.bounds}
              onPreset={(value) => { updateFilter('timeframe', value); updateFilter('dateFrom', ''); updateFilter('dateTo', ''); }}
              onCustom={(from, to) => { updateFilter('timeframe', 'custom'); updateFilter('dateFrom', from); updateFilter('dateTo', to); }}
            />
            <CompareModeSelect icon={Activity} value={filters.compareMode} onChange={(e) => updateFilter('compareMode', e.target.value)} />
            <button
              onClick={() => setFilterDrawerOpen(true)}
              className="flex items-center gap-2 px-3.5 py-2 bg-white border border-[#DCE3EC] text-xs font-bold text-slate-800 hover:bg-slate-50 rounded-lg shadow-xs transition-colors relative"
            >
              <Filter size={14} className="text-primary" />
              <span>Filters</span>
              {activeFilterCount > 0 && (
                <span className="w-5 h-5 bg-primary text-white text-[10px] font-black rounded-full flex items-center justify-center -mr-1">
                  {activeFilterCount}
                </span>
              )}
            </button>

          </div>
        </div>

        {/* ACTIVE FILTER CHIPS BAR */}
        {activeChips.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            {activeChips.map(chip => (
              <span key={chip.key} className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-white border border-[#DCE3EC] rounded-full text-xs font-medium text-slate-700 shadow-xs">
                {chip.label}
                <button
                  onClick={() => {
                    if (chip.key === 'customerSearch') setSearchInput('');
                    else if (chip.key === 'icrisSearch') setIcrisInput('');
                    else if (chip.key === 'timeframe') { updateFilter('timeframe', 'this_month'); updateFilter('dateFrom', ''); updateFilter('dateTo', ''); }
                    else if (chip.key === 'ae' || chip.key === 'country') updateFilter(chip.key, '');
                    else if (chip.key === 'revenueRange') { updateFilter('minRevenue', ''); updateFilter('maxRevenue', ''); }
                    else updateFilter(chip.key, 'all');
                  }}
                  className="text-slate-400 hover:text-rose-500 transition-colors"
                >
                  <X size={12} />
                </button>
              </span>
            ))}
            <button onClick={resetFilters} className="text-xs font-semibold text-rose-500 hover:text-rose-700 ml-1 transition-colors">
              Clear All
            </button>
          </div>
        )}

        {/* KPI CARDS GRID */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-5">
          <KpiCard title={`${prefix} Revenue`} value={fmt$(revTotal)} icon={DollarSign} trend={d.kpi_cards?.total_billing?.pop_pct} className="border-t-2 border-t-emerald-500/80" />
          <KpiCard title={`${prefix} Accounts`} value={fmtNum(confirmedCount)} icon={Users} trend={d.kpi_cards?.active_customers?.pop_pct} className="border-t-2 border-t-blue-500/80" />
          <KpiCard title={`${prefix} Shipments`} value={fmtNum(shipTotal)} icon={Package} className="border-t-2 border-t-indigo-500/80" />
          <KpiCard title="Avg Rev / Customer" value={fmt$(base.length > 0 ? revTotal/base.length : 0)} icon={TrendingUp} trend={d.kpi_cards?.avg_revenue_per_customer?.pop_pct} className="border-t-2 border-t-purple-500/80" />
        </div>

        {/* CHARTS GRID (2-COLUMN EXPANDED VIEWPORT) */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Revenue Trajectory */}
          <ChartWrapper title="Revenue Trajectory (Timeframe)">
            <ReactECharts 
              option={{
                tooltip: { ...echartTooltip, trigger: 'axis' },
                grid: { top: 20, right: 15, bottom: 25, left: 55 },
                xAxis: { type: 'category', data: trendData.map(d => d.date) },
                yAxis: { type: 'value', axisLabel: { formatter: (val:any) => `$${val/1000}k` } },
                series: [{ type: 'line', areaStyle: { color: 'rgba(37, 99, 235, 0.08)' }, data: trendData.map(d => d.revenue), smooth: true, itemStyle: { color: '#2563EB' } }]
              }}
              style={{ height: '100%', width: '100%', minHeight: '360px' }}
            />
          </ChartWrapper>

          {/* Shipment Volume */}
          <ChartWrapper title="Shipment Volume (Timeframe)">
            <ReactECharts 
              option={{
                tooltip: { ...echartTooltip, trigger: 'axis' },
                grid: { top: 20, right: 15, bottom: 25, left: 45 },
                xAxis: { type: 'category', data: trendData.map(d => d.date) },
                yAxis: { type: 'value' },
                series: [{ type: 'bar', data: trendData.map(d => d.shipments), itemStyle: { color: '#6366F1', borderRadius: [4, 4, 0, 0] } }]
              }}
              style={{ height: '100%', width: '100%', minHeight: '360px' }}
            />
          </ChartWrapper>

          {/* Revenue by Destination Table */}
          <ChartWrapper title={`${prefix} Revenue by Destination`}>
            {countries.length > 0 ? (
              <div className="h-full flex flex-col">
                <div className={`overflow-x-auto flex-1 ${showAllCountries ? 'overflow-y-auto max-h-[280px]' : ''}`}>
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-50 border-b border-slate-200 sticky top-0">
                      <tr className="text-[10px] uppercase font-bold tracking-wider text-slate-500">
                        <th className="px-3 py-2 text-left">Destination</th>
                        <th className="px-3 py-2 text-right">Revenue</th>
                        <th className="px-3 py-2 text-right">% Total</th>
                        <th className="px-3 py-2 text-left w-1/3">Share</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 font-medium">
                      {(showAllCountries ? countries : countries.slice(0, 10)).map((item: any, i: number) => {
                        const maxRev = countries[0]?.revenue || 1;
                        const pctOfMax = (item.revenue / maxRev) * 100;
                        const pctOfTotal = revTotal > 0 ? ((item.revenue / revTotal) * 100).toFixed(1) : '0';

                        return (
                          <tr key={i} className="transition-colors">
                            <td className="px-3 py-2 font-bold text-slate-900">{item.name}</td>
                            <td className="px-3 py-2 font-black text-slate-900 text-right">{fmt$(item.revenue)}</td>
                            <td className="px-3 py-2 text-slate-500 text-right text-[11px] font-semibold">{pctOfTotal}%</td>
                            <td className="px-3 py-2">
                              <div className="w-full bg-slate-100 h-2.5 rounded-full overflow-hidden">
                                <div
                                  className="bg-blue-600 h-full rounded-full transition-all duration-300"
                                  style={{ width: `${Math.max(pctOfMax, 4)}%` }}
                                />
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {countries.length > 10 && (
                  <button
                    onClick={() => setShowAllCountries(v => !v)}
                    className="pt-2 text-xs font-bold text-primary hover:underline text-center shrink-0"
                  >
                    {showAllCountries ? 'View Less' : `View More (${countries.length - 10} more)`}
                  </button>
                )}
              </div>
            ) : <div className="absolute inset-0 flex items-center justify-center text-slate-400 text-xs font-bold">No data</div>}
          </ChartWrapper>

          {/* Revenue by Account Executive Table */}
          <ChartWrapper title={`${prefix} Revenue by Account Executive`}>
            {aes.length > 0 ? (
              <div className="h-full flex flex-col">
                <div className={`overflow-x-auto flex-1 ${showAllAEs ? 'overflow-y-auto max-h-[280px]' : ''}`}>
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 border-b border-slate-200 sticky top-0">
                    <tr className="text-[10px] uppercase font-bold tracking-wider text-slate-500">
                      <th className="px-3 py-2 text-left">Account Executive</th>
                      <th className="px-3 py-2 text-right">Revenue</th>
                      <th className="px-3 py-2 text-right">% Total</th>
                      <th className="px-3 py-2 text-left w-1/3">Share</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 font-medium">
                    {(showAllAEs ? aes : aes.slice(0, 10)).map((item: any, i: number) => {
                      const maxRev = aes[0]?.revenue || 1;
                      const pctOfMax = (item.revenue / maxRev) * 100;
                      const pctOfTotal = revTotal > 0 ? ((item.revenue / revTotal) * 100).toFixed(1) : '0';

                      return (
                        <tr key={i} className="transition-colors">
                          <td className="px-3 py-2 font-bold text-slate-900">{item.name}</td>
                          <td className="px-3 py-2 font-black text-slate-900 text-right">{fmt$(item.revenue)}</td>
                          <td className="px-3 py-2 text-slate-500 text-right text-[11px] font-semibold">{pctOfTotal}%</td>
                          <td className="px-3 py-2">
                            <div className="w-full bg-slate-100 h-2.5 rounded-full overflow-hidden">
                              <div
                                className="bg-blue-600 h-full rounded-full transition-all duration-300"
                                style={{ width: `${Math.max(pctOfMax, 4)}%` }}
                              />
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                </div>
                {aes.length > 10 && (
                  <button
                    onClick={() => setShowAllAEs(v => !v)}
                    className="pt-2 text-xs font-bold text-primary hover:underline text-center shrink-0"
                  >
                    {showAllAEs ? 'View Less' : `View More (${aes.length - 10} more)`}
                  </button>
                )}
              </div>
            ) : <div className="absolute inset-0 flex items-center justify-center text-slate-400 text-xs font-bold">No data</div>}
          </ChartWrapper>

          {/* Customer Status Distribution */}
          <ChartWrapper title={`${prefix} Customer Status Distribution`}>
            <p className="text-[10px] text-slate-400 font-medium -mt-3 mb-2">Excludes accounts that have never shipped with us — see them via the Customer Status filter.</p>
            {statuses.length > 0 ? (
              <ReactECharts 
                option={{
                  tooltip: { ...echartTooltip, trigger: 'item' },
                  legend: { bottom: 0, icon: 'circle', textStyle: { fontSize: 11, fontWeight: 'bold' } },
                  series: [{ type: 'pie', radius: ['45%', '72%'], data: statuses, itemStyle: { borderColor: '#fff', borderWidth: 2 }, label: { show: false }, labelLine: { show: false } }]
                }}
                style={{ height: '100%', width: '100%', minHeight: '360px' }}
              />
            ) : <div className="absolute inset-0 flex items-center justify-center text-slate-400 text-xs font-bold">No data</div>}
          </ChartWrapper>

          {/* Revenue Concentration */}
          <ChartWrapper title={`${prefix} Revenue Concentration`}>
            {concentrationData.length > 0 ? (
              <ReactECharts 
                option={{
                  tooltip: { ...echartTooltip, trigger: 'item', formatter: (params: any) => `${params.name}: $${params.value >= 1000 ? (params.value/1000).toFixed(1)+'k' : params.value.toLocaleString()} (${params.percent}%)` },
                  legend: { bottom: 0, icon: 'circle', textStyle: { fontSize: 11, fontWeight: 'bold' } },
                  series: [{
                    type: 'pie',
                    radius: ['45%', '72%'],
                    data: concentrationData,
                    itemStyle: { borderColor: '#fff', borderWidth: 2 },
                    color: ['#0F766E', '#94A3B8'],
                    label: { show: false },
                    labelLine: { show: false }
                  }]
                }}
                style={{ height: '100%', width: '100%', minHeight: '360px' }}
              />
            ) : <div className="absolute inset-0 flex items-center justify-center text-slate-400 text-xs font-bold">No data</div>}
          </ChartWrapper>
        </div>

        {/* INTERACTIVE DATA GRID */}
        <div className="bg-white rounded-[16px] border border-slate-100 overflow-hidden flex flex-col card-glow">
          <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50/80 gap-4">
            <div>
              <h3 className="text-sm font-bold text-slate-900">Interactive Customer Data Grid</h3>
              <p className="text-xs font-medium text-slate-500 mt-0.5">Top 10 of {base.length} matching accounts, by current sort. Click a row for full details.</p>
            </div>
            <DropdownWrapper>
              <select value={filters.sortBy} onChange={(e) => updateFilter('sortBy', e.target.value)} className={`${selectCls} min-w-[170px]`}>
                <option value="revenue_desc">Sort: Revenue (High → Low)</option>
                <option value="revenue_asc">Sort: Revenue (Low → High)</option>
                <option value="shipments_desc">Sort: Most Shipments</option>
                <option value="growth_desc">Sort: Fastest Growing</option>
                <option value="growth_asc">Sort: Fastest Declining</option>
                <option value="recent">Sort: Most Recent Activity</option>
                <option value="name_asc">Sort: Company Name (A–Z)</option>
              </select>
            </DropdownWrapper>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs whitespace-nowrap">
              <thead className="bg-slate-50/80 border-b border-slate-200">
                <tr className="text-[10px] uppercase font-bold tracking-widest text-slate-500">
                  <th className="px-5 py-3 text-left">Company</th>
                  <th className="px-4 py-3 text-left">ICRIS</th>
                  <th className="px-4 py-3 text-right">Revenue</th>
                  <th className="px-4 py-3 text-right">Trend</th>
                  <th className="px-4 py-3 text-right">AWBs</th>
                  <th className="px-4 py-3 text-right">Packages</th>
                  <th className="px-4 py-3 text-right">Weight</th>
                  <th className="px-4 py-3 text-left">Country</th>
                  <th className="px-4 py-3 text-left">AE</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {base.length > 0 ? (
                  base.slice(0, 10).map((row: any, i: number) => (
                    <tr
                      key={row.company_id || i}
                      onClick={() => navigate(`/app/customers/${row.company_id}`)}
                      className="transition-colors group cursor-pointer hover:bg-slate-50"
                    >
                      <td className="px-5 py-3 font-semibold text-slate-900 max-w-[200px] truncate" title={row.company_name}>{row.company_name}</td>
                      <td className="px-4 py-3 font-mono text-slate-500">{row.icris_number || '—'}</td>
                      <td className="px-4 py-3 font-black text-slate-900 text-right">{fmt$(row.revenue)}</td>
                      <td className="px-4 py-3 text-right">
                        {row.prevRevenue === 0 && row.revenue > 0 ? (
                          row.isNew
                            ? <span className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase bg-blue-100 text-blue-700">New</span>
                            : <span className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase bg-amber-100 text-amber-700">Returning</span>
                        ) :row.revenue === 0 && row.prevRevenue > 0 ? (
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase bg-rose-100 text-rose-700">Lost</span>
                        ) : row.growth !== 0 ? (
                          <div className="inline-flex flex-col items-end">
                            <span className={`inline-flex items-center gap-0.5 font-bold ${row.growth > 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                              {row.growth > 0 ? <ArrowUpRight size={11} /> : <ArrowDownRight size={11} />}
                              {Math.abs(row.growth) > 999 ? '>999' : Math.abs(row.growth).toFixed(0)}%
                            </span>
                            <span className="text-[10px] text-slate-400">{row.diff > 0 ? '+' : '−'}{fmt$(Math.abs(row.diff))}</span>
                          </div>
                        ) : <span className="text-slate-400">—</span>}
                      </td>
                      <td className="px-4 py-3 text-slate-600 font-medium text-right">{row.shipments || 0}</td>
                      <td className="px-4 py-3 text-slate-600 font-medium text-right">{row.pieces || 0}</td>
                      <td className="px-4 py-3 text-slate-600 font-medium text-right">{row.weight ? `${row.weight} kg` : '—'}</td>
                      <td className="px-4 py-3 text-slate-600 truncate max-w-[120px]">{row.country || 'Unknown'}</td>
                      <td className="px-4 py-3 text-slate-600 truncate max-w-[100px]">{row.ae_code || 'UNASSIGNED'}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={9} className="px-5 py-24 text-center">
                      <div className="flex flex-col items-center justify-center text-slate-400">
                        <Search size={32} className="mb-3 text-slate-300" />
                        <p className="text-sm font-bold text-slate-600 mb-1">No data found</p>
                        <p className="text-xs">Adjust your workspace filters to see results.</p>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="h-6" />
      </div>
    </div>
  );
}
