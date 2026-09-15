import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api';
import ReactECharts from 'echarts-for-react';
import { useNavigate } from 'react-router-dom';
import {
  RefreshCw,
  Package,
  Weight,
  Layers,
  FileText,
  DollarSign,
  TrendingUp,
  Activity
} from 'lucide-react';
import { KpiCard } from '@/components/KpiCard';
import { DateRangeControl, CompareModeSelect } from '@/components/AnalyticsFilterBar';

const fmt$ = (v: number) => `$${(v || 0).toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})}`;
const fmtNum = (v: number) => (v || 0).toLocaleString();
const fmtDate = (d: string | null) => d ? new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—';

export default function OperationalAnalytics() {
  const navigate = useNavigate();
  const [filters, setFilters] = useState({
    timeframe: 'this_month',
    compareMode: 'pop',
    dateFrom: '',
    dateTo: ''
  });

  const { data, isLoading } = useQuery({
    queryKey: ['operationalAnalytics', filters],
    queryFn: () => api.getOperationalDashboard({
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
          <span className="font-semibold text-slate-700 text-sm dark:text-zinc-300">Loading Operational KPIs...</span>
        </div>
      </div>
    );
  }

  const kpis = data.kpi_cards;
  const trendOption = {
    tooltip: { trigger: 'axis', backgroundColor: '#fff', borderColor: '#e2e8f0', textStyle: { color: '#0f172a' } },
    grid: { left: '3%', right: '4%', bottom: '3%', top: '10%', containLabel: true },
    xAxis: { type: 'category', boundaryGap: false, data: data.trend.map((d:any) => d.date) },
    yAxis: { type: 'value', splitLine: { lineStyle: { type: 'dashed', color: '#e2e8f0' } } },
    series: [
      {
        name: 'Shipments',
        type: 'line',
        smooth: true,
        data: data.trend.map((d:any) => d.shipments),
        itemStyle: { color: '#3b82f6' },
        areaStyle: {
          color: {
            type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [{ offset: 0, color: 'rgba(59,130,246,0.3)' }, { offset: 1, color: 'rgba(59,130,246,0.05)' }]
          }
        }
      }
    ]
  };

  const weightTrendOption = {
    tooltip: { trigger: 'axis', backgroundColor: '#fff', borderColor: '#e2e8f0', textStyle: { color: '#0f172a' } },
    grid: { left: '3%', right: '4%', bottom: '3%', top: '10%', containLabel: true },
    xAxis: { type: 'category', boundaryGap: false, data: data.trend.map((d:any) => d.date) },
    yAxis: { type: 'value', splitLine: { lineStyle: { type: 'dashed', color: '#e2e8f0' } } },
    series: [
      {
        name: 'Weight',
        type: 'line',
        smooth: true,
        data: data.trend.map((d:any) => d.weight),
        itemStyle: { color: '#f59e0b' },
        areaStyle: {
          color: {
            type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [{ offset: 0, color: 'rgba(245,158,11,0.3)' }, { offset: 1, color: 'rgba(245,158,11,0.05)' }]
          }
        }
      }
    ]
  };

  const packagePieceOption = {
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, backgroundColor: '#fff', borderColor: '#e2e8f0', textStyle: { color: '#0f172a' } },
    legend: { data: ['Pieces'], bottom: 0, icon: 'circle' },
    grid: { left: '3%', right: '4%', bottom: '15%', top: '10%', containLabel: true },
    xAxis: { type: 'category', data: data.monthly_operations.map((d:any) => d.month) },
    yAxis: { type: 'value', splitLine: { lineStyle: { type: 'dashed', color: '#e2e8f0' } } },
    series: [
      { name: 'Pieces', type: 'bar', data: data.monthly_operations.map((d:any) => d.pieces), itemStyle: { color: '#10b981', borderRadius: [2,2,0,0] } }
    ]
  };

  return (
    <div className="flex-1 overflow-y-auto bg-background relative p-4 sm:p-6 lg:p-8 max-w-[1600px] mx-auto w-full space-y-6">
      
      {/* HEADER */}
      <div className="flex flex-col xl:flex-row xl:items-start justify-between gap-4">
        <div>
          <h1 className="text-xl sm:text-2xl font-black text-slate-900 tracking-tight dark:text-white">Operational KPIs</h1>
          <p className="mt-1 text-xs sm:text-sm text-slate-500 font-medium">Shipment, cargo and operational performance insights.</p>
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

      {/* MAIN KPI CARDS */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 sm:gap-4">
        <KpiCard title="Total Shipments" value={fmtNum(kpis.total_shipments.value)} icon={Package} className="border-t-2 border-t-blue-500" />
        <KpiCard title="Total MAWBs" value={fmtNum(kpis.total_mawbs.value)} icon={FileText} className="border-t-2 border-t-indigo-500" />
        <KpiCard title="Total Pieces" value={fmtNum(kpis.total_pieces.value)} icon={Layers} className="border-t-2 border-t-fuchsia-500" />
        <KpiCard title="Total Weight" value={`${fmtNum(kpis.total_weight.value)} kg`} icon={Weight} className="border-t-2 border-t-amber-500" />
        <KpiCard title="Avg Shipment Weight" value={`${fmtNum(Math.round(kpis.avg_shipment_weight.value))} kg`} icon={TrendingUp} className="border-t-2 border-t-rose-500" />
        <KpiCard title="Avg Shipment Value" value={fmt$(kpis.avg_shipment_value.value)} icon={DollarSign} className="border-t-2 border-t-emerald-500" />
      </div>

      {/* TRENDS */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="bg-white rounded-[16px] border border-[#E2E8F0] shadow-[0_2px_4px_rgba(15,23,42,0.04)] p-5 dark:bg-zinc-900 dark:border-zinc-800 h-[300px] flex flex-col">
          <h3 className="text-sm font-bold text-slate-900 tracking-tight dark:text-white mb-2">Shipment Trend</h3>
          <ReactECharts option={trendOption} style={{ height: '100%' }} />
        </div>
        <div className="bg-white rounded-[16px] border border-[#E2E8F0] shadow-[0_2px_4px_rgba(15,23,42,0.04)] p-5 dark:bg-zinc-900 dark:border-zinc-800 h-[300px] flex flex-col">
          <h3 className="text-sm font-bold text-slate-900 tracking-tight dark:text-white mb-2">Weight Trend</h3>
          <ReactECharts option={weightTrendOption} style={{ height: '100%' }} />
        </div>
        <div className="bg-white rounded-[16px] border border-[#E2E8F0] shadow-[0_2px_4px_rgba(15,23,42,0.04)] p-5 dark:bg-zinc-900 dark:border-zinc-800 h-[300px] flex flex-col">
          <h3 className="text-sm font-bold text-slate-900 tracking-tight dark:text-white mb-2">Package & Piece Trend</h3>
          <ReactECharts option={packagePieceOption} style={{ height: '100%' }} />
        </div>
      </div>

      {/* TABLE: TOP MAWBS */}
      <div className="bg-white rounded-[16px] border border-[#E2E8F0] shadow-[0_2px_4px_rgba(15,23,42,0.04)] p-5 dark:bg-zinc-900 dark:border-zinc-800 flex flex-col">
        <h3 className="text-sm font-bold text-slate-900 tracking-tight dark:text-white mb-4">Top MAWBs</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs whitespace-nowrap">
            <thead>
              <tr className="border-b border-slate-100 dark:border-zinc-800 text-slate-500 font-bold uppercase tracking-wider">
                <th className="pb-3 px-2">MAWB</th>
                <th className="pb-3 px-2 text-right">Shipments</th>
                <th className="pb-3 px-2 text-right">Weight</th>
                <th className="pb-3 px-2 text-right">Revenue</th>
              </tr>
            </thead>
            <tbody>
              {data.top_mawbs.slice(0, 10).map((row:any, idx:number) => (
                <tr key={idx} className="border-b border-slate-50 dark:border-zinc-800/50 cursor-pointer transition-colors" onClick={() => navigate(`/app/mawb?search=${row.mawb}`)}>
                  <td className="py-2.5 px-2 font-bold text-slate-800 dark:text-slate-200">{row.mawb}</td>
                  <td className="py-2.5 px-2 text-right font-medium text-slate-800 dark:text-slate-300">{fmtNum(row.shipments)}</td>
                  <td className="py-2.5 px-2 text-right font-medium text-slate-800 dark:text-slate-300">{fmtNum(row.weight)} kg</td>
                  <td className="py-2.5 px-2 text-right font-medium text-emerald-600">{fmt$(row.revenue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* TABLES: TOP SHIPMENTS & TOP CUSTOMERS */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white rounded-[16px] border border-[#E2E8F0] shadow-[0_2px_4px_rgba(15,23,42,0.04)] p-5 dark:bg-zinc-900 dark:border-zinc-800 flex flex-col">
          <h3 className="text-sm font-bold text-slate-900 tracking-tight dark:text-white mb-4">Top Shipments</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs whitespace-nowrap">
              <thead>
                <tr className="border-b border-slate-100 dark:border-zinc-800 text-slate-500 font-bold uppercase tracking-wider">
                  <th className="pb-3 px-2">Date</th>
                  <th className="pb-3 px-2">AWB</th>
                  <th className="pb-3 px-2 text-right">Weight</th>
                  <th className="pb-3 px-2 text-right">Revenue</th>
                </tr>
              </thead>
              <tbody>
                {data.top_shipments.slice(0, 10).map((row:any, idx:number) => (
                  <tr key={idx} className="border-b border-slate-50 dark:border-zinc-800/50 cursor-pointer transition-colors" onClick={() => navigate(`/app/search?intent=360&q=${row.awb}`)}>
                    <td className="py-2.5 px-2 text-slate-600 dark:text-slate-400">{fmtDate(row.shipment_date)}</td>
                    <td className="py-2.5 px-2 font-bold text-slate-800 dark:text-slate-200">{row.awb}</td>
                    <td className="py-2.5 px-2 text-right font-medium text-slate-800 dark:text-slate-300">{fmtNum(row.weight)} kg</td>
                    <td className="py-2.5 px-2 text-right font-medium text-emerald-600">{fmt$(row.revenue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="bg-white rounded-[16px] border border-[#E2E8F0] shadow-[0_2px_4px_rgba(15,23,42,0.04)] p-5 dark:bg-zinc-900 dark:border-zinc-800 flex flex-col">
          <h3 className="text-sm font-bold text-slate-900 tracking-tight dark:text-white mb-4">Top Operational Customers</h3>
          <table className="w-full text-left text-xs table-fixed">
            <colgroup>
              <col />
              <col className="w-14" />
              <col className="w-28" />
              <col className="w-28" />
            </colgroup>
            <thead>
              <tr className="border-b border-slate-100 dark:border-zinc-800 text-slate-500 font-bold uppercase tracking-wider">
                <th className="pb-3 px-2">Customer</th>
                <th className="pb-3 px-2 text-right">Shipments</th>
                <th className="pb-3 px-2 text-right">Weight</th>
                <th className="pb-3 px-2 text-right">Revenue</th>
              </tr>
            </thead>
            <tbody>
              {data.top_customers.slice(0, 10).map((row:any, idx:number) => (
                <tr key={idx} className="border-b border-slate-50 dark:border-zinc-800/50 cursor-pointer transition-colors" onClick={() => navigate(`/app/search?intent=360&company_id=${row.company_id}`)}>
                  <td className="py-2.5 px-2 font-bold text-slate-800 dark:text-slate-200 truncate" title={row.customer}>{row.customer}</td>
                  <td className="py-2.5 px-2 text-right font-medium text-slate-800 dark:text-slate-300 whitespace-nowrap">{fmtNum(row.shipments)}</td>
                  <td className="py-2.5 px-2 text-right font-medium text-slate-800 dark:text-slate-300 whitespace-nowrap">{fmtNum(row.weight)} kg</td>
                  <td className="py-2.5 px-2 text-right font-medium text-emerald-600 whitespace-nowrap">{fmt$(row.revenue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

    </div>
  );
}
