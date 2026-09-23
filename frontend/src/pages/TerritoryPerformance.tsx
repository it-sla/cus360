import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api';
import ReactECharts from 'echarts-for-react';
import {
  RefreshCw, MapPin, DollarSign, Package, Weight, Users, Download, Activity,
} from 'lucide-react';
import { KpiCard } from '@/components/KpiCard';
import { DateRangeControl, CompareModeSelect } from '@/components/AnalyticsFilterBar';

const fmt$ = (v: number) => `$${v >= 1_000_000 ? (v / 1_000_000).toFixed(2) + 'M' : v >= 1000 ? (v / 1000).toFixed(1) + 'k' : Math.round(v || 0).toLocaleString()}`;
const fmtNum = (v: number) => (v || 0).toLocaleString();

export default function TerritoryPerformance() {
  const [filters, setFilters] = useState({ timeframe: 'this_month', compareMode: 'pop', dateFrom: '', dateTo: '' });
  const [selectedTerritory, setSelectedTerritory] = useState<string | null>(null);
  const updateFilter = (key: string, value: any) => setFilters(f => ({ ...f, [key]: value }));

  const { data, isLoading } = useQuery({
    queryKey: ['territoryPerformance', filters],
    queryFn: () => api.getTerritoryPerformance({
      timeframe: filters.timeframe,
      date_from: filters.timeframe === 'custom' ? filters.dateFrom : undefined,
      date_to: filters.timeframe === 'custom' ? filters.dateTo : undefined,
      compare_mode: filters.compareMode,
    }),
  });

  if (isLoading || !data) {
    return (
      <div className="flex-1 bg-background flex items-center justify-center min-h-[600px]">
        <div className="flex flex-col items-center gap-3 bg-white p-10 rounded-2xl shadow-sm border border-[#E2E8F0] dark:bg-zinc-900 dark:border-zinc-800">
          <RefreshCw className="animate-spin text-primary" size={32} />
          <span className="font-semibold text-slate-700 text-sm dark:text-zinc-300">Loading Territory Performance...</span>
        </div>
      </div>
    );
  }

  const items = data.items;
  const totals = items.reduce((t, i) => ({
    revenue: t.revenue + i.revenue, shipments: t.shipments + i.shipments,
    weight: t.weight + i.weight, companies: t.companies + i.companies,
  }), { revenue: 0, shipments: 0, weight: 0, companies: 0 });

  const drill = selectedTerritory ? items.find(i => i.territory === selectedTerritory) : null;

  // Full names now carry a parenthetical area range (e.g. "Territory 1 — North & West
  // Kathmandu (Thamel to Sitapaila)") which is too long for an axis label or pie slice —
  // charts get a short label ("Territory 1", "Resellers") and the full name in the tooltip.
  const shortLabel = (t: string) => t.match(/^Territory \d+/)?.[0] ?? t;

  const revenueBarOption = {
    tooltip: {
      trigger: 'axis', backgroundColor: '#fff', borderColor: '#e2e8f0', textStyle: { color: '#0f172a' },
      formatter: (params: any) => {
        const p = params[0];
        return `${items[p.dataIndex].territory}<br/>${fmt$(p.value)}`;
      },
    },
    grid: { left: '3%', right: '4%', bottom: '10%', top: '8%', containLabel: true },
    xAxis: { type: 'category', data: items.map(i => shortLabel(i.territory)), axisLabel: { interval: 0, fontSize: 11, fontWeight: 'bold' } },
    yAxis: { type: 'value', splitLine: { lineStyle: { type: 'dashed', color: '#e2e8f0' } } },
    series: [{ type: 'bar', data: items.map(i => i.revenue), itemStyle: { color: '#10b981', borderRadius: [4, 4, 0, 0] } }],
  };

  const sharePieOption = {
    tooltip: {
      trigger: 'item',
      formatter: (params: any) => `${items[params.dataIndex].territory}<br/>${fmt$(params.value)} (${params.percent}%)`,
    },
    legend: { show: false },
    series: [{
      type: 'pie', radius: ['45%', '75%'], avoidLabelOverlap: true,
      label: { formatter: (p: any) => `${shortLabel(items[p.dataIndex].territory)}\n{d}%`.replace('{d}', p.percent.toFixed(0)), fontSize: 11, fontWeight: 'bold' },
      data: items.map(i => ({ name: shortLabel(i.territory), value: i.revenue })),
    }],
  };

  return (
    <div className="flex-1 overflow-y-auto bg-background relative p-4 sm:p-6 lg:p-8 max-w-[1600px] mx-auto w-full space-y-6">

      <div className="flex flex-col xl:flex-row xl:items-start justify-between gap-4">
        <div>
          <h1 className="text-xl sm:text-2xl font-black text-slate-900 tracking-tight dark:text-white">Territory Performance</h1>
          <p className="mt-1 text-xs sm:text-sm text-slate-500 font-medium">Revenue and customer performance grouped by sales territory.</p>
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

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4">
        <KpiCard title="Total Revenue" value={fmt$(totals.revenue)} icon={DollarSign} className="border-t-2 border-t-emerald-500" />
        <KpiCard title="Total Shipments" value={fmtNum(totals.shipments)} icon={Package} className="border-t-2 border-t-blue-500" />
        <KpiCard title="Total Weight" value={`${fmtNum(Math.round(totals.weight))} kg`} icon={Weight} className="border-t-2 border-t-cyan-500" />
        <KpiCard title="Total Customers" value={fmtNum(totals.companies)} icon={Users} className="border-t-2 border-t-purple-500" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white rounded-[16px] border border-[#E2E8F0] shadow-[0_2px_4px_rgba(15,23,42,0.04)] p-5 dark:bg-zinc-900 dark:border-zinc-800 h-[320px] flex flex-col">
          <h3 className="text-sm font-bold text-slate-900 tracking-tight dark:text-white mb-2">Revenue by Territory</h3>
          <div className="flex-1"><ReactECharts option={revenueBarOption} style={{ height: '100%' }} /></div>
        </div>
        <div className="bg-white rounded-[16px] border border-[#E2E8F0] shadow-[0_2px_4px_rgba(15,23,42,0.04)] p-5 dark:bg-zinc-900 dark:border-zinc-800 h-[320px] flex flex-col">
          <h3 className="text-sm font-bold text-slate-900 tracking-tight dark:text-white mb-2">Revenue Share</h3>
          <div className="flex-1"><ReactECharts option={sharePieOption} style={{ height: '100%' }} /></div>
        </div>
      </div>

      <div className="bg-white rounded-[16px] border border-[#E2E8F0] shadow-[0_2px_4px_rgba(15,23,42,0.04)] dark:bg-zinc-900 dark:border-zinc-800 overflow-hidden">
        <div className="p-5 pb-2 flex items-center justify-between">
          <h3 className="text-sm font-bold text-slate-900 tracking-tight dark:text-white">Territories</h3>
          <button
            onClick={() => {
              const head = ['Territory', 'Revenue', 'Prev Revenue', 'Growth %', 'Share %', 'Shipments', 'Customers', 'Weight (kg)'];
              const body = items.map(i => [i.territory, i.revenue, i.prev_revenue, i.revenue_growth_pct, i.revenue_share_pct, i.shipments, i.companies, i.weight]);
              const csv = [head, ...body].map(r => r.map(v => `"${String(v ?? '')}"`).join(',')).join('\n');
              const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
              const a = document.createElement('a'); a.href = url;
              a.download = `territory-performance-${data.bounds.c_start}_${data.bounds.c_end}.csv`;
              a.click(); URL.revokeObjectURL(url);
            }}
            className="h-8 px-3 bg-white border border-[#DCE3EC] text-slate-700 rounded-lg text-xs font-bold flex items-center gap-1.5 hover:bg-slate-50 shadow-sm dark:bg-zinc-950 dark:border-zinc-800 dark:text-zinc-300"
          >
            <Download size={13} /> Export
          </button>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-t border-b border-[#E2E8F0] dark:border-zinc-800 text-left text-[10px] font-bold uppercase tracking-wider text-slate-500">
              <th className="px-5 py-2.5">Territory</th>
              <th className="px-5 py-2.5 text-right">Revenue</th>
              <th className="px-5 py-2.5 text-right">Growth</th>
              <th className="px-5 py-2.5 text-right">Share</th>
              <th className="px-5 py-2.5 text-right">Shipments</th>
              <th className="px-5 py-2.5 text-right">Customers</th>
              <th className="px-5 py-2.5 text-right">Avg Rev/Customer</th>
            </tr>
          </thead>
          <tbody>
            {items.map(item => (
              <tr
                key={item.territory}
                onClick={() => setSelectedTerritory(item.territory === selectedTerritory ? null : item.territory)}
                className={`border-b border-[#E2E8F0] dark:border-zinc-800 cursor-pointer hover:bg-slate-50 dark:hover:bg-zinc-800/50 ${selectedTerritory === item.territory ? 'bg-slate-50 dark:bg-zinc-800/50' : ''}`}
              >
                <td className="px-5 py-3 font-semibold text-slate-900 dark:text-white flex items-center gap-2">
                  <MapPin size={13} className="text-slate-400" /> {item.territory}
                </td>
                <td className="px-5 py-3 text-right font-bold text-slate-900 dark:text-white">{fmt$(item.revenue)}</td>
                <td className={`px-5 py-3 text-right font-semibold ${item.revenue_growth_pct >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                  {item.revenue_growth_pct >= 0 ? '+' : ''}{item.revenue_growth_pct.toFixed(1)}%
                </td>
                <td className="px-5 py-3 text-right text-slate-600 dark:text-zinc-400">{item.revenue_share_pct.toFixed(1)}%</td>
                <td className="px-5 py-3 text-right text-slate-600 dark:text-zinc-400">{fmtNum(item.shipments)}</td>
                <td className="px-5 py-3 text-right text-slate-600 dark:text-zinc-400">{fmtNum(item.companies)}</td>
                <td className="px-5 py-3 text-right text-slate-600 dark:text-zinc-400">{fmt$(item.avg_revenue_per_customer)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {drill && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-white rounded-[16px] border border-[#E2E8F0] shadow-[0_2px_4px_rgba(15,23,42,0.04)] dark:bg-zinc-900 dark:border-zinc-800 overflow-hidden">
            <div className="p-5 pb-2">
              <h3 className="text-sm font-bold text-slate-900 tracking-tight dark:text-white">{drill.territory} — AEs</h3>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-t border-b border-[#E2E8F0] dark:border-zinc-800 text-left text-[10px] font-bold uppercase tracking-wider text-slate-500">
                  <th className="px-5 py-2.5">AE</th>
                  <th className="px-5 py-2.5 text-right">Revenue</th>
                  <th className="px-5 py-2.5 text-right">Shipments</th>
                  <th className="px-5 py-2.5 text-right">Customers</th>
                </tr>
              </thead>
              <tbody>
                {drill.ae_breakdown.map(ae => (
                  <tr key={ae.ae_code} className="border-b border-[#E2E8F0] dark:border-zinc-800">
                    <td className="px-5 py-3 font-semibold text-slate-900 dark:text-white">{ae.ae_code}</td>
                    <td className="px-5 py-3 text-right text-slate-600 dark:text-zinc-400">{fmt$(ae.revenue)}</td>
                    <td className="px-5 py-3 text-right text-slate-600 dark:text-zinc-400">{fmtNum(ae.shipments)}</td>
                    <td className="px-5 py-3 text-right text-slate-600 dark:text-zinc-400">{fmtNum(ae.companies)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="bg-white rounded-[16px] border border-[#E2E8F0] shadow-[0_2px_4px_rgba(15,23,42,0.04)] dark:bg-zinc-900 dark:border-zinc-800 overflow-hidden">
            <div className="p-5 pb-2">
              <h3 className="text-sm font-bold text-slate-900 tracking-tight dark:text-white">{drill.territory} — Top Customers</h3>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-t border-b border-[#E2E8F0] dark:border-zinc-800 text-left text-[10px] font-bold uppercase tracking-wider text-slate-500">
                  <th className="px-5 py-2.5">Customer</th>
                  <th className="px-5 py-2.5 text-right">Revenue</th>
                  <th className="px-5 py-2.5 text-right">Shipments</th>
                </tr>
              </thead>
              <tbody>
                {drill.customers.slice(0, 15).map(c => (
                  <tr key={c.company_id} className="border-b border-[#E2E8F0] dark:border-zinc-800">
                    <td className="px-5 py-3 font-semibold text-slate-900 dark:text-white truncate max-w-[220px]">{c.company_name}</td>
                    <td className="px-5 py-3 text-right text-slate-600 dark:text-zinc-400">{fmt$(c.revenue)}</td>
                    <td className="px-5 py-3 text-right text-slate-600 dark:text-zinc-400">{fmtNum(c.shipments)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
