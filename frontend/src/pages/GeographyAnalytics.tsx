import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api';
import { ExportButton } from '@/components/ExportButton';
import { exportXlsx } from '@/lib/exportXlsx';
import ReactECharts from 'echarts-for-react';

import {
  RefreshCw,
  Globe,
  TrendingUp,
  Package,
  Weight,
  DollarSign,
  Activity
} from 'lucide-react';
import { KpiCard } from '@/components/KpiCard';
import { DateRangeControl, CompareModeSelect } from '@/components/AnalyticsFilterBar';

const fmt$ = (v: number) => `$${Math.round(v || 0).toLocaleString()}`;
const fmtNum = (v: number) => (v || 0).toLocaleString();

export default function GeographyAnalytics() {
  const [filters, setFilters] = useState({
    timeframe: 'this_month',
    compareMode: 'pop',
    country: '',
    origin: '',
    destination: '',
    export_only: false,
    dateFrom: '',
    dateTo: ''
  });

  const { data, isLoading } = useQuery({
    queryKey: ['geographyAnalytics', filters],
    queryFn: () => api.getGeographyDashboard({
      timeframe: filters.timeframe,
      date_from: filters.timeframe === 'custom' ? filters.dateFrom : undefined,
      date_to: filters.timeframe === 'custom' ? filters.dateTo : undefined,
      compare_mode: filters.compareMode,
      country: filters.country || undefined,
      origin: filters.origin || undefined,
      destination: filters.destination || undefined,
      export_only: filters.export_only
    }),
    refetchInterval: 30000,
  });

  const updateFilter = (key: string, value: any) => setFilters(f => ({ ...f, [key]: value }));

  if (isLoading || !data) {
    return (
      <div className="flex-1 bg-background flex items-center justify-center min-h-[600px]">
        <div className="flex flex-col items-center gap-3 bg-white p-10 rounded-2xl shadow-sm border border-[#E2E8F0] dark:bg-zinc-900 dark:border-zinc-800">
          <RefreshCw className="animate-spin text-primary" size={32} />
          <span className="font-semibold text-slate-700 text-sm dark:text-zinc-300">Loading Geography Analytics...</span>
        </div>
      </div>
    );
  }

  const kpis = data.kpi_cards;

  const shipBarOption = {
    tooltip: { trigger: 'axis', backgroundColor: '#fff', borderColor: '#e2e8f0', textStyle: { color: '#0f172a' } },
    grid: { left: '3%', right: '4%', bottom: '10%', top: '5%', containLabel: true },
    xAxis: { type: 'category', data: data.shipments_by_country.slice(0,10).map((d:any)=>d.name), axisLabel: { interval: 0, rotate: 30, fontSize: 10 } },
    yAxis: { type: 'value', splitLine: { lineStyle: { type: 'dashed', color: '#e2e8f0' } } },
    series: [{
      type: 'bar',
      data: data.shipments_by_country.slice(0,10).map((d:any)=>d.value),
      itemStyle: { color: '#10b981', borderRadius: [4,4,0,0] }
    }]
  };

  const weightBarOption = {
    tooltip: { trigger: 'axis', backgroundColor: '#fff', borderColor: '#e2e8f0', textStyle: { color: '#0f172a' } },
    // The data label sits outside the bar (position: 'right'), which containLabel does not
    // account for — only axis labels/names are. A fixed right margin wide enough for the
    // longest formatted value (e.g. "1,308,550.2 kg") keeps it from being clipped.
    grid: { left: '3%', right: 90, bottom: '3%', top: '5%', containLabel: true },
    xAxis: { type: 'value', show: false },
    yAxis: { type: 'category', data: data.weight_by_country.slice(0,10).map((d:any)=>d.name).reverse(), axisLine: { show: false }, axisTick: { show: false } },
    series: [{
      type: 'bar',
      data: data.weight_by_country.slice(0,10).map((d:any)=>d.value).reverse(),
      itemStyle: { color: '#f59e0b', borderRadius: [0,4,4,0] },
      label: { show: true, position: 'right', formatter: (p:any) => fmtNum(p.value) + ' kg', fontSize: 10, color: '#64748b' }
    }]
  };

  return (
    <div className="flex-1 overflow-y-auto bg-background relative p-4 sm:p-6 lg:p-8 max-w-[1600px] mx-auto w-full space-y-6">
      
      {/* HEADER */}
      <div className="flex flex-col xl:flex-row xl:items-start justify-between gap-4">
        <div>
          <h1 className="text-xl sm:text-2xl font-black text-slate-900 tracking-tight dark:text-white">Geography</h1>
          <p className="mt-1 text-xs sm:text-sm text-slate-500 font-medium">Geographical insights across customers and shipments.</p>
        </div>
        
        <div className="flex flex-wrap items-center gap-2">
          <DateRangeControl
            timeframe={filters.timeframe} dateFrom={filters.dateFrom} dateTo={filters.dateTo} bounds={data.bounds}
            onPreset={(v) => { updateFilter('timeframe', v); updateFilter('dateFrom', ''); updateFilter('dateTo', ''); }}
            onCustom={(f, t) => { updateFilter('timeframe', 'custom'); updateFilter('dateFrom', f); updateFilter('dateTo', t); }}
          />
          <CompareModeSelect icon={Activity} value={filters.compareMode} onChange={(e) => updateFilter('compareMode', e.target.value)} />
          <ExportButton
            disabled={!data.customers_by_country?.length}
            onExport={() => exportXlsx(`geography-${data.bounds?.c_start ?? ''}_${data.bounds?.c_end ?? ''}`, [{
              name: 'Customers by Country',
              rows: data.customers_by_country.map((r: any) => ({ Country: r.country, Customers: r.customers, Revenue: r.revenue })),
              formats: { Revenue: 'currency' },
            }])}
          />
        </div>
      </div>

      {/* KPI CARDS */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 sm:gap-4">
        <KpiCard title="Countries Served" value={kpis.countries_served.value} icon={Globe} className="border-t-2 border-t-blue-500" />
        <KpiCard title="Int'l Revenue" value={fmt$(kpis.international_revenue.value)} icon={DollarSign} className="border-t-2 border-t-indigo-500" />
        <KpiCard title="Total Shipments" value={fmtNum(kpis.total_shipments.value)} icon={Package} className="border-t-2 border-t-rose-500" />
        <KpiCard title="Total Weight" value={`${fmtNum(kpis.total_weight.value)} kg`} icon={Weight} className="border-t-2 border-t-cyan-500" />
        <KpiCard title="Avg Rev / Country" value={fmt$(kpis.avg_revenue_per_country.value)} icon={TrendingUp} className="border-t-2 border-t-purple-500" />
        <KpiCard title="Avg Ship / Country" value={fmtNum(Math.round(kpis.avg_shipments_per_country.value))} icon={TrendingUp} className="border-t-2 border-t-fuchsia-500" />
      </div>

      {/* CHARTS ROW */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white rounded-[16px] border border-[#E2E8F0] shadow-[0_2px_4px_rgba(15,23,42,0.04)] p-5 dark:bg-zinc-900 dark:border-zinc-800 h-[300px] flex flex-col">
          <h3 className="text-sm font-bold text-slate-900 tracking-tight dark:text-white mb-2">Top Countries by Shipments</h3>
          <div className="flex-1"><ReactECharts option={shipBarOption} style={{ height: '100%' }} /></div>
        </div>
        <div className="bg-white rounded-[16px] border border-[#E2E8F0] shadow-[0_2px_4px_rgba(15,23,42,0.04)] p-5 dark:bg-zinc-900 dark:border-zinc-800 h-[300px] flex flex-col">
          <h3 className="text-sm font-bold text-slate-900 tracking-tight dark:text-white mb-2">Top Countries by Weight</h3>
          <div className="flex-1"><ReactECharts option={weightBarOption} style={{ height: '100%' }} /></div>
        </div>
      </div>

      {/* CUSTOMERS BY COUNTRY */}
      <div className="bg-white rounded-[16px] border border-[#E2E8F0] shadow-[0_2px_4px_rgba(15,23,42,0.04)] overflow-hidden flex flex-col dark:bg-zinc-900 dark:border-zinc-800">
        <div className="p-5 border-b border-[#E2E8F0] dark:border-zinc-800">
          <h3 className="text-sm font-bold text-slate-900 tracking-tight dark:text-white">Customers by Country</h3>
        </div>
        <div className="overflow-x-auto flex-1 h-[300px] overflow-y-auto">
          <table className="w-full text-left text-xs whitespace-nowrap">
            <thead className="bg-slate-50 dark:bg-zinc-800 text-slate-500 border-b border-[#E2E8F0] dark:border-zinc-700 sticky top-0 z-10">
              <tr>
                <th className="px-4 py-3 font-semibold">Country</th>
                <th className="px-4 py-3 font-semibold text-right">Customers</th>
                <th className="px-4 py-3 font-semibold text-right">Revenue</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E2E8F0] dark:divide-zinc-800">
              {data.customers_by_country.map((r:any, i:number) => (
                <tr key={i}>
                  <td className="px-4 py-3 font-medium text-slate-800 dark:text-slate-200">{r.country}</td>
                  <td className="px-4 py-3 text-right text-slate-800 font-medium dark:text-slate-200">{fmtNum(r.customers)}</td>
                  <td className="px-4 py-3 text-right text-slate-600 dark:text-slate-400">{fmt$(r.revenue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

    </div>
  );
}
