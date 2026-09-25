import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api';
import { motion } from 'motion/react';
import ReactECharts from 'echarts-for-react';
import {
  DollarSign,
  Users,
  UserPlus,
  Package,
  TrendingUp,
  Loader2,
  Activity,
  ArrowRight,
  X,
  Globe,
  Trophy,
  Repeat,
  Layers
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { KpiCard } from '@/components/KpiCard';
import { ExportButton } from '@/components/ExportButton';
import { exportXlsx } from '@/lib/exportXlsx';
import { useNavigate } from 'react-router-dom';
import { DateRangeControl, CompareModeSelect } from '@/components/AnalyticsFilterBar';

export default function ExecutiveOverview() {
  const navigate = useNavigate();
  const [timeframe, setTimeframe] = React.useState('this_month');
  const [startDate, setStartDate] = React.useState('');
  const [endDate, setEndDate] = React.useState('');
  const [compareMode, setCompareMode] = React.useState('pop');
  const [selectedKpi, setSelectedKpi] = React.useState<{ title: string; value: string; data: any; list?: any[] } | null>(null);
  const [showAllCustomers, setShowAllCustomers] = React.useState(false);
  const [showAllDestinations, setShowAllDestinations] = React.useState(false);

  const { data: d, isLoading, error } = useQuery({
    queryKey: ['executive-dashboard', timeframe, startDate, endDate, compareMode],
    queryFn: () => api.getExecutiveDashboard({
      timeframe,
      date_from: timeframe === 'custom' ? startDate : undefined,
      date_to: timeframe === 'custom' ? endDate : undefined,
      compare_mode: compareMode,
    }),
    refetchInterval: 300000,
  });

  const { data: allCustomers, isFetching: allCustomersFetching } = useQuery({
    queryKey: ['top-customers-all', timeframe, startDate, endDate],
    queryFn: () => api.getTopCustomers({ timeframe, date_from: timeframe === 'custom' ? startDate : undefined, date_to: timeframe === 'custom' ? endDate : undefined, limit: 500 }),
    enabled: showAllCustomers,
    staleTime: 300000,
  });

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center bg-background">
        <Loader2 className="animate-spin text-primary" size={32} />
      </div>
    );
  }

  if (error || !d) {
    return (
      <div className="p-8 text-danger bg-background h-full">
        Failed to load executive dashboard. Backend might be unreachable.
      </div>
    );
  }

  // --- KPI DATA PREP ---
  const kpi = d.kpi_cards || {};
  const rev = kpi.total_billing || { value: 0, pop_pct: 0 };
  const cust = kpi.active_customers || { value: 0, pop_pct: 0 };
  const newAcct = kpi.new_customers || { value: 0, pop_pct: 0 };
  const reactivatedAcct = kpi.reactivated_customers || { value: 0, pop_pct: 0 };
  
  const totalShipments = d.sp_manifest_report?.total_shipment_count || 0;

  // Latest MAWB manifest date for the live-data indicator (more operationally meaningful
  // than the CRM scraper's last-run time).
  const syncLabel = d.latest_manifest_date
    ? `Latest manifest: ${new Date(d.latest_manifest_date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`
    : 'No manifests yet';

  const arpu = kpi.avg_revenue_per_customer?.value || 0;
  
  const formatMoney = (val: number | undefined | null) => {
    if (val === undefined || val === null || isNaN(val)) return '$0';
    return val >= 1000000 
      ? `$${(val / 1000000).toFixed(2)}M` 
      : `$${val.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  };

  // --- REAL DATA MAPPINGS ---
  
  // Top Customers
  const topCustomers = d.revenue_analytics?.top_customers || [];

  // Top Destinations — this list is capped to the top 8 for the chart, so it's never the
  // real count of countries served; use the backend's own distinct-country count for that.
  const countries = d.customer_behavior?.country_segmentation || [];
  const countriesServedCount = d.customer_behavior?.countries_served_count ?? countries.length;
  const maxCountryRev = Math.max(...countries.map((c: any) => c.revenue || 0), 1);

  // Revenue Distribution (Donut)
  const tiers = d.customer_behavior?.revenue_tiers || [];
  const getTierColor = (tierName: string, index: number) => {
    if (!tierName) return '#ec4899';
    const name = tierName.toLowerCase();
    if (name.includes('key')) return '#3b82f6'; // Bright Blue
    if (name.includes('strategic')) return '#3b82f6'; // Bright Blue
    if (name.includes('reseller')) return '#8b5cf6'; // Violet
    if (name.includes('large')) return '#10b981'; // Emerald Green
    if (name.includes('sme')) return '#f59e0b'; // Amber Gold
    if (name.includes('small')) return '#ec4899'; // Pink / Magenta
    const colors = ['#3b82f6', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6', '#06b6d4'];
    return colors[index % colors.length];
  };

  const exportExcel = async () => {
    const all = await api.getTopCustomers({ timeframe, date_from: timeframe === 'custom' ? startDate : undefined, date_to: timeframe === 'custom' ? endDate : undefined, limit: 2000 });
    exportXlsx(`executive-overview-${d.bounds?.c_start ?? ''}_${d.bounds?.c_end ?? ''}`, [
      {
        name: 'Customers',
        rows: all.items.map((c: any, i: number) => ({ Rank: c.rank ?? i + 1, Company: c.company_name, ICRIS: c.icris_number ?? '', Revenue: c.revenue, AWBs: c.shipments, 'Weight (kg)': c.weight })),
        formats: { Revenue: 'currency', 'Weight (kg)': 'decimal' },
      },
      { name: 'Destinations', rows: countries.map((c: any) => ({ Country: c.name || 'Unknown', Revenue: c.revenue, Shipments: c.value })), formats: { Revenue: 'currency' } },
      { name: 'Revenue Tiers', rows: tiers.map((t: any) => ({ Tier: t.tier, Accounts: t.count })) },
    ]);
  };

  const donutData = tiers.map((t: any, i: number) => ({
    value: t.count,
    name: t.tier,
    list: t.list || [],
    itemStyle: { 
      color: getTierColor(t.tier, i)
    }
  }));

  const totalTierAccounts = tiers.reduce((acc: number, t: any) => acc + (t.count || 0), 0);

  const donutOption = donutData.length > 0 ? {
    tooltip: { 
      trigger: 'item', 
      confine: true, 
      backgroundColor: '#18181b', 
      borderColor: '#3f3f46', 
      textStyle: { color: '#fafafa' },
      formatter: (params: any) => {
        return `<div style="padding: 2px 4px;">
          <div style="font-weight: 700; font-size: 12px; margin-bottom: 2px;">${params.name}</div>
          <div style="font-size: 11px; opacity: 0.8;">${params.value} accounts (${params.percent}%)</div>
        </div>`;
      }
    },
    legend: { show: false },
    graphic: {
      type: 'text',
      left: 'center',
      top: 'center',
      style: {
        text: `${totalTierAccounts}\nTotal`,
        textAlign: 'center',
        fill: '#94a3b8',
        fontSize: 12,
        fontWeight: 'bold',
        lineHeight: 15
      }
    },
    series: [
      {
        name: 'Revenue Tiers',
        type: 'pie',
        radius: ['62%', '84%'],
        center: ['50%', '50%'],
        avoidLabelOverlap: false,
        label: { show: false },
        itemStyle: { borderWidth: 2, borderColor: 'transparent' },
        data: donutData
      }
    ]
  } : null;

  // Customer Distribution counts
  const dormantCount = d.customer_growth?.dormant_customers?.length || 0;
  const strategicCount = tiers.find((t: any) => t.tier === 'Key Account')?.count || 0;

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8 max-w-[1600px] mx-auto w-full bg-background space-y-5"
    >
      {/* 1. HEADER SECTION (No background) */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-2">
        <div>
          <h1 className="text-xl sm:text-2xl font-black tracking-tight text-slate-900">
            Executive Command Center
          </h1>
          <p className="text-xs sm:text-sm text-slate-500 font-medium mt-1 flex items-center gap-2 flex-wrap">
            <span>"What is happening right now?" — Today's operational snapshot.</span>
            <span
              className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-emerald-600"
              title={d.latest_manifest_date ? new Date(d.latest_manifest_date).toLocaleDateString() : undefined}
            >
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
              </span>
              {syncLabel}
            </span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <DateRangeControl
            timeframe={timeframe} dateFrom={startDate} dateTo={endDate} bounds={d?.bounds}
            onPreset={(v) => { setTimeframe(v); setStartDate(''); setEndDate(''); }}
            onCustom={(f, t) => { setTimeframe('custom'); setStartDate(f); setEndDate(t); }}
          />
          <CompareModeSelect icon={Activity} value={compareMode} onChange={(e) => setCompareMode(e.target.value)} />
          <ExportButton onExport={exportExcel} />
        </div>
      </div>

      {/* 2 & 6. KPI ROW WITH TOP ACCENT BORDERS */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-4">
        <KpiCard 
          title="Gross Revenue" 
          value={formatMoney(rev.value)} 
          icon={DollarSign} 
          trend={rev.pop_pct} 
          className="border-t-2 border-t-zinc-50"
          onClick={() => setSelectedKpi({ title: 'Gross Revenue', value: formatMoney(rev.value), data: { 'Top Revenue Driver': d.executive_insights?.top_revenue_driver?.company_name || 'N/A', 'Revenue per Shipment': formatMoney(d.operational_analytics?.revenue_per_shipment || 0), ...rev } })}
        />
        <KpiCard 
          title="Active Customers" 
          value={cust.value.toLocaleString()} 
          icon={Users} 
          trend={cust.pop_pct} 
          className="border-t-2 border-t-zinc-50"
          onClick={() => setSelectedKpi({ title: 'Active Customers', value: cust.value.toLocaleString(), data: { 'Strategic Accounts': strategicCount, 'Dormant Customers': dormantCount, 'Active Customers List': cust.list || [] } })}
        />
        <KpiCard
          title="Total Shipments (AWBs)"
          value={totalShipments.toLocaleString()}
          icon={Package}
          trend={kpi.total_invoices?.pop_pct}
          className="border-t-2 border-t-zinc-50"
          onClick={() => setSelectedKpi({ title: 'Total Shipments', value: totalShipments.toLocaleString(), data: { 'Total Packages': (d.operational_analytics as any)?.total_packages || 0, 'Avg Pkgs / Shipment': (d.operational_analytics as any)?.avg_packages_per_shipment?.toFixed(1) || 0, 'Countries Served': countriesServedCount } })}
        />
        <KpiCard 
          title="New Customers" 
          value={newAcct.value.toLocaleString()} 
          icon={UserPlus} 
          trend={newAcct.pop_pct} 
          className="border-t-2 border-t-zinc-50"
          onClick={() => setSelectedKpi({ title: 'New Customers', value: newAcct.value.toLocaleString(), data: { 'New Customer Count': newAcct.value, 'Previous Period': newAcct.prev, 'Recent Onboards List': newAcct.list || [] } })}
        />
        <KpiCard 
          title="Reactivated Customers" 
          value={reactivatedAcct.value.toLocaleString()} 
          icon={Repeat} 
          trend={reactivatedAcct.pop_pct} 
          className="border-t-2 border-t-emerald-500 cursor-pointer"
          onClick={() => setSelectedKpi({ title: 'Reactivated Customers', value: reactivatedAcct.value.toLocaleString(), data: { 'Reactivated Count': reactivatedAcct.value, 'Previous Period': reactivatedAcct.prev, 'Reactivated Customers List': reactivatedAcct.list || [] } })}
        />
        <KpiCard 
          title="Avg Rev per Customer" 
          value={formatMoney(arpu)} 
          icon={TrendingUp} 
          className="border-t-2 border-t-zinc-50"
          onClick={() => setSelectedKpi({ title: 'Avg Rev per Customer', value: formatMoney(arpu), data: { 'Repeat Purchase Rate': d.customer_behavior?.repeat_purchase_rate ? `${d.customer_behavior.repeat_purchase_rate.toFixed(1)}%` : '0%', 'Value': arpu } })}
        />
      </div>

      {/* 3 & 7. BUSINESS SNAPSHOT CONTAINER WITH ICONS */}
      <div>
        <h2 className="text-sm font-bold text-slate-900 dark:text-slate-100 mb-3 tracking-tight">Business Snapshot</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3.5">
          
          {/* 1. Total Packages */}
          <KpiCard 
            title="Total Packages"
            value={d.operational_analytics?.total_packages?.toLocaleString() || 0}
            icon={Package}
            className="border-t-2 border-t-blue-500/80"
            onClick={() => setSelectedKpi({ title: 'Total Packages', value: d.operational_analytics?.total_packages?.toLocaleString() || '0', data: d.operational_analytics })}
          />

          {/* 2. Avg Pkgs / Shipment */}
          <KpiCard 
            title="Avg Pkgs / Shipment"
            value={d.operational_analytics?.avg_packages_per_shipment?.toFixed(1) || 0}
            icon={Layers}
            className="border-t-2 border-t-indigo-500/80"
            onClick={() => setSelectedKpi({ title: 'Avg Packages per Shipment', value: d.operational_analytics?.avg_packages_per_shipment?.toFixed(1) || '0', data: d.operational_analytics })}
          />

          {/* 3. Countries Served */}
          <KpiCard
            title="Countries Served"
            value={countriesServedCount}
            icon={Globe}
            className="border-t-2 border-t-sky-500/80"
            onClick={() => setSelectedKpi({ title: 'Countries Served', value: countriesServedCount.toString(), list: countries.map((c: any) => `${c.country || c.name || c} (${c.shipment_count || c.count || 0} shipments)`), data: countries })}
          />

          {/* 4. Top Revenue Driver */}
          <KpiCard 
            title="Top Revenue Driver"
            value={d.executive_insights?.top_revenue_driver?.company_name || 'N/A'}
            icon={Trophy}
            className="border-t-2 border-t-amber-500/80"
            onClick={() => setSelectedKpi({ 
              title: 'Top Revenue Driver', 
              value: d.executive_insights?.top_revenue_driver?.company_name || 'N/A', 
              data: d.executive_insights?.top_revenue_driver 
            })}
          />

          {/* 5. Avg Rev / Shipment */}
          <KpiCard 
            title="Avg Rev / Shipment"
            value={formatMoney(d.operational_analytics?.revenue_per_shipment || 0)}
            icon={DollarSign}
            className="border-t-2 border-t-emerald-500/80"
            onClick={() => setSelectedKpi({ title: 'Avg Revenue per Shipment', value: formatMoney(d.operational_analytics?.revenue_per_shipment || 0), data: d.operational_analytics })}
          />

          {/* 6. Revenue Growth Rate */}
          <KpiCard
            title="Growth Rate"
            value={d.kpi_cards?.growth_rate?.value !== undefined ? `${d.kpi_cards.growth_rate.value.toFixed(1)}%` : '0%'}
            icon={TrendingUp}
            className="border-t-2 border-t-purple-500/80"
            onClick={() => setSelectedKpi({
              title: 'Revenue Growth Rate',
              value: d.kpi_cards?.growth_rate?.value !== undefined ? `${d.kpi_cards.growth_rate.value.toFixed(1)}%` : '0%',
              data: {
                'Growth %': `${d.kpi_cards?.growth_rate?.value?.toFixed(1) || 0}%`,
                'Current Period Revenue': formatMoney(d.kpi_cards?.total_billing?.value || 0),
                'Previous Period Revenue': formatMoney(d.kpi_cards?.total_billing?.prev || 0)
              }
            })}
          />

        </div>
      </div>

      {/* 3. TOP CUSTOMERS & TOP DESTINATIONS CONTAINER */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* Top Customers Container */}
        <div className="bg-white border border-[#DCE3EC] rounded-[16px] p-5 shadow-[0_2px_8px_rgba(15,23,42,0.05)] flex flex-col justify-between">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-bold text-slate-900 tracking-tight">Top Customers</h2>
            <Button variant="ghost" size="sm" className="h-7 text-xs text-primary font-semibold hover:bg-primary/5" onClick={() => setShowAllCustomers(true)}>
              View All <ArrowRight size={12} className="ml-1" />
            </Button>
          </div>
          <div className="border border-slate-100 rounded-xl overflow-hidden">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50/80 border-b border-slate-100">
                <tr className="text-[10px] uppercase font-bold tracking-wider text-slate-500">
                  <th className="px-4 py-2.5">Company</th>
                  <th className="px-4 py-2.5 text-right">Revenue</th>
                  <th className="px-4 py-2.5 text-right">AWBs</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {topCustomers.length > 0 ? topCustomers.slice(0, 5).map((c: any, i: number) => (
                  <tr key={i} className="transition-colors">
                    <td className="px-4 py-3 font-semibold text-slate-800 max-w-[200px] truncate">{c.company_name}</td>
                    <td className="px-4 py-3 text-right font-bold text-slate-900">{formatMoney(c.revenue)}</td>
                    <td className="px-4 py-3 text-right text-slate-500 font-medium">{c.shipments}</td>
                  </tr>
                )) : (
                  <tr>
                    <td colSpan={3} className="px-4 py-6 text-center text-slate-400">No customer data available</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Top Destinations Container */}
        <div className="bg-white border border-[#DCE3EC] rounded-[16px] p-5 shadow-[0_2px_8px_rgba(15,23,42,0.05)] flex flex-col justify-between">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-bold text-slate-900 tracking-tight">Top Destinations</h2>
            <Button variant="ghost" size="sm" className="h-7 text-xs text-primary font-semibold hover:bg-primary/5" onClick={() => setShowAllDestinations(true)}>
              View All <ArrowRight size={12} className="ml-1" />
            </Button>
          </div>
          <div className="flex flex-col justify-center space-y-4 min-h-[160px]">
            {countries.length > 0 ? countries.slice(0, 5).map((dest: any, i: number) => {
              const pct = (dest.revenue / maxCountryRev) * 100;
              return (
                <div key={i} className="flex items-center gap-3">
                  <span className="text-xs font-semibold text-slate-700 w-24 truncate" title={dest.name}>{dest.name || 'Unknown'}</span>
                  <div className="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden">
                    <div className="h-full bg-blue-600 rounded-full" style={{ width: `${pct}%` }} />
                  </div>
                  <div className="text-[10px] text-slate-500 w-24 text-right flex flex-col leading-tight">
                    <span className="font-bold text-slate-900">{formatMoney(dest.revenue)}</span>
                    <span>{dest.value} shipments</span>
                  </div>
                </div>
              );
            }) : (
              <div className="text-center text-sm text-slate-400">No destination data available</div>
            )}
          </div>
        </div>
      </div>

      {/* 3. DISTRIBUTION SECTION CONTAINER */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* Revenue Distribution Container */}
        <div className="bg-white border border-[#DCE3EC] rounded-[16px] p-5 shadow-[0_2px_8px_rgba(15,23,42,0.05)]">
          <h2 className="text-sm font-bold text-slate-900 tracking-tight mb-4">Customer Tier Distribution</h2>
          <div className="flex items-center min-h-[200px]">
            {donutOption ? (
              <>
                <div className="w-[40%] h-[190px] relative">
                  <ReactECharts 
                    option={donutOption} 
                    style={{ height: '100%', width: '100%' }} 
                    onEvents={{
                      click: (params: any) => {
                        setSelectedKpi({
                          title: params.name,
                          value: `${params.value} accounts`,
                          data: { 'Accounts in Tier': params.data.list || [] }
                        });
                      }
                    }}
                  />
                </div>
                <div className="w-[60%] flex flex-col justify-center space-y-2 pl-4 border-l border-slate-100 dark:border-slate-800">
                  {tiers.map((t: any, i: number) => {
                    const color = getTierColor(t.tier, i);
                    const rawName = t.tier || '';
                    const mainLabel = rawName.includes('(') ? rawName.split('(')[0].trim() : rawName;
                    const subtitle = rawName.includes('(') ? rawName.split('(')[1].replace(')', '').trim() : '';
                    const pct = totalTierAccounts > 0 ? Math.round((t.count / totalTierAccounts) * 100) : 0;
                    return (
                      <div 
                        key={i} 
                        className="flex items-center justify-between gap-2 p-1.5 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors cursor-pointer"
                        onClick={() => setSelectedKpi({
                          title: rawName,
                          value: `${t.count} accounts (${pct}%)`,
                          data: { 'Accounts in Tier': t.list || [] }
                        })}
                      >
                        <div className="flex items-start gap-2.5 min-w-0">
                          <div className="w-2.5 h-2.5 rounded-full shrink-0 mt-1 shadow-sm" style={{ backgroundColor: color }} />
                          <div className="min-w-0 flex flex-col">
                            <span className="text-xs font-bold text-slate-800 dark:text-slate-100 leading-tight">
                              {mainLabel}
                            </span>
                            {subtitle && (
                              <span className="text-[10px] text-slate-400 font-medium leading-tight mt-0.5">
                                ({subtitle})
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="text-right shrink-0 ml-2">
                          <span className="text-xs font-black text-slate-900 dark:text-slate-100 block leading-tight">
                            {t.count} accts
                          </span>
                          <span className="text-[10px] text-slate-400 font-semibold block leading-tight text-right">
                            {pct}%
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            ) : (
              <div className="w-full text-center text-sm text-slate-400">No tier data available</div>
            )}
          </div>
        </div>

        {/* Customer Distribution Container */}
        <div className="bg-white border border-[#DCE3EC] rounded-[16px] p-5 shadow-[0_2px_8px_rgba(15,23,42,0.05)]">
          <h2 className="text-sm font-bold text-slate-900 tracking-tight mb-4">Customer Distribution</h2>
          <div className="grid grid-cols-2 gap-3 h-[180px]">
            <div className="bg-slate-50/80 border border-slate-100 rounded-xl p-4 flex flex-col justify-center">
              <p className="text-[10px] uppercase font-bold tracking-wider text-slate-500 mb-1">Active Customers</p>
              <p className="text-2xl font-black text-slate-900">{cust.value}</p>
            </div>
            <div className="bg-slate-50/80 border border-slate-100 rounded-xl p-4 flex flex-col justify-center">
              <p className="text-[10px] uppercase font-bold tracking-wider text-slate-500 mb-1">Dormant</p>
              <p className="text-2xl font-black text-slate-900">{dormantCount}</p>
            </div>
            <div className="bg-slate-50/80 border border-slate-100 rounded-xl p-4 flex flex-col justify-center">
              <p className="text-[10px] uppercase font-bold tracking-wider text-slate-500 mb-1">New</p>
              <p className="text-2xl font-black text-slate-900">{newAcct.value}</p>
            </div>
            <div className="bg-slate-50/80 border border-slate-100 rounded-xl p-4 flex flex-col justify-center">
              <p className="text-[10px] uppercase font-bold tracking-wider text-slate-500 mb-1">VIP</p>
              <p className="text-2xl font-black text-slate-900">{strategicCount}</p>
            </div>
          </div>
        </div>
      </div>
      
      {/* All Destinations Slide-over */}
      {showAllDestinations && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-xs" onClick={() => setShowAllDestinations(false)} />
          <motion.div
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 25, stiffness: 200 }}
            className="w-[480px] max-w-full h-full bg-white dark:bg-zinc-900 border-l border-slate-200 dark:border-zinc-800 shadow-2xl relative z-10 flex flex-col"
          >
            <div className="flex items-center justify-between p-6 border-b border-slate-200 dark:border-zinc-800 bg-slate-50/80 dark:bg-zinc-900/90">
              <div>
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400">All Destinations</h3>
                <p className="text-lg font-black text-slate-900 dark:text-zinc-100 mt-1 tracking-tight">{countries.length} countries</p>
              </div>
              <button onClick={() => setShowAllDestinations(false)} className="p-2 hover:bg-slate-200/60 dark:hover:bg-zinc-800 rounded-full transition-colors text-slate-400 hover:text-slate-900">
                <X size={20} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50/80 border-b border-slate-100 sticky top-0">
                  <tr className="text-[10px] uppercase font-bold tracking-wider text-slate-500">
                    <th className="px-4 py-2.5 w-8">#</th>
                    <th className="px-4 py-2.5">Country</th>
                    <th className="px-4 py-2.5 text-right">Revenue</th>
                    <th className="px-4 py-2.5 text-right">Shipments</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {countries.map((c: any, i: number) => (
                    <tr key={i} className="hover:bg-slate-50 transition-colors">
                      <td className="px-4 py-2.5 text-slate-400 font-medium">{i + 1}</td>
                      <td className="px-4 py-2.5 font-semibold text-slate-800">{c.name || 'Unknown'}</td>
                      <td className="px-4 py-2.5 text-right font-bold text-slate-900">{formatMoney(c.revenue)}</td>
                      <td className="px-4 py-2.5 text-right text-slate-500 font-medium">{c.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </motion.div>
        </div>
      )}

      {/* All Customers Slide-over */}
      {showAllCustomers && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-xs" onClick={() => setShowAllCustomers(false)} />
          <motion.div
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 25, stiffness: 200 }}
            className="w-[560px] max-w-full h-full bg-white dark:bg-zinc-900 border-l border-slate-200 dark:border-zinc-800 shadow-2xl relative z-10 flex flex-col"
          >
            <div className="flex items-center justify-between p-6 border-b border-slate-200 dark:border-zinc-800 bg-slate-50/80 dark:bg-zinc-900/90">
              <div>
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400">All Customers</h3>
                <p className="text-lg font-black text-slate-900 dark:text-zinc-100 mt-1 tracking-tight">
                  {allCustomers ? `${allCustomers.items.length} customers` : 'Loading…'}
                </p>
              </div>
              <button onClick={() => setShowAllCustomers(false)} className="p-2 hover:bg-slate-200/60 dark:hover:bg-zinc-800 rounded-full transition-colors text-slate-400 hover:text-slate-900">
                <X size={20} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">
              {allCustomersFetching && !allCustomers ? (
                <div className="p-6 space-y-2">
                  {Array.from({ length: 8 }).map((_, i) => (
                    <div key={i} className="h-9 bg-slate-100 dark:bg-zinc-800 rounded-lg animate-pulse" />
                  ))}
                </div>
              ) : (
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50/80 border-b border-slate-100 sticky top-0">
                    <tr className="text-[10px] uppercase font-bold tracking-wider text-slate-500">
                      <th className="px-4 py-2.5 w-8">#</th>
                      <th className="px-4 py-2.5">Company</th>
                      <th className="px-4 py-2.5 text-right">Revenue</th>
                      <th className="px-4 py-2.5 text-right">AWBs</th>
                      <th className="px-4 py-2.5 text-right">Weight</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {(allCustomers?.items || []).map((c: any, i: number) => (
                      <tr key={i} className="hover:bg-slate-50 transition-colors cursor-pointer" onClick={() => { setShowAllCustomers(false); navigate(`/app/customers/${c.company_id}`); }}>
                        <td className="px-4 py-2.5 text-slate-400 font-medium">{c.rank ?? i + 1}</td>
                        <td className="px-4 py-2.5 font-semibold text-slate-800 max-w-[220px] truncate">{c.company_name}</td>
                        <td className="px-4 py-2.5 text-right font-bold text-slate-900">{formatMoney(c.revenue)}</td>
                        <td className="px-4 py-2.5 text-right text-slate-500 font-medium">{c.shipments}</td>
                        <td className="px-4 py-2.5 text-right text-slate-500 font-medium">{c.weight != null ? c.weight.toLocaleString(undefined, { maximumFractionDigits: 1 }) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </motion.div>
        </div>
      )}

      {/* KPI Details Panel Slide-over */}
      {selectedKpi && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-xs" onClick={() => setSelectedKpi(null)} />
          <motion.div 
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 25, stiffness: 200 }}
            className="w-[420px] max-w-full h-full bg-white dark:bg-zinc-900 border-l border-slate-200 dark:border-zinc-800 shadow-2xl relative z-10 flex flex-col"
          >
            <div className="flex items-center justify-between p-6 border-b border-slate-200 dark:border-zinc-800 bg-slate-50/80 dark:bg-zinc-900/90">
              <div>
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 dark:text-zinc-400">{selectedKpi.title}</h3>
                <p className="text-2xl sm:text-3xl font-black text-slate-900 dark:text-zinc-100 mt-1 tracking-tight">{selectedKpi.value}</p>
              </div>
              <button 
                onClick={() => setSelectedKpi(null)} 
                className="p-2 hover:bg-slate-200/60 dark:hover:bg-zinc-800 rounded-full transition-colors text-slate-400 hover:text-slate-900 dark:hover:text-zinc-100"
              >
                <X size={20} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-6 space-y-4">
              <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400 dark:text-zinc-400 mb-2">Detailed Metrics</h4>
              {(() => {
                const data = selectedKpi.data;
                if (!data) return <p className="text-xs text-slate-400 dark:text-zinc-500">No details available.</p>;

                // Helper for rendering array of items (like Countries or Companies)
                const renderArrayItems = (arr: any[]) => (
                  <div className="space-y-2.5">
                    {arr.map((item, idx) => {
                      if (typeof item === 'object' && item !== null) {
                        const title = item.name || item.company_name || item.title || item.country || `Item #${idx + 1}`;
                        const countVal = item.value ?? item.shipments ?? item.count ?? item.customer_count;
                        const revVal = item.revenue ?? item.total_revenue;
                        const companyId = item.company_id;

                        return (
                          <div
                            key={idx}
                            onClick={companyId ? () => { setSelectedKpi(null); navigate(`/app/customers/${companyId}`); } : undefined}
                            className={`bg-slate-50 dark:bg-zinc-800/80 border border-slate-200/80 dark:border-zinc-700/60 p-3.5 rounded-xl flex items-center justify-between gap-3 shadow-2xs hover:border-slate-300 dark:hover:border-zinc-600 transition-colors ${companyId ? 'cursor-pointer hover:bg-slate-100 dark:hover:bg-zinc-800' : ''}`}
                          >
                            <div className="min-w-0 flex-1">
                              <span className="text-xs font-bold text-slate-800 dark:text-zinc-100 truncate block">
                                {title}
                              </span>
                              <div className="flex items-center gap-3 mt-1.5">
                                {countVal !== undefined && (
                                  <span className="text-[11px] font-semibold text-slate-500 dark:text-zinc-400">
                                    {Number(countVal).toLocaleString()} shipments
                                  </span>
                                )}
                                {revVal !== undefined && (
                                  <span className="text-[11px] font-bold text-emerald-600 dark:text-emerald-400">
                                    {formatMoney(Number(revVal))}
                                  </span>
                                )}
                              </div>
                            </div>
                            {companyId && <ArrowRight size={14} className="text-slate-400 dark:text-zinc-500 shrink-0" />}
                          </div>
                        );
                      }
                      return (
                        <div key={idx} className="bg-slate-50 dark:bg-zinc-800/80 border border-slate-200/80 dark:border-zinc-700/60 p-3 rounded-lg text-xs font-semibold text-slate-800 dark:text-zinc-200">
                          {String(item)}
                        </div>
                      );
                    })}
                  </div>
                );

                if (Array.isArray(data)) {
                  return renderArrayItems(data);
                }

                if (typeof data === 'object') {
                  return (
                    <div className="space-y-3">
                      {Object.entries(data).map(([key, val], idx) => {
                        const formattedKey = key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

                        if (Array.isArray(val)) {
                          return (
                            <div key={idx} className="bg-slate-50 dark:bg-zinc-800/50 border border-slate-200/80 dark:border-zinc-700/60 p-3.5 rounded-xl space-y-2.5">
                              <div className="flex items-center justify-between">
                                <span className="text-xs font-bold text-slate-700 dark:text-zinc-300">{formattedKey}</span>
                                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-slate-200/70 dark:bg-zinc-700 text-slate-600 dark:text-zinc-300">
                                  {val.length} items
                                </span>
                              </div>
                              {renderArrayItems(val)}
                            </div>
                          );
                        }

                        if (typeof val === 'object' && val !== null) {
                          return (
                            <div key={idx} className="bg-slate-50 dark:bg-zinc-800/50 border border-slate-200/80 dark:border-zinc-700/60 p-3.5 rounded-xl space-y-2">
                              <span className="text-xs font-bold text-slate-700 dark:text-zinc-300 block mb-1">{formattedKey}</span>
                              <pre className="text-xs font-mono text-slate-700 dark:text-zinc-300 whitespace-pre-wrap bg-white dark:bg-zinc-900 p-2.5 rounded-lg border border-slate-200/50 dark:border-zinc-800">
                                {JSON.stringify(val, null, 2)}
                              </pre>
                            </div>
                          );
                        }

                        return (
                          <div key={idx} className="flex justify-between items-center py-2.5 px-3.5 bg-slate-50 dark:bg-zinc-800/50 border border-slate-200/60 dark:border-zinc-700/50 rounded-xl">
                            <span className="text-xs font-medium text-slate-500 dark:text-zinc-400">{formattedKey}</span>
                            <span className="text-xs font-bold text-slate-900 dark:text-zinc-100">
                              {typeof val === 'number' && formattedKey.toLowerCase().includes('revenue') ? formatMoney(val) : String(val)}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  );
                }

                return <p className="text-xs font-semibold text-slate-800 dark:text-zinc-200">{String(data)}</p>;
              })()}
            </div>
          </motion.div>
        </div>
      )}
    </motion.div>
  );
}
