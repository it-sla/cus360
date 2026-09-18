import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api';
import ReactECharts from 'echarts-for-react';

import {
  RefreshCw,
  FileText,
  Activity,
  HelpCircle,
  ArrowUpRight,
  ArrowDownRight,
  X,
  List
} from 'lucide-react';
import { DateRangeControl, CompareModeSelect } from '@/components/AnalyticsFilterBar';

const fmt$ = (v: number) => `$${(v || 0).toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})}`;
const fmtNum = (v: number) => (v || 0).toLocaleString();

const DOC_COLOR = '#3b82f6';
const UNCLASSIFIED_COLOR = '#94a3b8';

// pop_pct compares the current period to whatever the CompareModeSelect has active
// (previous period or same period last year) — computed server-side by calc_pop.
function Stat({ label, value, popPct }: { label: string; value: string; popPct?: number }) {
  const hasTrend = typeof popPct === 'number' && Number.isFinite(popPct);
  const isPositive = hasTrend && popPct >= 0;
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-1">{label}</div>
      <div className="flex items-baseline gap-2 flex-wrap">
        <div className="text-lg sm:text-xl font-black text-slate-900 dark:text-white tabular-nums truncate" title={value}>{value}</div>
        {hasTrend && (
          <span className={`inline-flex items-center gap-0.5 text-[11px] font-bold ${isPositive ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
            {isPositive ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}
            {Math.abs(popPct).toFixed(1)}%
          </span>
        )}
      </div>
    </div>
  );
}

export default function DocumentTypeAnalytics() {
  const [showAwbs, setShowAwbs] = useState(false);
  const [filters, setFilters] = useState({
    timeframe: 'this_month',
    compareMode: 'pop',
    dateFrom: '',
    dateTo: ''
  });

  const { data, isLoading } = useQuery({
    queryKey: ['documentTypeAnalytics', filters],
    queryFn: () => api.getDocumentTypeDashboard({
      timeframe: filters.timeframe,
      date_from: filters.timeframe === 'custom' ? filters.dateFrom : undefined,
      date_to: filters.timeframe === 'custom' ? filters.dateTo : undefined,
      compare_mode: filters.compareMode,
    }),
    refetchInterval: 30000,
  });

  const updateFilter = (key: string, value: any) => setFilters(f => ({ ...f, [key]: value }));

  if (isLoading || !data) {
    return (
      <div className="flex-1 bg-background flex items-center justify-center min-h-[600px]">
        <div className="flex flex-col items-center gap-3 bg-white p-10 rounded-2xl shadow-sm border border-[#E2E8F0] dark:bg-zinc-900 dark:border-zinc-800">
          <RefreshCw className="animate-spin text-primary" size={32} />
          <span className="font-semibold text-slate-700 text-sm dark:text-zinc-300">Loading Document Type Analytics...</span>
        </div>
      </div>
    );
  }

  const kpis = data.kpis;
  // At 'all_time' there is no prior period to compare against — calc_pop falls back to a
  // meaningless +100%/0% rather than a real comparison, so don't show the trend arrow then.
  const showTrend = data.timeframe !== 'all_time';
  const trend: any[] = data.trend || [];
  // Ranked by DOC revenue, not total_revenue (which the backend also mixes in non_doc) —
  // this page is DOC + Unclassified only, so a customer with huge NON-DOC volume but no
  // DOC/Unclassified activity shouldn't crowd out real DOC customers.
  const byCustomer: any[] = [...(data.by_customer || [])]
    .filter((r: any) => r.doc_count > 0 || r.unclassified_count > 0)
    .sort((a: any, b: any) => b.doc_revenue - a.doc_revenue);
  const byDestination: any[] = data.by_destination || [];
  const topDocDestinations = byDestination.filter((d: any) => d.doc_count > 0).slice(0, 10);

  const trendOption = {
    tooltip: { trigger: 'axis', backgroundColor: '#fff', borderColor: '#e2e8f0', textStyle: { color: '#0f172a' } },
    legend: { data: ['DOC', 'Unclassified'], top: 0, textStyle: { fontSize: 11 } },
    grid: { left: '3%', right: '4%', bottom: '3%', top: '15%', containLabel: true },
    xAxis: { type: 'category', data: trend.map(t => t.period), axisLabel: { fontSize: 10, rotate: 30 } },
    yAxis: { type: 'value', splitLine: { lineStyle: { type: 'dashed', color: '#e2e8f0' } } },
    series: [
      { name: 'DOC', type: 'bar', stack: 'total', data: trend.map(t => t.doc_count), itemStyle: { color: DOC_COLOR } },
      { name: 'Unclassified', type: 'bar', stack: 'total', data: trend.map(t => t.unclassified_count), itemStyle: { color: UNCLASSIFIED_COLOR } },
    ]
  };

  const destBarOption = {
    tooltip: { trigger: 'axis', backgroundColor: '#fff', borderColor: '#e2e8f0', textStyle: { color: '#0f172a' } },
    grid: { left: '3%', right: '4%', bottom: '3%', top: '5%', containLabel: true },
    xAxis: { type: 'value', show: false },
    yAxis: { type: 'category', data: topDocDestinations.map((d: any) => d.destination).reverse(), axisLine: { show: false }, axisTick: { show: false } },
    series: [{
      type: 'bar',
      data: topDocDestinations.map((d: any) => d.doc_count).reverse(),
      itemStyle: { color: DOC_COLOR, borderRadius: [0,4,4,0] },
      label: { show: true, position: 'right', formatter: (p: any) => fmtNum(p.value), fontSize: 10, color: '#64748b' }
    }]
  };

  return (
    <div className="flex-1 overflow-y-auto bg-background relative p-4 sm:p-6 lg:p-8 max-w-[1600px] mx-auto w-full space-y-6">

      {/* HEADER */}
      <div className="flex flex-col xl:flex-row xl:items-start justify-between gap-4">
        <div>
          <h1 className="text-xl sm:text-2xl font-black text-slate-900 tracking-tight dark:text-white">Document Type</h1>
          <p className="mt-1 text-xs sm:text-sm text-slate-500 font-medium">DOC shipment volume and revenue, from the CRM's own Bill Type field, plus what's still Unclassified.</p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <DateRangeControl
            timeframe={filters.timeframe} dateFrom={filters.dateFrom} dateTo={filters.dateTo} bounds={data.bounds}
            onPreset={(v) => { updateFilter('timeframe', v); updateFilter('dateFrom', ''); updateFilter('dateTo', ''); }}
            onCustom={(f, t) => { updateFilter('timeframe', 'custom'); updateFilter('dateFrom', f); updateFilter('dateTo', t); }}
          />
          <CompareModeSelect icon={Activity} value={filters.compareMode} onChange={(e) => updateFilter('compareMode', e.target.value)} />
        </div>
      </div>

      {/* KPI STRIPS — one full-width row per bucket, 4 stats laid out horizontally so
          values never get squeezed into a narrow nested-card column. */}
      <div className="space-y-3">
        <div className="bg-white rounded-[16px] border border-[#E2E8F0] shadow-[0_2px_4px_rgba(15,23,42,0.04)] p-5 dark:bg-zinc-900 dark:border-zinc-800 border-l-4" style={{ borderLeftColor: DOC_COLOR }}>
          <div className="flex items-center gap-2 mb-4"><FileText size={16} style={{ color: DOC_COLOR }} /><h3 className="text-sm font-bold text-slate-900 dark:text-white">DOC</h3><span className="text-[11px] text-slate-400">Document + Letter</span></div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 sm:gap-6">
            <Stat label="Shipments" value={fmtNum(kpis.doc.shipments.value)} popPct={showTrend ? kpis.doc.shipments.pop_pct : undefined} />
            <Stat label="Revenue" value={fmt$(kpis.doc.revenue.value)} popPct={showTrend ? kpis.doc.revenue.pop_pct : undefined} />
            <Stat label="Weight" value={`${fmtNum(kpis.doc.weight.value)} kg`} popPct={showTrend ? kpis.doc.weight.pop_pct : undefined} />
            <Stat label="Avg Rev/Shipment" value={fmt$(kpis.doc.avg_revenue_per_shipment.value)} popPct={showTrend ? kpis.doc.avg_revenue_per_shipment.pop_pct : undefined} />
          </div>
        </div>
        <div className="bg-white rounded-[16px] border border-[#E2E8F0] shadow-[0_2px_4px_rgba(15,23,42,0.04)] p-5 dark:bg-zinc-900 dark:border-zinc-800 border-l-4" style={{ borderLeftColor: UNCLASSIFIED_COLOR }}>
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2"><HelpCircle size={16} style={{ color: UNCLASSIFIED_COLOR }} /><h3 className="text-sm font-bold text-slate-900 dark:text-white">Unclassified</h3><span className="text-[11px] text-slate-400">Blank Bill Type</span></div>
            {kpis.unclassified.shipments.value > 0 && (
              <button onClick={() => setShowAwbs(true)} className="flex items-center gap-1 text-xs font-semibold text-slate-500 hover:text-slate-900 dark:hover:text-white transition-colors">
                <List size={13} /> View AWBs
              </button>
            )}
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 sm:gap-6">
            <Stat label="Shipments" value={fmtNum(kpis.unclassified.shipments.value)} popPct={showTrend ? kpis.unclassified.shipments.pop_pct : undefined} />
            <Stat label="Revenue" value={fmt$(kpis.unclassified.revenue.value)} popPct={showTrend ? kpis.unclassified.revenue.pop_pct : undefined} />
            <Stat label="Weight" value={`${fmtNum(kpis.unclassified.weight.value)} kg`} popPct={showTrend ? kpis.unclassified.weight.pop_pct : undefined} />
            <Stat label="Avg Rev/Shipment" value={fmt$(kpis.unclassified.avg_revenue_per_shipment.value)} popPct={showTrend ? kpis.unclassified.avg_revenue_per_shipment.pop_pct : undefined} />
          </div>
        </div>
      </div>

      {/* CHARTS ROW */}
      <div className="bg-white rounded-[16px] border border-[#E2E8F0] shadow-[0_2px_4px_rgba(15,23,42,0.04)] p-5 dark:bg-zinc-900 dark:border-zinc-800 h-[320px] flex flex-col">
        <h3 className="text-sm font-bold text-slate-900 tracking-tight dark:text-white mb-2">Shipment Volume Over Time</h3>
        <div className="flex-1">{trend.length > 0 ? <ReactECharts option={trendOption} style={{ height: '100%' }} /> : <div className="h-full flex items-center justify-center text-xs text-slate-400">No shipments in this period</div>}</div>
      </div>

      {/* TOP CUSTOMERS BY DOC REVENUE */}
      <div className="bg-white rounded-[16px] border border-[#E2E8F0] shadow-[0_2px_4px_rgba(15,23,42,0.04)] overflow-hidden flex flex-col dark:bg-zinc-900 dark:border-zinc-800">
        <div className="p-5 border-b border-[#E2E8F0] dark:border-zinc-800">
          <h3 className="text-sm font-bold text-slate-900 tracking-tight dark:text-white">Top Customers by DOC Revenue</h3>
        </div>
        <div className="overflow-x-auto flex-1 max-h-[400px] overflow-y-auto">
          <table className="w-full text-left text-xs whitespace-nowrap">
            <thead className="bg-slate-50 dark:bg-zinc-800 text-slate-500 border-b border-[#E2E8F0] dark:border-zinc-700 sticky top-0 z-10">
              <tr>
                <th className="px-4 py-3 font-semibold">Company</th>
                <th className="px-4 py-3 font-semibold text-right">DOC Revenue</th>
                <th className="px-4 py-3 font-semibold text-right">DOC Shipments</th>
                <th className="px-4 py-3 font-semibold text-right">Unclassified Revenue</th>
                <th className="px-4 py-3 font-semibold text-right">Unclassified Shipments</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E2E8F0] dark:divide-zinc-800">
              {byCustomer.length === 0 && (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-slate-400">No customer data available</td></tr>
              )}
              {byCustomer.slice(0, 50).map((r: any) => (
                <tr key={r.company_id}>
                  <td className="px-4 py-3 font-medium text-slate-800 dark:text-slate-200">{r.company_name}</td>
                  <td className="px-4 py-3 text-right font-bold text-slate-800 dark:text-slate-200">{fmt$(r.doc_revenue)}</td>
                  <td className="px-4 py-3 text-right text-slate-600 dark:text-slate-400">{fmtNum(r.doc_count)}</td>
                  <td className="px-4 py-3 text-right text-slate-600 dark:text-slate-400">{fmt$(r.unclassified_revenue)}</td>
                  <td className="px-4 py-3 text-right text-slate-600 dark:text-slate-400">{fmtNum(r.unclassified_count)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* TOP DESTINATIONS FOR DOC SHIPMENTS */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="bg-white rounded-[16px] border border-[#E2E8F0] shadow-[0_2px_4px_rgba(15,23,42,0.04)] p-5 dark:bg-zinc-900 dark:border-zinc-800 h-[320px] flex flex-col">
          <h3 className="text-sm font-bold text-slate-900 tracking-tight dark:text-white mb-2">Top Destination Countries — DOC Shipments</h3>
          <div className="flex-1">{topDocDestinations.length > 0 ? <ReactECharts option={destBarOption} style={{ height: '100%' }} /> : <div className="h-full flex items-center justify-center text-xs text-slate-400">No DOC shipments in this period</div>}</div>
        </div>

        <div className="lg:col-span-2 bg-white rounded-[16px] border border-[#E2E8F0] shadow-[0_2px_4px_rgba(15,23,42,0.04)] overflow-hidden flex flex-col dark:bg-zinc-900 dark:border-zinc-800">
          <div className="p-5 border-b border-[#E2E8F0] dark:border-zinc-800">
            <h3 className="text-sm font-bold text-slate-900 tracking-tight dark:text-white">Destination Countries — DOC vs Unclassified</h3>
          </div>
          <div className="overflow-x-auto flex-1 max-h-[320px] overflow-y-auto">
            <table className="w-full text-left text-xs whitespace-nowrap">
              <thead className="bg-slate-50 dark:bg-zinc-800 text-slate-500 border-b border-[#E2E8F0] dark:border-zinc-700 sticky top-0 z-10">
                <tr>
                  <th className="px-4 py-3 font-semibold">Destination Country</th>
                  <th className="px-4 py-3 font-semibold text-right">DOC Shipments</th>
                  <th className="px-4 py-3 font-semibold text-right">Unclassified Shipments</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E2E8F0] dark:divide-zinc-800">
                {byDestination.filter((d: any) => d.doc_count > 0 || d.unclassified_count > 0).length === 0 && (
                  <tr><td colSpan={3} className="px-4 py-8 text-center text-slate-400">No destination country data available</td></tr>
                )}
                {byDestination
                  .filter((d: any) => d.doc_count > 0 || d.unclassified_count > 0)
                  .slice(0, 30)
                  .map((r: any) => (
                    <tr key={r.destination}>
                      <td className="px-4 py-3 font-medium text-slate-800 dark:text-slate-200">{r.destination}</td>
                      <td className="px-4 py-3 text-right font-bold" style={{ color: DOC_COLOR }}>{fmtNum(r.doc_count)}</td>
                      <td className="px-4 py-3 text-right text-slate-600 dark:text-slate-400">{fmtNum(r.unclassified_count)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Unclassified AWBs slide-over */}
      {showAwbs && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-xs" onClick={() => setShowAwbs(false)} />
          <div className="w-[560px] max-w-full h-full bg-white dark:bg-zinc-900 border-l border-slate-200 dark:border-zinc-800 shadow-2xl relative z-10 flex flex-col">
            <div className="flex items-center justify-between p-6 border-b border-slate-200 dark:border-zinc-800 bg-slate-50/80 dark:bg-zinc-900/90">
              <div>
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400">Unclassified AWBs</h3>
                <p className="text-lg font-black text-slate-900 dark:text-zinc-100 mt-1">{(data.unclassified_awbs || []).length} shipments with blank Bill Type</p>
              </div>
              <button onClick={() => setShowAwbs(false)} className="p-2 hover:bg-slate-200/60 dark:hover:bg-zinc-800 rounded-full transition-colors text-slate-400 hover:text-slate-900 dark:hover:text-white">
                <X size={20} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">
              {(data.unclassified_awbs || []).length === 0 ? (
                <div className="p-8 text-center text-slate-400 text-sm">No unclassified shipments in this period</div>
              ) : (
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50/80 border-b border-slate-100 sticky top-0">
                    <tr className="text-[10px] uppercase font-bold tracking-wider text-slate-500">
                      <th className="px-4 py-2.5">AWB</th>
                      <th className="px-4 py-2.5">Customer</th>
                      <th className="px-4 py-2.5">Date</th>
                      <th className="px-4 py-2.5">Dest</th>
                      <th className="px-4 py-2.5 text-right">Revenue</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-zinc-800">
                    {(data.unclassified_awbs || []).map((r: any, i: number) => (
                      <tr key={i} className="hover:bg-slate-50 dark:hover:bg-zinc-800/60 transition-colors">
                        <td className="px-4 py-2.5 font-mono font-semibold text-slate-800 dark:text-zinc-100">{r.shipment_number || '—'}</td>
                        <td className="px-4 py-2.5 text-slate-600 dark:text-zinc-300 max-w-[160px] truncate">{r.company_name}</td>
                        <td className="px-4 py-2.5 text-slate-500">{r.shipment_date || '—'}</td>
                        <td className="px-4 py-2.5 text-slate-500">{r.destination}</td>
                        <td className="px-4 py-2.5 text-right font-bold text-slate-900 dark:text-zinc-100">{fmt$(r.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
