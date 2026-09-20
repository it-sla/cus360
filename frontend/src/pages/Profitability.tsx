import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import ReactECharts from 'echarts-for-react';
import {
  RefreshCw, DollarSign, TrendingUp, TrendingDown,
  ArrowRight, Route as RouteIcon,
} from 'lucide-react';
import { api } from '@/api';
import { KpiCard } from '@/components/KpiCard';
import { DateRangeControl } from '@/components/AnalyticsFilterBar';
import { useTheme } from '@/theme';

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
  const limit = 25;
  const { theme } = useTheme();
  const dark = theme === 'dark';

  // Same fix as Rankings.tsx: `timeframe` must still be sent as 'custom' here too, or the
  // backend's default `timeframe` kicks in and the custom date_from/date_to are ignored.
  const tfParams = timeframe === 'custom' ? { timeframe: 'custom', date_from: customFrom, date_to: customTo } : { timeframe };

  // The one query that resolves the timeframe into literal dates (same trick Rankings uses with
  // top-customers) — every other query on this page waits on its result rather than re-deriving
  // date math client-side.
  const customersQuery = useQuery({
    queryKey: ['customerProfitability', timeframe, customFrom, customTo],
    queryFn: () => api.getCustomerProfitability({ ...tfParams, sort: 'profit', limit: 12 }),
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

  const trend = useMemo(() => trendQuery.data || [], [trendQuery.data]);
  const routes = useMemo(() => routesQuery.data || [], [routesQuery.data]);
  const items = useMemo(() => listQuery.data?.items || [], [listQuery.data]);
  const total = listQuery.data?.total || 0;

  // Sorting itself now happens server-side (sort=margin on /api/v1/mawbs), against the
  // full filtered range rather than just the current page — see backend/app/main.py.
  const sortedItems = items;

  // Two hardcoded palettes keyed off theme — simpler than getComputedStyle reads on every render.
  const chartPalette = dark
    ? { bg: '#1e293b', border: '#334155', text: '#e2e8f0', axisLabel: '#94a3b8', axisLine: '#334155', splitLine: '#334155', legend: '#94a3b8', barLabel: '#94a3b8' }
    : { bg: '#fff', border: '#e2e8f0', text: '#0f172a', axisLabel: '#94a3b8', axisLine: '#e2e8f0', splitLine: '#e2e8f0', legend: '#64748b', barLabel: '#64748b' };

  const trendOption = {
    tooltip: {
      trigger: 'axis',
      backgroundColor: chartPalette.bg, borderColor: chartPalette.border, textStyle: { color: chartPalette.text, fontSize: 11 },
      valueFormatter: (v: any) => fmt$(Number(v)),
    },
    legend: { data: ['Bill Amount', 'UPS Bill Amount', 'Profit / Loss'], bottom: 0, icon: 'circle', itemWidth: 8, itemHeight: 8, textStyle: { fontSize: 11, color: chartPalette.legend } },
    grid: { left: '2%', right: '3%', bottom: '15%', top: '8%', containLabel: true },
    xAxis: { type: 'category', boundaryGap: false, data: trend.map((d) => d.period), axisLabel: { fontSize: 10, color: chartPalette.axisLabel }, axisLine: { lineStyle: { color: chartPalette.axisLine } } },
    yAxis: { type: 'value', axisLabel: { fontSize: 10, color: chartPalette.axisLabel, formatter: (v: number) => fmt$Compact(v) }, splitLine: { lineStyle: { type: 'dashed', color: chartPalette.splitLine } } },
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
      backgroundColor: chartPalette.bg, borderColor: chartPalette.border, textStyle: { color: chartPalette.text, fontSize: 11 },
      valueFormatter: (v: any) => fmt$(Number(v)),
    },
    grid: { left: '2%', right: '8%', bottom: '2%', top: '2%', containLabel: true },
    xAxis: { type: 'value', show: false },
    yAxis: { type: 'category', data: routes.slice(0, 8).map((r) => r.route).reverse(), axisLine: { show: false }, axisTick: { show: false }, axisLabel: { fontSize: 11, color: dark ? '#cbd5e1' : '#475569', fontWeight: 600 } },
    series: [
      {
        type: 'bar',
        data: routes.slice(0, 8).map((r) => r.profit_loss).reverse(),
        itemStyle: { color: (p: any) => (p.value >= 0 ? COLOR_PROFIT : COLOR_LOSS), borderRadius: [0, 4, 4, 0] },
        barMaxWidth: 18,
        label: { show: true, position: 'right', formatter: (p: any) => fmt$Compact(p.value), fontSize: 10, fontWeight: 700, color: chartPalette.barLabel },
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
            MAWB-level profit &amp; loss vs. the prior {rangeDaysLabel}-day period.
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

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className={`lg:col-span-2 rounded-xl border p-6 flex items-center gap-8 ${profitPositive ? 'border-emerald-200 dark:border-emerald-900/50 bg-emerald-50/50 dark:bg-emerald-950/20' : 'border-red-200 dark:border-red-900/50 bg-red-50/50 dark:bg-red-950/20'}`}>
          {profitPositive
            ? <TrendingUp size={40} className="text-emerald-500 shrink-0" />
            : <TrendingDown size={40} className="text-red-500 shrink-0" />}
          <div>
            <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">Profit / Loss</div>
            <div className={`text-4xl font-black leading-tight ${profitPositive ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
              {summaryQuery.isLoading ? '—' : fmt$Compact(summary?.profit_loss ?? 0)}
            </div>
            <div className="flex items-center gap-3 mt-1 text-sm font-semibold text-slate-600 dark:text-slate-300">
              <span>{summary?.avg_margin_percent ?? 0}% margin</span>
              {profitTrend !== undefined && (
                <span className={profitTrend >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}>
                  {profitTrend >= 0 ? '+' : ''}{profitTrend}% vs prior
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-4">
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
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className={`rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/30 p-4 ${routes.length > 1 ? 'lg:col-span-2' : 'lg:col-span-3'}`}>
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

        {routes.length > 1 && (
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/30 p-4">
            <h3 className="text-xs font-bold text-slate-900 dark:text-slate-100 uppercase tracking-wider mb-1 flex items-center gap-1.5">
              <RouteIcon size={13} className="text-blue-500" /> Profit by Route
            </h3>
            <p className="text-[10px] text-slate-400 dark:text-slate-500 mb-2 font-medium">Top {Math.min(routes.length, 8)} routes</p>
            <ReactECharts option={routeOption} style={{ height: 280 }} notMerge />
          </div>
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
