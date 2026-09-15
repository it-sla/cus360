import React, { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import ReactECharts from 'echarts-for-react';
import { useNavigate } from 'react-router-dom';
import * as XLSX from 'xlsx';
import {
  Download, ArrowUpRight, Users, RefreshCw, AlertTriangle, Activity
} from 'lucide-react';
import { KpiCard } from '@/components/KpiCard';
import { FilterSelect, DateRangeControl, CompareModeSelect, fmtShortDate } from '@/components/AnalyticsFilterBar';

function ChartWrapper({ title, children }: { title: string, children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-[16px] border border-[#E2E8F0] p-5 sm:p-6 shadow-[0_2px_4px_rgba(15,23,42,0.04)] flex flex-col">
      <h3 className="text-sm font-bold text-slate-900 tracking-tight mb-4">{title}</h3>
      <div className="flex-1 relative">
        {children}
      </div>
    </div>
  );
}

function fmt$(v: number) { return `$${v >= 1000 ? (v/1000).toFixed(1) + 'k' : v.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`; }
function fmtNum(v: number) { return v.toLocaleString(); }
function fmtAxisDate(iso: string | null) {
  if (!iso) return '';
  const dt = new Date(`${iso}T00:00:00`);
  return isNaN(dt.getTime()) ? '' : dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export default function CustomerAnalytics() {
  const navigate = useNavigate();

  const [filters, setFilters] = useState({
    timeframe: 'this_month',
    compareMode: 'pop',
    ae: '',
    segment: '',
    country: '',
    dateFrom: '',
    dateTo: '',
  });

  const updateFilter = (key: string, value: any) => setFilters(f => ({ ...f, [key]: value }));

  const [showAllGainers, setShowAllGainers] = useState(false);
  const [showAllDecliners, setShowAllDecliners] = useState(false);
  const [showAllCustomers, setShowAllCustomers] = useState(false);
  const [allCustomersSort, setAllCustomersSort] = useState<{ key: string; dir: 'asc' | 'desc' }>({ key: 'revenue', dir: 'desc' });

  const { data: d, isLoading } = useQuery({
    queryKey: ['executive-dashboard', filters.timeframe, filters.dateFrom, filters.dateTo, filters.compareMode, filters.segment],
    queryFn: () => api.getExecutiveDashboard({
      timeframe: filters.timeframe,
      date_from: filters.timeframe === 'custom' ? filters.dateFrom : undefined,
      date_to: filters.timeframe === 'custom' ? filters.dateTo : undefined,
      compare_mode: filters.compareMode,
      segment: filters.segment || undefined,
    }),
  });

  const {
    base, segmentsData, activeCount, dormantCount, reactivatedCount, newCount,
    everShippedCount, gainers, decliners,
    trendChartData
  } = useMemo(() => {
    if (!d || !d.revenue_analytics?.all_customers) {
      return {
        base: [], segmentsData: [], activeCount:0, dormantCount:0, reactivatedCount:0,
        newCount:0, everShippedCount:0, avgRevPerCust:0, avgShipPerCust:0, healthData: { Healthy: 0, Warning: 0, Dormant: 0 },
        concentrationData: { top10Pct: 0, strategicPct: 0, largestCustomer: null },
        reactivatedList: [], lapsedList: [], gainers: [], decliners: [],
        trendChartData: []
      };
    }

    let all = d.revenue_analytics.all_customers.map((c: any) => {
      const g = d.revenue_analytics.growth_matrix?.find((gm: any) => gm.company_id === c.company_id) || {};
      
      const prevRev = g.prev_revenue || 0;
      const prevShip = g.prev_shipments || 0;
      const prevWeight = g.prev_weight || 0;
      
      // The API never sends a null last_shipment_date — companies with zero shipments ever
      // get an epoch sentinel ('1970-01-01') instead, so truthiness alone can't tell "never
      // shipped" from "shipped a long time ago". everShipped is the real signal for that.
      const everShipped = !!c.last_shipment_date && c.last_shipment_date !== '1970-01-01';
      const daysSince = everShipped ? Math.floor((Date.now() - new Date(c.last_shipment_date).getTime()) / (1000 * 60 * 60 * 24)) : 999;
      let health = 'Healthy';
      if (daysSince > 180) health = 'Dormant';
      else if (daysSince > 30) health = 'Warning';

      return {
        ...c,
        growth: g.pct_growth || 0,
        prevRevenue: prevRev,
        prevShipments: prevShip,
        prevWeight: prevWeight,
        revChange: c.revenue - prevRev,
        isNew: !!g.is_new,
        segment: c.segment || 'Small Customer',
        health,
        daysSince,
        everShipped
      };
    });

    if (filters.ae) all = all.filter((c:any) => c.ae_code === filters.ae);
    if (filters.country) all = all.filter((c:any) => c.country === filters.country);

    // "Ever shipped" is the shared basis for Total/Active/Dormant below — a company with no
    // last_shipment_date defaults to health:'Dormant' (see daysSince above) but was never a
    // real customer in the first place, so it's excluded from all three rather than counted
    // as Dormant (which previously made Dormant exceed Total, two different queries never
    // agreeing) or omitted from Total (undercounting who's actually being tracked here).
    const everShippedCount = all.filter((c:any) => c.everShipped).length;
    const activeCount = all.filter((c:any) => c.revenue > 0).length;
    const dormantCount = all.filter((c:any) => c.everShipped && c.health === 'Dormant').length;
    
    const newCount = all.filter((c:any) => c.isNew).length;
    const reactivatedCount = all.filter((c:any) => c.revenue > 0 && c.prevRevenue === 0 && !c.isNew).length;

    const revTotal = all.reduce((sum: number, c: any) => sum + c.revenue, 0);
    const shipTotal = all.reduce((sum: number, c: any) => sum + c.shipments, 0);
    const avgRevPerCust = activeCount > 0 ? revTotal / activeCount : 0;
    const avgShipPerCust = activeCount > 0 ? shipTotal / activeCount : 0;

    const segMap = all.reduce((acc:any, c:any) => {
      const seg = c.segment;
      if (!acc[seg]) acc[seg] = { count: 0, revenue: 0, prevRevenue: 0, shipments: 0, prevShipments: 0, weight: 0, prevWeight: 0 };
      acc[seg].count += 1;
      acc[seg].revenue += c.revenue;
      acc[seg].prevRevenue += c.prevRevenue;
      acc[seg].shipments += c.shipments;
      acc[seg].prevShipments += c.prevShipments;
      acc[seg].weight += (c.weight || 0);
      acc[seg].prevWeight += (c.prevWeight || 0);
      return acc;
    }, {});

    const segmentsData = Object.keys(segMap).map(name => {
      const s = segMap[name];
      const revGrowth = s.prevRevenue ? ((s.revenue - s.prevRevenue) / s.prevRevenue) * 100 : (s.revenue > 0 ? 100 : 0);
      const shipGrowth = s.prevShipments ? ((s.shipments - s.prevShipments) / s.prevShipments) * 100 : (s.shipments > 0 ? 100 : 0);
      const weightGrowth = s.prevWeight ? ((s.weight - s.prevWeight) / s.prevWeight) * 100 : (s.weight > 0 ? 100 : 0);

      return {
        name,
        count: s.count,
        revenue: s.revenue,
        prevRevenue: s.prevRevenue,
        revGrowth,
        shipments: s.shipments,
        shipGrowth,
        weight: s.weight,
        weightGrowth,
        avgRevenue: s.count ? s.revenue / s.count : 0
      };
    }).sort((a, b) => b.revenue - a.revenue);

    const sortedByRev = [...all].sort((a:any, b:any) => b.revenue - a.revenue);
    
    const concentrationData = {
      top10Pct: revTotal > 0 ? (sortedByRev.slice(0, 10).reduce((sum, c) => sum + c.revenue, 0) / revTotal) * 100 : 0,
      strategicPct: revTotal > 0 ? ((segMap['Key Account']?.revenue || 0) + (segMap['Large Account']?.revenue || 0)) / revTotal * 100 : 0,
      largestCustomer: sortedByRev[0] || null,
    };

    const reactivatedList = all.filter((c:any) => !c.isNew && c.prevRevenue === 0 && c.revenue > 0).sort((a:any, b:any) => b.revenue - a.revenue).slice(0, 20);
    const lapsedList = all.filter((c:any) => c.prevRevenue > 0 && c.revenue === 0).sort((a:any, b:any) => b.prevRevenue - a.prevRevenue).slice(0, 20);

    const gainers = all.filter((c:any) => c.revChange > 0 && c.prevRevenue > 0).sort((a:any, b:any) => b.revChange - a.revChange);
    const decliners = all.filter((c:any) => c.revChange < 0).sort((a:any, b:any) => a.revChange - b.revChange);

    const healthData = {
      Healthy: all.filter((c:any) => c.health === 'Healthy').length,
      Warning: all.filter((c:any) => c.health === 'Warning').length,
      Dormant: all.filter((c:any) => c.health === 'Dormant').length,
    };

    const trendChartData = [];
    if (d.billing_analytics?.trend && d.billing_analytics?.prev_trend) {
       const maxLen = Math.max(d.billing_analytics.trend.length, d.billing_analytics.prev_trend.length);
       for (let i = 0; i < maxLen; i++) {
         const cur = d.billing_analytics.trend[i] || { total_amount: 0, invoice_count: 0, pieces: 0, weight: 0 };
         const prv = d.billing_analytics.prev_trend[i] || { total_amount: 0, invoice_count: 0, pieces: 0, weight: 0 };
         trendChartData.push({
           index: `Day ${i+1}`,
           cur_date: cur.period || null,
           prev_date: prv.period || null,
           cur_revenue: cur.total_amount,
           prev_revenue: prv.total_amount,
           cur_shipments: cur.invoice_count,
           prev_shipments: prv.invoice_count
         });
       }
    }

    return { base: all, segmentsData, activeCount, dormantCount, reactivatedCount, newCount, everShippedCount, avgRevPerCust, avgShipPerCust, healthData, concentrationData, reactivatedList, lapsedList, gainers, decliners, trendChartData };
  }, [d, filters]);

  const uniqueAEs = useMemo(() => Array.from(new Set(d?.revenue_analytics?.all_customers?.map((c:any) => c.ae_code).filter(Boolean) || [])).sort(), [d]);

  const sortedAllCustomers = useMemo(() => {
    const { key, dir } = allCustomersSort;
    const mult = dir === 'asc' ? 1 : -1;
    return [...base].sort((a: any, b: any) => {
      const av = a[key], bv = b[key];
      if (typeof av === 'string' || typeof bv === 'string') {
        return String(av ?? '').localeCompare(String(bv ?? '')) * mult;
      }
      return ((av ?? 0) - (bv ?? 0)) * mult;
    });
  }, [base, allCustomersSort]);

  const toggleAllCustomersSort = (key: string) => {
    setAllCustomersSort(s => s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' });
  };

  const exportExcel = () => {
    const workbook = XLSX.utils.book_new();

    // Sheet columns are sized to their own content (not a fixed guess), and currency/
    // percent columns get a real Excel number format instead of a pre-baked string —
    // so the file opens sortable/filterable with native number semantics, not text.
    const addSheet = (rows: Record<string, any>[], sheetName: string, currencyCols: string[] = [], percentCols: string[] = []) => {
      if (rows.length === 0) return;
      const sheet = XLSX.utils.json_to_sheet(rows);
      const headers = Object.keys(rows[0]);
      sheet['!cols'] = headers.map(h => ({
        wch: Math.min(Math.max(h.length, ...rows.map(r => String(r[h] ?? '').length)) + 2, 42),
      }));
      rows.forEach((_row, rIdx) => {
        headers.forEach((h, cIdx) => {
          const cell = sheet[XLSX.utils.encode_cell({ r: rIdx + 1, c: cIdx })];
          if (!cell || typeof cell.v !== 'number') return;
          if (currencyCols.includes(h)) cell.z = '$#,##0.00';
          else if (percentCols.includes(h)) cell.z = '+0.0%;-0.0%;0.0%';
        });
      });
      sheet['!autofilter'] = { ref: sheet['!ref']! };
      XLSX.utils.book_append_sheet(workbook, sheet, sheetName);
    };

    addSheet(base.map((c: any) => ({
      Customer: c.company_name, ICRIS: c.icris_number ?? '', Segment: c.segment, AE: c.ae_code ?? '',
      'Prev Revenue': c.prevRevenue, 'Current Revenue': c.revenue, Change: c.revChange, 'Growth %': c.growth / 100,
      'Prev Shipments': c.prevShipments, Shipments: c.shipments, Pieces: c.pieces, Health: c.health,
      New: c.isNew ? 'Yes' : 'No', Reactivated: (!c.isNew && c.prevRevenue === 0 && c.revenue > 0) ? 'Yes' : 'No',
    })), 'All Customers', ['Prev Revenue', 'Current Revenue', 'Change'], ['Growth %']);

    addSheet(gainers.map((c: any, i: number) => ({
      Rank: i + 1, Customer: c.company_name, Segment: c.segment,
      'Prev Revenue': c.prevRevenue, 'Current Revenue': c.revenue, Change: c.revChange, 'Growth %': c.growth / 100, Pieces: c.pieces,
    })), 'Biggest Gainers', ['Prev Revenue', 'Current Revenue', 'Change'], ['Growth %']);

    addSheet(decliners.map((c: any, i: number) => ({
      Rank: i + 1, Customer: c.company_name, Segment: c.segment,
      'Prev Revenue': c.prevRevenue, 'Current Revenue': c.revenue, Change: c.revChange, 'Growth %': c.growth / 100, Pieces: c.pieces,
    })), 'Biggest Decliners', ['Prev Revenue', 'Current Revenue', 'Change'], ['Growth %']);

    addSheet(segmentsData.map((s: any) => ({
      Segment: s.name, Customers: s.count, 'Prev Revenue': s.prevRevenue, 'Current Revenue': s.revenue,
      'Revenue Growth %': s.revGrowth / 100, 'Shipment Growth %': s.shipGrowth / 100, 'Weight Growth %': s.weightGrowth / 100,
    })), 'By Segment', ['Prev Revenue', 'Current Revenue'], ['Revenue Growth %', 'Shipment Growth %', 'Weight Growth %']);

    const periodTag = d?.bounds?.c_start && d?.bounds?.c_end ? `${d.bounds.c_start}_${d.bounds.c_end}` : filters.timeframe;
    XLSX.writeFile(workbook, `customer-analytics-${periodTag}.xlsx`);
  };

  if (isLoading || !d) {
    return (
      <div className="flex-1 bg-background flex items-center justify-center min-h-[600px]">
        <div className="flex flex-col items-center gap-3 bg-white p-10 rounded-2xl shadow-sm border border-[#E2E8F0]">
          <RefreshCw className="animate-spin text-primary" size={32} />
          <span className="font-semibold text-slate-700 text-sm">Loading Customer Analytics...</span>
        </div>
      </div>
    );
  }

  const echartTooltip = { backgroundColor: '#fff', borderColor: '#e2e8f0', textStyle: { color: '#0f172a', fontSize: 12 } };

  return (
    <div className="flex-1 overflow-y-auto bg-background relative p-4 sm:p-6 lg:p-8 max-w-[1600px] mx-auto w-full space-y-6">
      
      {/* HEADER */}
      <div className="flex flex-col 2xl:flex-row 2xl:items-center justify-between gap-6 mb-2">
        <div className="shrink-0">
          <h1 className="text-xl sm:text-2xl font-black text-slate-900 tracking-tight">Customer Performance</h1>
          <p className="mt-1 text-xs sm:text-sm text-slate-500 font-medium">Customer health, segmentation and growth insights.</p>
        </div>
        
        <div className="flex flex-wrap items-center gap-2.5 2xl:justify-end flex-1">
          <DateRangeControl
            timeframe={filters.timeframe} dateFrom={filters.dateFrom} dateTo={filters.dateTo} bounds={d?.bounds}
            onPreset={(v) => { updateFilter('timeframe', v); updateFilter('dateFrom', ''); updateFilter('dateTo', ''); }}
            onCustom={(f, t) => { updateFilter('timeframe', 'custom'); updateFilter('dateFrom', f); updateFilter('dateTo', t); }}
          />
          <CompareModeSelect icon={Activity} value={filters.compareMode} onChange={(e) => updateFilter('compareMode', e.target.value)} />
          <FilterSelect
            icon={Users}
            value={filters.ae}
            onChange={(e:any) => updateFilter('ae', e.target.value)}
            options={uniqueAEs}
            placeholder="All AEs"
          />
          <button onClick={exportExcel} disabled={base.length === 0} className="h-9 px-3 bg-white border border-[#DCE3EC] text-slate-700 rounded-lg text-xs font-bold flex items-center gap-1.5 hover:bg-slate-50 dark:bg-zinc-800 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-700 shadow-sm disabled:opacity-50 disabled:cursor-not-allowed">
            <Download size={14} /> Export
          </button>
        </div>
      </div>

      {/* KPI CARDS */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <KpiCard title="Total Customers" value={everShippedCount} icon={Users} className="p-3 border-t-2 border-t-zinc-50" />
        <KpiCard title="Active Customers" value={activeCount} icon={Users} className="p-3 border-t-2 border-t-blue-500" />
        <KpiCard title="Dormant Customers" value={dormantCount} icon={AlertTriangle} className="p-3 border-t-2 border-t-amber-500" />
        <KpiCard title="New Customers" value={newCount} icon={ArrowUpRight} className="p-3 border-t-2 border-t-sky-500" />
        <KpiCard title="Reactivated" value={reactivatedCount} icon={ArrowUpRight} className="p-3 border-t-2 border-t-indigo-500" />
      </div>

      {/* ALL CUSTOMERS TABLE */}
      <div className="bg-white rounded-[16px] border border-[#E2E8F0] shadow-[0_2px_4px_rgba(15,23,42,0.04)] overflow-hidden flex flex-col">
        <div className="p-5 border-b border-[#E2E8F0] flex items-center justify-between">
          <h3 className="text-sm font-bold text-slate-900 tracking-tight">All Customers</h3>
        </div>
        <div className={`overflow-x-auto flex-1 ${showAllCustomers ? 'max-h-[600px] overflow-y-auto' : ''}`}>
          <table className="w-full text-left text-xs whitespace-nowrap">
            <thead className="bg-slate-50 text-slate-500 border-b border-[#E2E8F0] sticky top-0">
              <tr>
                {[
                  { key: 'company_name', label: 'Customer' },
                  { key: 'segment', label: 'Segment' },
                  { key: 'ae_code', label: 'AE' },
                  { key: 'prevRevenue', label: 'Prev Revenue', right: true },
                  { key: 'revenue', label: 'Current Revenue', right: true },
                  { key: 'growth', label: 'Growth %', right: true },
                  { key: 'shipments', label: 'Shipments', right: true },
                  { key: 'pieces', label: 'Pieces', right: true },
                ].map(col => (
                  <th
                    key={col.key}
                    onClick={() => toggleAllCustomersSort(col.key)}
                    className={`px-4 py-3 font-semibold cursor-pointer select-none hover:text-slate-700 ${col.right ? 'text-right' : ''}`}
                  >
                    {col.label}{allCustomersSort.key === col.key ? (allCustomersSort.dir === 'asc' ? ' ↑' : ' ↓') : ''}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E2E8F0]">
              {(showAllCustomers ? sortedAllCustomers : sortedAllCustomers.slice(0, 10)).map((c: any, i: number) => (
                <tr key={i} className="cursor-pointer" onClick={() => navigate(`/app/customers/${c.company_id}`)}>
                  <td className="px-4 py-3 font-medium text-slate-800 max-w-[200px] truncate" title={c.company_name}>
                    {c.company_name}
                  </td>
                  <td className="px-4 py-3">
                    <span className="bg-slate-100 px-2 py-0.5 rounded text-[10px] text-slate-600 font-medium truncate max-w-[120px] inline-block" title={c.segment}>{c.segment}</span>
                  </td>
                  <td className="px-4 py-3 text-slate-500">{c.ae_code || '—'}</td>
                  <td className="px-4 py-3 text-right text-slate-500">{fmt$(c.prevRevenue)}</td>
                  <td className="px-4 py-3 text-right text-slate-800 font-bold">{fmt$(c.revenue)}</td>
                  <td className="px-4 py-3 text-right font-bold">
                    <span className={c.growth > 0 ? 'text-emerald-600' : c.growth < 0 ? 'text-rose-600' : 'text-slate-400'}>
                      {c.growth > 0 ? '+' : ''}{c.growth.toFixed(1)}%
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right text-slate-600">{fmtNum(c.shipments)}</td>
                  <td className="px-4 py-3 text-right text-slate-600 font-bold">{fmtNum(c.pieces)}</td>
                </tr>
              ))}
              {sortedAllCustomers.length === 0 && (
                <tr><td colSpan={8} className="px-4 py-8 text-center text-slate-400">No customer data available.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        {sortedAllCustomers.length > 10 && (
          <button
            onClick={() => setShowAllCustomers(v => !v)}
            className="px-5 py-2.5 text-xs font-bold text-primary hover:bg-slate-50 border-t border-[#E2E8F0] transition-colors text-center"
          >
            {showAllCustomers ? 'View Less' : `View More (${sortedAllCustomers.length - 10} more)`}
          </button>
        )}
      </div>

      {/* TABLES ROW 1 */}
      <div className="grid grid-cols-1 2xl:grid-cols-2 gap-6">

        {/* BIGGEST GAINERS TABLE */}
        <div className="bg-white rounded-[16px] border border-[#E2E8F0] shadow-[0_2px_4px_rgba(15,23,42,0.04)] overflow-hidden flex flex-col">
          <div className="p-5 border-b border-[#E2E8F0] flex items-center justify-between">
            <h3 className="text-sm font-bold text-slate-900 tracking-tight">Biggest Gainers</h3>
            <span className="text-[10px] text-slate-500 font-bold bg-slate-100 px-2 py-0.5 rounded uppercase tracking-wider">{filters.compareMode === 'yoy' ? 'YoY' : 'PoP'}</span>
          </div>
          <div className={`overflow-x-auto flex-1 ${showAllGainers ? 'max-h-[600px] overflow-y-auto' : ''}`}>
            <table className="w-full text-left text-xs whitespace-nowrap">
              <thead className="bg-slate-50 text-slate-500 border-b border-[#E2E8F0] sticky top-0">
                <tr>
                  <th className="px-4 py-3 font-semibold text-center w-8">#</th>
                  <th className="px-4 py-3 font-semibold">Customer</th>
                  <th className="px-4 py-3 font-semibold">Segment</th>
                  <th className="px-4 py-3 font-semibold text-right">Prev Rev</th>
                  <th className="px-4 py-3 font-semibold text-right">Cur Rev</th>
                  <th className="px-4 py-3 font-semibold text-right">Change</th>
                  <th className="px-4 py-3 font-semibold text-right">Growth</th>
                  <th className="px-4 py-3 font-semibold text-right">Pieces</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E2E8F0]">
                {(showAllGainers ? gainers : gainers.slice(0, 10)).map((c, i) => (
                  <tr key={i} className="cursor-pointer" onClick={() => navigate(`/app/customers/${c.company_id}`)}>
                    <td className="px-4 py-3 text-center text-slate-400 font-medium">{i + 1}</td>
                    <td className="px-4 py-3 font-medium text-slate-800 max-w-[200px] truncate" title={c.company_name}>
                      {c.company_name}
                    </td>
                    <td className="px-4 py-3">
                      <span className="bg-slate-100 px-2 py-0.5 rounded text-[10px] text-slate-600 font-medium truncate max-w-[120px] inline-block" title={c.segment}>{c.segment}</span>
                    </td>
                    <td className="px-4 py-3 text-right text-slate-500">{fmt$(c.prevRevenue)}</td>
                    <td className="px-4 py-3 text-right text-slate-800 font-bold">{fmt$(c.revenue)}</td>
                    <td className="px-4 py-3 text-right text-emerald-600 font-bold">+{fmt$(c.revChange)}</td>
                    <td className="px-4 py-3 text-right text-emerald-600 font-bold">+{c.growth.toFixed(1)}%</td>
                    <td className="px-4 py-3 text-right text-slate-600">{fmtNum(c.pieces)}</td>
                  </tr>
                ))}
                {gainers.length === 0 && (
                  <tr><td colSpan={8} className="px-4 py-8 text-center text-slate-400">No gainers detected.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          {gainers.length > 10 && (
            <button
              onClick={() => setShowAllGainers(v => !v)}
              className="px-5 py-2.5 text-xs font-bold text-primary hover:bg-slate-50 border-t border-[#E2E8F0] transition-colors text-center"
            >
              {showAllGainers ? 'View Less' : `View More (${gainers.length - 10} more)`}
            </button>
          )}
        </div>

        {/* BIGGEST DECLINERS TABLE */}
        <div className="bg-white rounded-[16px] border border-[#E2E8F0] shadow-[0_2px_4px_rgba(15,23,42,0.04)] overflow-hidden flex flex-col">
          <div className="p-5 border-b border-[#E2E8F0] flex items-center justify-between">
            <h3 className="text-sm font-bold text-slate-900 tracking-tight">Biggest Decliners</h3>
            <span className="text-[10px] text-slate-500 font-bold bg-slate-100 px-2 py-0.5 rounded uppercase tracking-wider">{filters.compareMode === 'yoy' ? 'YoY' : 'PoP'}</span>
          </div>
          <div className={`overflow-x-auto flex-1 ${showAllDecliners ? 'max-h-[600px] overflow-y-auto' : ''}`}>
            <table className="w-full text-left text-xs whitespace-nowrap">
              <thead className="bg-slate-50 text-slate-500 border-b border-[#E2E8F0] sticky top-0">
                <tr>
                  <th className="px-4 py-3 font-semibold text-center w-8">#</th>
                  <th className="px-4 py-3 font-semibold">Customer</th>
                  <th className="px-4 py-3 font-semibold">Segment</th>
                  <th className="px-4 py-3 font-semibold text-right">Prev Rev</th>
                  <th className="px-4 py-3 font-semibold text-right">Cur Rev</th>
                  <th className="px-4 py-3 font-semibold text-right">Change</th>
                  <th className="px-4 py-3 font-semibold text-right">Growth</th>
                  <th className="px-4 py-3 font-semibold text-right">Pieces</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E2E8F0]">
                {(showAllDecliners ? decliners : decliners.slice(0, 10)).map((c, i) => (
                  <tr key={i} className="cursor-pointer" onClick={() => navigate(`/app/customers/${c.company_id}`)}>
                    <td className="px-4 py-3 text-center text-slate-400 font-medium">{i + 1}</td>
                    <td className="px-4 py-3 font-medium text-slate-800 max-w-[200px] truncate" title={c.company_name}>
                      {c.company_name}
                    </td>
                    <td className="px-4 py-3">
                      <span className="bg-slate-100 px-2 py-0.5 rounded text-[10px] text-slate-600 font-medium truncate max-w-[120px] inline-block" title={c.segment}>{c.segment}</span>
                    </td>
                    <td className="px-4 py-3 text-right text-slate-500">{fmt$(c.prevRevenue)}</td>
                    <td className="px-4 py-3 text-right text-slate-800 font-bold">{fmt$(c.revenue)}</td>
                    <td className="px-4 py-3 text-right text-rose-600 font-bold">{fmt$(c.revChange)}</td>
                    <td className="px-4 py-3 text-right text-rose-600 font-bold">{c.growth.toFixed(1)}%</td>
                    <td className="px-4 py-3 text-right text-slate-600">{fmtNum(c.pieces)}</td>
                  </tr>
                ))}
                {decliners.length === 0 && (
                  <tr><td colSpan={8} className="px-4 py-8 text-center text-slate-400">No decliners detected.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          {decliners.length > 10 && (
            <button
              onClick={() => setShowAllDecliners(v => !v)}
              className="px-5 py-2.5 text-xs font-bold text-primary hover:bg-slate-50 border-t border-[#E2E8F0] transition-colors text-center"
            >
              {showAllDecliners ? 'View Less' : `View More (${decliners.length - 10} more)`}
            </button>
          )}
        </div>

      </div>

      {/* PERFORMANCE BY SEGMENT */}
      <div className="bg-white rounded-[16px] border border-[#E2E8F0] shadow-[0_2px_4px_rgba(15,23,42,0.04)] overflow-hidden flex flex-col">
        <div className="p-5 border-b border-[#E2E8F0] flex items-center justify-between">
          <h3 className="text-sm font-bold text-slate-900 tracking-tight">Performance By Segment</h3>
          <span className="text-[10px] text-slate-500 font-bold bg-slate-100 px-2 py-0.5 rounded uppercase tracking-wider">{filters.compareMode === 'yoy' ? 'YoY' : 'PoP'}</span>
        </div>
        <div className="overflow-x-auto flex-1">
          <table className="w-full text-left text-xs whitespace-nowrap">
            <thead className="bg-slate-50 text-slate-500 border-b border-[#E2E8F0]">
              <tr>
                <th className="px-5 py-3 font-semibold">Segment</th>
                <th className="px-5 py-3 font-semibold text-right">Cust Count</th>
                <th className="px-5 py-3 font-semibold text-right">Prev Revenue</th>
                <th className="px-5 py-3 font-semibold text-right">Cur Revenue</th>
                <th className="px-5 py-3 font-semibold text-right">Rev Growth</th>
                <th className="px-5 py-3 font-semibold text-right">Ship Growth</th>
                <th className="px-5 py-3 font-semibold text-right">Weight Growth</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E2E8F0]">
              {segmentsData.map(s => (
                <tr key={s.name}>
                  <td className="px-5 py-3 font-bold text-slate-800">{s.name}</td>
                  <td className="px-5 py-3 text-right text-slate-600">{fmtNum(s.count)}</td>
                  <td className="px-5 py-3 text-right text-slate-500">{fmt$(s.prevRevenue)}</td>
                  <td className="px-5 py-3 text-right text-slate-800 font-bold">{fmt$(s.revenue)}</td>
                  <td className="px-5 py-3 text-right font-bold">
                    <span className={s.revGrowth > 0 ? 'text-emerald-600' : s.revGrowth < 0 ? 'text-rose-600' : 'text-slate-400'}>
                      {s.revGrowth > 0 ? '+' : ''}{s.revGrowth.toFixed(1)}%
                    </span>
                  </td>
                  <td className="px-5 py-3 text-right font-bold">
                    <span className={s.shipGrowth > 0 ? 'text-emerald-600' : s.shipGrowth < 0 ? 'text-rose-600' : 'text-slate-400'}>
                      {s.shipGrowth > 0 ? '+' : ''}{s.shipGrowth.toFixed(1)}%
                    </span>
                  </td>
                  <td className="px-5 py-3 text-right font-bold">
                    <span className={s.weightGrowth > 0 ? 'text-emerald-600' : s.weightGrowth < 0 ? 'text-rose-600' : 'text-slate-400'}>
                      {s.weightGrowth > 0 ? '+' : ''}{s.weightGrowth.toFixed(1)}%
                    </span>
                  </td>
                </tr>
              ))}
              {segmentsData.length === 0 && (
                <tr><td colSpan={7} className="px-5 py-8 text-center text-slate-400">No segment data available.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* CHARTS ROW */}
      <div className="grid grid-cols-1 2xl:grid-cols-2 gap-6 mt-6">
        <ChartWrapper title="Revenue Comparison Trend">
          <p className="text-[10px] text-slate-400 font-medium -mt-3 mb-2">
            {trendChartData.length > 0 && trendChartData[0].cur_date && trendChartData[trendChartData.length - 1].cur_date
              ? `This period (${fmtShortDate(trendChartData[0].cur_date)} – ${fmtShortDate(trendChartData[trendChartData.length - 1].cur_date)}) vs prior period, day by day, matched by position in the range.`
              : 'Day-by-day revenue, this period vs the prior comparable period.'}
          </p>
          <ReactECharts
            option={{
              tooltip: {
                ...echartTooltip, trigger: 'axis',
                formatter: (params: any) => {
                  const idx = params[0]?.dataIndex ?? 0;
                  const row = trendChartData[idx];
                  if (!row) return '';
                  return `<div style="font-weight:600;margin-bottom:4px;">${fmtAxisDate(row.cur_date)} vs ${fmtAxisDate(row.prev_date)}</div>`
                    + `<div>This period: <b>${fmt$(row.cur_revenue)}</b></div>`
                    + `<div>Prior period: <b>${fmt$(row.prev_revenue)}</b></div>`;
                }
              },
              legend: { bottom: 0, icon: 'circle', textStyle: { fontSize: 11 } },
              grid: { left: '3%', right: '4%', bottom: '15%', containLabel: true },
              xAxis: { type: 'category', data: trendChartData.map(g => fmtAxisDate(g.cur_date) || g.index), axisLine: { lineStyle: { color: '#e2e8f0' } }, axisLabel: { fontSize: 10, color: '#94a3b8' } },
              yAxis: { type: 'value', splitLine: { lineStyle: { type: 'dashed', color: '#f1f5f9' } }, axisLabel: { formatter: (v: number) => fmt$(v) } },
              color: ['#0ea5e9', '#94a3b8'],
              series: [
                { name: 'This Period', type: 'line', smooth: true, data: trendChartData.map(g => g.cur_revenue), symbol: 'none', lineStyle: { width: 3 } },
                { name: 'Prior Period', type: 'line', smooth: true, data: trendChartData.map(g => g.prev_revenue), symbol: 'none', lineStyle: { width: 2, type: 'dashed' } },
              ]
            }}
            style={{ height: '300px' }}
          />
        </ChartWrapper>

        <ChartWrapper title="Shipment Comparison Trend">
          <p className="text-[10px] text-slate-400 font-medium -mt-3 mb-2">
            {trendChartData.length > 0 && trendChartData[0].cur_date && trendChartData[trendChartData.length - 1].cur_date
              ? `This period (${fmtShortDate(trendChartData[0].cur_date)} – ${fmtShortDate(trendChartData[trendChartData.length - 1].cur_date)}) vs prior period, day by day, matched by position in the range.`
              : 'Day-by-day shipment count, this period vs the prior comparable period.'}
          </p>
          <ReactECharts
            option={{
              tooltip: {
                ...echartTooltip, trigger: 'axis',
                formatter: (params: any) => {
                  const idx = params[0]?.dataIndex ?? 0;
                  const row = trendChartData[idx];
                  if (!row) return '';
                  return `<div style="font-weight:600;margin-bottom:4px;">${fmtAxisDate(row.cur_date)} vs ${fmtAxisDate(row.prev_date)}</div>`
                    + `<div>This period: <b>${fmtNum(row.cur_shipments)} shipments</b></div>`
                    + `<div>Prior period: <b>${fmtNum(row.prev_shipments)} shipments</b></div>`;
                }
              },
              legend: { bottom: 0, icon: 'circle', textStyle: { fontSize: 11 } },
              grid: { left: '3%', right: '4%', bottom: '15%', containLabel: true },
              xAxis: { type: 'category', data: trendChartData.map(g => fmtAxisDate(g.cur_date) || g.index), axisLine: { lineStyle: { color: '#e2e8f0' } }, axisLabel: { fontSize: 10, color: '#94a3b8' } },
              yAxis: { type: 'value', splitLine: { lineStyle: { type: 'dashed', color: '#f1f5f9' } } },
              color: ['#10b981', '#94a3b8'],
              series: [
                { name: 'This Period', type: 'bar', data: trendChartData.map(g => g.cur_shipments), itemStyle: { borderRadius: [4, 4, 0, 0] } },
                { name: 'Prior Period', type: 'bar', data: trendChartData.map(g => g.prev_shipments), itemStyle: { borderRadius: [4, 4, 0, 0] } },
              ]
            }}
            style={{ height: '300px' }}
          />
        </ChartWrapper>
      </div>

    </div>
  );
}
