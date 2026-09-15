import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import ReactECharts from 'echarts-for-react';
import {
  RefreshCw, DollarSign, TrendingUp, TrendingDown,
  ArrowRight, Percent, Route as RouteIcon, Users, Clock,
} from 'lucide-react';
import { api } from '@/api';
import { KpiCard } from '@/components/KpiCard';
import { DateRangeControl } from '@/components/AnalyticsFilterBar';

function addDays(iso: string, n: number) { const d = new Date(`${iso}T00:00:00`); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); }
function daysBetween(a: string, b: string) { return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000); }
const fmt$ = (v: number) => `$${(v || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmt$Compact = (v: number) => `$${(v || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
function fmtDate(d: string | null) {
  if (!d) return '-';
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
function pctChange(current: number, previous: number): number | undefined {
  if (!previous) return undefined;
  return Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10;
}

// Validated categorical triple (dataviz skill: fixed order, slots 1-2-3) — Bill / UPS Cost / Profit share one $ axis.
const COLOR_BILL = '#3b82f6';
const COLOR_UPS = '#f59e0b';
const COLOR_PROFIT = '#10b981';
const COLOR_LOSS = '#ef4444';

export default function Profitability() {
  const navigate = useNavigate();
  // Same timeframe control as the rest of the analytics suite (Rankings, AE Performance,
  // Executive Overview, ...) instead of a bespoke date pair — 'timeframe' resolves server-side
  // via get_timeframe_bounds; 'custom' sends the explicit dates below.
  const [timeframe, setTimeframe] = useState('last_30_days');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [offset, setOffset] = useState(0);
  const [sortKey, setSortKey] = useState<'manifest_date' | 'margin'>('manifest_date');
  const [customerSort, setCustomerSort] = useState<'profit' | 'margin' | 'loss'>('profit');
  const limit = 25;

  // Same fix as Rankings.tsx: `timeframe` must still be sent as 'custom' here too, or the
  // backend's default `timeframe` kicks in and the custom date_from/date_to are ignored.
  const tfParams = timeframe === 'custom' ? { timeframe: 'custom', date_from: customFrom, date_to: customTo } : { timeframe };

  // The one query that resolves the timeframe into literal dates (same trick Rankings uses with
  // top-customers) — every other query on this page waits on its result rather than re-deriving
  // date math client-side.
  const customersQuery = useQuery({
    queryKey: ['customerProfitability', timeframe, customFrom, customTo, customerSort],
    queryFn: () => api.getCustomerProfitability({ ...tfParams, sort: customerSort, limit: 12 }),
    enabled: timeframe !== 'custom' || (!!customFrom && !!customTo),
  });

  const dateFrom = customersQuery.data?.date_from || '';
  const dateTo = customersQuery.data?.date_to || '';
  const hasRange = !!dateFrom && !!dateTo;

  // Exclusive day count (Aug 1 - Aug 30 -> 29) -- deliberately kept this way for the
  // internal date math below (granularity threshold, previous-period window length),
  // which just needs a consistent span, not a human-readable count. Display text uses
  // rangeDaysLabel (the inclusive, "30-day period" version) instead.
  const rangeDays = hasRange ? daysBetween(dateFrom, dateTo) : 0;
  const rangeDaysLabel = rangeDays + 1;
  const granularity: 'day' | 'week' | 'month' = rangeDays <= 45 ? 'day' : rangeDays <= 200 ? 'week' : 'month';

  // Period-over-period comparison window: the same number of days immediately preceding dateFrom.
  const prevDateTo = hasRange ? addDays(dateFrom, -1) : '';
  const prevDateFrom = hasRange ? addDays(prevDateTo, -rangeDays) : '';

  const summaryQuery = useQuery({
    queryKey: ['mawbPnlSummary', dateFrom, dateTo],
    queryFn: () => api.getMawbPnlSummary({ manifest_date_from: dateFrom, manifest_date_to: dateTo }),
    enabled: hasRange,
  });
  const prevSummaryQuery = useQuery({
    queryKey: ['mawbPnlSummary', prevDateFrom, prevDateTo],
    queryFn: () => api.getMawbPnlSummary({ manifest_date_from: prevDateFrom, manifest_date_to: prevDateTo }),
    enabled: hasRange,
  });
  const trendQuery = useQuery({
    queryKey: ['mawbPnlTrend', dateFrom, dateTo, granularity],
    queryFn: () => api.getMawbPnlTrend({ manifest_date_from: dateFrom, manifest_date_to: dateTo, granularity }),
    enabled: hasRange,
  });
  const routesQuery = useQuery({
    queryKey: ['mawbPnlRoutes', dateFrom, dateTo],
    queryFn: () => api.getMawbPnlRoutes({ manifest_date_from: dateFrom, manifest_date_to: dateTo, limit: 8 }),
    enabled: hasRange,
  });
  const listQuery = useQuery({
    queryKey: ['mawbPnlList', dateFrom, dateTo, offset, sortKey],
    queryFn: () => api.getMawbs({ manifest_date_from: dateFrom, manifest_date_to: dateTo, has_pnl: true, sort: sortKey, limit, offset }),
    enabled: hasRange,
  });

  const summary = summaryQuery.data;
  const prevSummary = prevSummaryQuery.data;
  const profitPositive = (summary?.profit_loss ?? 0) >= 0;

  const billTrend = summary && prevSummary ? pctChange(summary.bill_amount, prevSummary.bill_amount) : undefined;
  const upsTrend = summary && prevSummary ? pctChange(summary.ups_bill_amount, prevSummary.ups_bill_amount) : undefined;
  const profitTrend = summary && prevSummary ? pctChange(summary.profit_loss, prevSummary.profit_loss) : undefined;
  // Margin is already a percentage, so a relative pctChange() here computes a
  // "percent of a percent" (10%->15% would read as +50%) which misrepresents the size
  // of the move. A plain point difference (10%->15% = +5) is what "margin improved 5%"
  // actually means when people say it about a ratio metric like this.
  const marginTrend = summary && prevSummary ? Math.round((summary.avg_margin_percent - prevSummary.avg_margin_percent) * 10) / 10 : undefined;

  const trend = useMemo(() => trendQuery.data || [], [trendQuery.data]);
  const routes = useMemo(() => routesQuery.data || [], [routesQuery.data]);
  const items = useMemo(() => listQuery.data?.items || [], [listQuery.data]);
  const total = listQuery.data?.total || 0;

  // Sorting itself now happens server-side (sort=margin on /api/v1/mawbs), against the
  // full filtered range rather than just the current page — see backend/app/main.py.
  const sortedItems = items;

  const trendOption = {
    tooltip: {
      trigger: 'axis',
      backgroundColor: '#fff', borderColor: '#e2e8f0', textStyle: { color: '#0f172a', fontSize: 11 },
      valueFormatter: (v: any) => fmt$(Number(v)),
    },
    legend: { data: ['Bill Amount', 'UPS Bill Amount', 'Profit / Loss'], bottom: 0, icon: 'circle', itemWidth: 8, itemHeight: 8, textStyle: { fontSize: 11, color: '#64748b' } },
    grid: { left: '2%', right: '3%', bottom: '15%', top: '8%', containLabel: true },
    xAxis: { type: 'category', boundaryGap: false, data: trend.map((d) => d.period), axisLabel: { fontSize: 10, color: '#94a3b8' }, axisLine: { lineStyle: { color: '#e2e8f0' } } },
    yAxis: { type: 'value', axisLabel: { fontSize: 10, color: '#94a3b8', formatter: (v: number) => fmt$Compact(v) }, splitLine: { lineStyle: { type: 'dashed', color: '#e2e8f0' } } },
    series: [
      { name: 'Bill Amount', type: 'line', smooth: true, symbol: 'none', data: trend.map((d) => d.bill_amount), itemStyle: { color: COLOR_BILL }, lineStyle: { width: 2 } },
      { name: 'UPS Bill Amount', type: 'line', smooth: true, symbol: 'none', data: trend.map((d) => d.ups_bill_amount), itemStyle: { color: COLOR_UPS }, lineStyle: { width: 2 } },
      {
        name: 'Profit / Loss', type: 'line', smooth: true, symbol: 'none', data: trend.map((d) => d.profit_loss),
        itemStyle: { color: COLOR_PROFIT }, lineStyle: { width: 2.5 },
        areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: 'rgba(16,185,129,0.18)' }, { offset: 1, color: 'rgba(16,185,129,0.02)' }] } },
      },
    ],
  };

  const routeOption = {
    tooltip: {
      trigger: 'axis', axisPointer: { type: 'shadow' },
      backgroundColor: '#fff', borderColor: '#e2e8f0', textStyle: { color: '#0f172a', fontSize: 11 },
      valueFormatter: (v: any) => fmt$(Number(v)),
    },
    grid: { left: '2%', right: '8%', bottom: '2%', top: '2%', containLabel: true },
    xAxis: { type: 'value', show: false },
    yAxis: { type: 'category', data: routes.slice(0, 8).map((r) => r.route).reverse(), axisLine: { show: false }, axisTick: { show: false }, axisLabel: { fontSize: 11, color: '#475569', fontWeight: 600 } },
    series: [
      {
        type: 'bar',
        data: routes.slice(0, 8).map((r) => r.profit_loss).reverse(),
        itemStyle: { color: (p: any) => (p.value >= 0 ? COLOR_PROFIT : COLOR_LOSS), borderRadius: [0, 4, 4, 0] },
        barMaxWidth: 18,
        label: { show: true, position: 'right', formatter: (p: any) => fmt$Compact(p.value), fontSize: 10, fontWeight: 700, color: '#64748b' },
      },
    ],
  };

  return (
    <div className="flex-1 bg-background min-h-screen p-6 space-y-6">
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-xl font-black text-slate-900 dark:text-slate-100 flex items-center gap-2">
            <TrendingUp size={20} className="text-primary" /> Profitability
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 font-medium">
            UPS bill vs. what was charged, per MAWB — pulled from the CRM's Total Profit/Loss report. Compared against the prior {rangeDaysLabel}-day period.
          </p>
        </div>
        <div className="flex items-end gap-2 flex-wrap">
          <DateRangeControl
            timeframe={timeframe} dateFrom={customFrom} dateTo={customTo}
            bounds={customersQuery.data?.bounds || undefined}
            onPreset={(v) => { setTimeframe(v); setCustomFrom(''); setCustomTo(''); setOffset(0); }}
            onCustom={(f, t) => { setTimeframe('custom'); setCustomFrom(f); setCustomTo(t); setOffset(0); }}
            defaultPreset="last_30_days"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KpiCard
          title="Bill Amount"
          value={summaryQuery.isLoading ? '—' : fmt$Compact(summary?.bill_amount ?? 0)}
          subValue={summary ? `${summary.mawb_count} MAWB${summary.mawb_count === 1 ? '' : 's'}` : undefined}
          icon={DollarSign} trend={billTrend} trendLabel="vs prior" className="border-t-2 border-t-blue-500"
        />
        <KpiCard
          title="UPS Bill Amount"
          value={summaryQuery.isLoading ? '—' : fmt$Compact(summary?.ups_bill_amount ?? 0)}
          icon={DollarSign} trend={upsTrend} trendLabel="vs prior" className="border-t-2 border-t-amber-500"
        />
        <KpiCard
          title="Profit / Loss"
          value={summaryQuery.isLoading ? '—' : fmt$Compact(summary?.profit_loss ?? 0)}
          icon={profitPositive ? TrendingUp : TrendingDown}
          trend={profitTrend}
          trendLabel="vs prior"
          className="border-t-2 border-t-emerald-500"
        />
        <KpiCard
          title="Avg Margin"
          value={summaryQuery.isLoading ? '—' : `${summary?.avg_margin_percent ?? 0}%`}
          icon={Percent}
          trend={marginTrend}
          trendLabel="vs prior"
          className="border-t-2 border-t-violet-500"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/30 p-4">
          <h3 className="text-xs font-bold text-slate-900 dark:text-slate-100 uppercase tracking-wider mb-1">Bill vs. UPS Cost vs. Profit</h3>
          <p className="text-[10px] text-slate-400 dark:text-slate-500 mb-2 font-medium">Grouped by {granularity} · {trend.reduce((s, d) => s + d.mawb_count, 0)} MAWBs in range</p>
          {trendQuery.isLoading ? (
            <div className="h-[280px] flex items-center justify-center text-slate-400"><RefreshCw className="animate-spin" size={20} /></div>
          ) : trend.length === 0 ? (
            <div className="h-[280px] flex items-center justify-center text-xs text-slate-400 dark:text-slate-500 font-medium">No synced P&L data in this range yet.</div>
          ) : (
            <ReactECharts option={trendOption} style={{ height: 280 }} notMerge />
          )}
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/30 p-4">
          <h3 className="text-xs font-bold text-slate-900 dark:text-slate-100 uppercase tracking-wider mb-1 flex items-center gap-1.5">
            <RouteIcon size={13} className="text-blue-500" /> Profit by Route
          </h3>
          <p className="text-[10px] text-slate-400 dark:text-slate-500 mb-2 font-medium">Top {Math.min(routes.length, 8)} routes</p>
          {routesQuery.isLoading ? (
            <div className="h-[280px] flex items-center justify-center text-slate-400"><RefreshCw className="animate-spin" size={20} /></div>
          ) : routes.length === 0 ? (
            <div className="h-[280px] flex items-center justify-center text-xs text-slate-400 dark:text-slate-500 font-medium">No synced P&L data in this range yet.</div>
          ) : (
            <ReactECharts option={routeOption} style={{ height: 280 }} notMerge />
          )}
        </div>
      </div>

      {(summary?.best_margin_mawb || summary?.highest_profit_mawb || summary?.worst_margin_mawb) && (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/30 overflow-hidden">
          <h3 className="text-xs font-bold text-slate-900 dark:text-slate-100 uppercase tracking-wider px-4 pt-4 pb-1">Margin Leaders</h3>
          <div className="divide-y divide-slate-100 dark:divide-slate-800/50">
            {summary.best_margin_mawb && (
              <button onClick={() => navigate(`/app/mawb?mawb=${summary.best_margin_mawb!.id}`)} className="w-full text-left flex items-center gap-3 px-4 py-3 border-l-2 border-emerald-500 hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors">
                <span className="text-[9px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500 w-14 shrink-0">Best</span>
                <span className="text-xs font-bold text-slate-900 dark:text-slate-100 font-mono">{summary.best_margin_mawb.mawb_number}</span>
                <span className="text-xs text-slate-400 dark:text-slate-500">{fmtDate(summary.best_margin_mawb.manifest_date)}</span>
                <span className="flex-1" />
                <span className="text-xs text-slate-500 dark:text-slate-400 font-medium">{fmt$(summary.best_margin_mawb.profit_loss)} profit</span>
                <span className="text-sm font-black text-emerald-600 dark:text-emerald-400 w-14 text-right">{summary.best_margin_mawb.margin_percent}%</span>
              </button>
            )}
            {summary.highest_profit_mawb && (
              <button onClick={() => navigate(`/app/mawb?mawb=${summary.highest_profit_mawb!.id}`)} className="w-full text-left flex items-center gap-3 px-4 py-3 border-l-2 border-blue-500 hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors">
                <span className="text-[9px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500 w-14 shrink-0">Top $</span>
                <span className="text-xs font-bold text-slate-900 dark:text-slate-100 font-mono">{summary.highest_profit_mawb.mawb_number}</span>
                <span className="text-xs text-slate-400 dark:text-slate-500">{fmtDate(summary.highest_profit_mawb.manifest_date)}</span>
                <span className="flex-1" />
                <span className="text-xs text-slate-500 dark:text-slate-400 font-medium">{summary.highest_profit_mawb.margin_percent}% margin</span>
                <span className="text-sm font-black text-blue-600 dark:text-blue-400 w-20 text-right">{fmt$(summary.highest_profit_mawb.profit_loss)}</span>
              </button>
            )}
            {summary.worst_margin_mawb && (
              <button onClick={() => navigate(`/app/mawb?mawb=${summary.worst_margin_mawb!.id}`)} className="w-full text-left flex items-center gap-3 px-4 py-3 border-l-2 border-red-500 hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors">
                <span className="text-[9px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500 w-14 shrink-0">Lowest</span>
                <span className="text-xs font-bold text-slate-900 dark:text-slate-100 font-mono">{summary.worst_margin_mawb.mawb_number}</span>
                <span className="text-xs text-slate-400 dark:text-slate-500">{fmtDate(summary.worst_margin_mawb.manifest_date)}</span>
                <span className="flex-1" />
                <span className="text-xs text-slate-500 dark:text-slate-400 font-medium">{fmt$(summary.worst_margin_mawb.profit_loss)} profit</span>
                <span className="text-sm font-black text-red-600 dark:text-red-400 w-14 text-right">{summary.worst_margin_mawb.margin_percent}%</span>
              </button>
            )}
          </div>
        </div>
      )}

      <div className="border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden bg-white dark:bg-slate-900/30">
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-200 dark:border-slate-800">
          <div>
            <h3 className="text-xs font-bold text-slate-900 dark:text-slate-100 uppercase tracking-wider flex items-center gap-1.5">
              <Users size={13} className="text-blue-500" /> Profit by Customer
            </h3>
            <p className="text-[10px] text-slate-400 dark:text-slate-500 font-medium mt-0.5">
              From per-shipment UPS costs. Only costed shipments count toward margin.
            </p>
          </div>
          <div className="flex gap-1 text-[10px] font-bold">
            {([['profit', 'Most Profit'], ['margin', 'Best Margin'], ['loss', 'Worst']] as const).map(([key, label]) => (
              <button key={key} onClick={() => setCustomerSort(key)}
                className={`px-2 py-1 rounded ${customerSort === key ? 'bg-primary text-white' : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'}`}>{label}</button>
            ))}
          </div>
        </div>
        {customersQuery.isLoading ? (
          <div className="px-4 py-12 text-center text-sm text-slate-500 dark:text-slate-400">
            <div className="flex items-center justify-center gap-2"><RefreshCw className="animate-spin" size={16} /> Loading...</div>
          </div>
        ) : (customersQuery.data?.items || []).length === 0 ? (
          <div className="px-4 py-12 text-center text-sm text-slate-500 dark:text-slate-400">
            No per-shipment UPS data for this range yet — that comes from the UPS detail sync, which is separate from the MAWB-level totals above.
          </div>
        ) : (
          <table className="w-full text-left border-collapse">
            <thead className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-800">
              <tr>
                <th className="px-4 py-2.5 text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Customer</th>
                <th className="px-4 py-2.5 text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider text-right">Shipments</th>
                <th className="px-4 py-2.5 text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider text-right">Billed</th>
                <th className="px-4 py-2.5 text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider text-right">UPS Cost</th>
                <th className="px-4 py-2.5 text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider text-right">Profit</th>
                <th className="px-4 py-2.5 text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider text-right">Margin</th>
                <th className="px-2 py-2.5"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/50">
              {(customersQuery.data?.items || []).map((c) => {
                const positive = c.profit_loss >= 0;
                return (
                  <tr key={c.company_id} className="cursor-pointer" onClick={() => navigate(`/app/customers/${c.company_id}`)}>
                    <td className="px-4 py-2 text-xs">
                      <div className="font-semibold text-slate-900 dark:text-slate-100">{c.company_name}</div>
                      <div className="text-[10px] text-slate-400 dark:text-slate-500 font-medium">
                        {c.icris_number}{c.segment ? ` · ${c.segment}` : ''}
                        {c.awaiting_cost_shipments > 0 && (
                          <span className="ml-1.5 inline-flex items-center gap-0.5 text-amber-600 dark:text-amber-400 font-semibold">
                            <Clock size={9} /> {c.awaiting_cost_shipments} awaiting cost
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-2 whitespace-nowrap text-xs text-right text-slate-600 dark:text-slate-300">{c.shipments}</td>
                    <td className="px-4 py-2 whitespace-nowrap text-xs text-right text-slate-700 dark:text-slate-200">{fmt$(c.bill_amount)}</td>
                    <td className="px-4 py-2 whitespace-nowrap text-xs text-right text-slate-700 dark:text-slate-200">{fmt$(c.ups_bill_amount)}</td>
                    <td className={`px-4 py-2 whitespace-nowrap text-xs text-right font-semibold ${positive ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>{fmt$(c.profit_loss)}</td>
                    <td className={`px-4 py-2 whitespace-nowrap text-xs text-right font-medium ${positive ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>{c.margin_percent === null ? '—' : `${c.margin_percent}%`}</td>
                    <td className="px-2 py-2 text-slate-300 dark:text-slate-600"><ArrowRight size={13} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden bg-white dark:bg-slate-900/30">
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-200 dark:border-slate-800">
          <h3 className="text-xs font-bold text-slate-900 dark:text-slate-100 uppercase tracking-wider">MAWB Detail</h3>
          <div className="flex gap-1 text-[10px] font-bold">
            <button onClick={() => setSortKey('manifest_date')} className={`px-2 py-1 rounded ${sortKey === 'manifest_date' ? 'bg-primary text-white' : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'}`}>By Date</button>
            <button onClick={() => setSortKey('margin')} className={`px-2 py-1 rounded ${sortKey === 'margin' ? 'bg-primary text-white' : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'}`}>By Margin</button>
          </div>
        </div>
        <table className="w-full text-left border-collapse">
          <thead className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-800">
            <tr>
              <th className="px-4 py-2.5 text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">MAWB</th>
              <th className="px-4 py-2.5 text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Date</th>
              <th className="px-4 py-2.5 text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider text-right">Bill Amount</th>
              <th className="px-4 py-2.5 text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider text-right">UPS Bill Amt</th>
              <th className="px-4 py-2.5 text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider text-right">Profit / Loss</th>
              <th className="px-4 py-2.5 text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider text-right">Margin</th>
              <th className="px-2 py-2.5"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800/50">
            {listQuery.isLoading ? (
              <tr><td colSpan={7} className="px-4 py-12 text-center text-sm text-slate-500 dark:text-slate-400">
                <div className="flex items-center justify-center gap-2"><RefreshCw className="animate-spin" size={16} /> Loading...</div>
              </td></tr>
            ) : sortedItems.length === 0 ? (
              <tr><td colSpan={7} className="px-4 py-12 text-center text-sm text-slate-500 dark:text-slate-400">
                No P&L data synced for this date range yet — sync it from the <button onClick={() => navigate('/app/sync')} className="text-primary font-bold hover:underline">CRM Sync page</button>.
              </td></tr>
            ) : sortedItems.map((m: any) => {
              const rowMargin = m.pnl_bill_amount ? (m.pnl_profit_loss / m.pnl_bill_amount) * 100 : 0;
              const positive = (m.pnl_profit_loss ?? 0) >= 0;
              return (
                <tr key={m.id} className="cursor-pointer" onClick={() => navigate(`/app/mawb?mawb=${m.id}`)}>
                  <td className="px-4 py-2 whitespace-nowrap text-xs font-semibold text-slate-900 dark:text-slate-100">{m.mawb_number}</td>
                  <td className="px-4 py-2 whitespace-nowrap text-xs text-slate-600 dark:text-slate-300">{fmtDate(m.manifest_date)}</td>
                  <td className="px-4 py-2 whitespace-nowrap text-xs text-right text-slate-700 dark:text-slate-200">{fmt$(m.pnl_bill_amount || 0)}</td>
                  <td className="px-4 py-2 whitespace-nowrap text-xs text-right text-slate-700 dark:text-slate-200">{fmt$(m.pnl_ups_bill_amount || 0)}</td>
                  <td className={`px-4 py-2 whitespace-nowrap text-xs text-right font-semibold ${positive ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>{fmt$(m.pnl_profit_loss || 0)}</td>
                  <td className={`px-4 py-2 whitespace-nowrap text-xs text-right font-medium ${positive ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>{rowMargin.toFixed(1)}%</td>
                  <td className="px-2 py-2 text-slate-300 dark:text-slate-600"><ArrowRight size={13} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {total > limit && (
          <div className="flex items-center justify-between px-4 py-2.5 border-t border-slate-200 dark:border-slate-800 text-xs text-slate-500 dark:text-slate-400">
            <span>{offset + 1}–{Math.min(offset + limit, total)} of {total}</span>
            <div className="flex gap-2">
              <button disabled={offset === 0} onClick={() => setOffset(o => Math.max(0, o - limit))} className="px-2 py-1 rounded border border-slate-200 dark:border-slate-700 disabled:opacity-30 font-semibold">Prev</button>
              <button disabled={offset + limit >= total} onClick={() => setOffset(o => o + limit)} className="px-2 py-1 rounded border border-slate-200 dark:border-slate-700 disabled:opacity-30 font-semibold">Next</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
