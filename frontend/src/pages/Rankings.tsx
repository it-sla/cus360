import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  Trophy, Users, UserCog, Route as RouteIcon, DollarSign, Package, Weight,
  ArrowUpRight, ArrowDownRight, Medal, MapPin, Globe,
} from 'lucide-react';
import { ExportButton } from '@/components/ExportButton';
import { exportXlsx } from '@/lib/exportXlsx';
import { api } from '@/api';
import { DateRangeControl } from '@/components/AnalyticsFilterBar';
import { LeaderboardRankings } from '@/components/ui/leaderboard-rankings';
import type { LeaderboardRankingItem } from '@/components/ui/leaderboard-rankings';

const fmt$ = (v: number) => `$${(v || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
const fmtNum = (v: number) => (v || 0).toLocaleString();

type Tab = 'customers' | 'ae' | 'routes' | 'destinations' | 'countries';
type CustomerMetric = 'revenue' | 'shipments' | 'weight';

const RANK_STYLE: Record<number, { badge: string; bar: string }> = {
  1: { badge: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 border-amber-300 dark:border-amber-700', bar: 'bg-amber-400' },
  2: { badge: 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200 border-slate-300 dark:border-slate-600', bar: 'bg-slate-400' },
  3: { badge: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400 border-orange-300 dark:border-orange-700', bar: 'bg-orange-400' },
};
const DEFAULT_RANK_STYLE = { badge: 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400 border-slate-200 dark:border-slate-700', bar: 'bg-blue-400' };

function RankBadge({ rank }: { rank: number }) {
  const s = RANK_STYLE[rank] || DEFAULT_RANK_STYLE;
  return (
    <div className={`w-7 h-7 rounded-full border flex items-center justify-center text-xs font-black shrink-0 ${s.badge}`}>
      {rank <= 3 ? <Medal size={13} /> : rank}
    </div>
  );
}

function GrowthBadge({ pct }: { pct: number | undefined }) {
  if (pct === undefined) return null;
  const positive = pct >= 0;
  return (
    <span className={`inline-flex items-center gap-0.5 text-[10px] font-bold px-1.5 py-0.5 rounded ${positive ? 'text-emerald-600 bg-emerald-50 dark:text-emerald-400 dark:bg-emerald-900/20' : 'text-red-600 bg-red-50 dark:text-red-400 dark:bg-red-900/20'}`}>
      {positive ? <ArrowUpRight size={11} /> : <ArrowDownRight size={11} />} {Math.abs(pct).toFixed(0)}%
    </span>
  );
}

function LeaderboardRow({ rank, title, subtitle, value, valueLabel, barPct, growth, onClick }: {
  rank: number; title: string; subtitle?: string; value: string; valueLabel?: string; barPct: number; growth?: number; onClick?: () => void;
}) {
  const s = RANK_STYLE[rank] || DEFAULT_RANK_STYLE;
  return (
    <div onClick={onClick} className={`flex items-center gap-3 px-4 py-3 ${onClick ? 'cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/40' : ''} transition-colors`}>
      <RankBadge rank={rank} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2 mb-1">
          <div className="min-w-0">
            <div className="text-xs font-bold text-slate-900 dark:text-slate-100 truncate">{title}</div>
            {subtitle && <div className="text-[10px] text-slate-400 dark:text-slate-500 truncate font-medium">{subtitle}</div>}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <GrowthBadge pct={growth} />
            <div className="text-right">
              <div className="text-xs font-black text-slate-900 dark:text-slate-100 tabular-nums">{value}</div>
              {valueLabel && <div className="text-[9px] text-slate-400 dark:text-slate-500 font-semibold uppercase">{valueLabel}</div>}
            </div>
          </div>
        </div>
        <div className="h-1.5 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
          <div className={`h-full rounded-full ${s.bar}`} style={{ width: `${Math.max(2, Math.min(100, barPct))}%` }} />
        </div>
      </div>
    </div>
  );
}

const METRIC_OPTIONS: { key: CustomerMetric; label: string; icon: any }[] = [
  { key: 'revenue', label: 'Revenue', icon: DollarSign },
  { key: 'shipments', label: 'Shipments', icon: Package },
  { key: 'weight', label: 'Weight', icon: Weight },
];

export default function Rankings() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>('customers');
  const [metric, setMetric] = useState<CustomerMetric>('revenue');
  const [timeframe, setTimeframe] = useState('this_quarter');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  // `timeframe` must still be sent as 'custom' even in the date_from/date_to branch — every
  // backend endpoint here defaults its `timeframe` param when it's omitted from the query
  // string, so dropping it silently reverted every custom range back to that default period
  // (data and displayed dates both), regardless of the dates actually picked.
  const tfParams = timeframe === 'custom' ? { timeframe: 'custom', date_from: dateFrom, date_to: dateTo } : { timeframe };

  // Fetch up to the leaderboard's own max page size (100) so its "Show 10/25/50/100" selector
  // actually has rows to reveal at every option — it used to cap at 15 here, so picking 50 or
  // 100 in that dropdown silently did nothing.
  const customersQuery = useQuery({
    queryKey: ['topCustomers', timeframe, dateFrom, dateTo, metric],
    queryFn: () => api.getTopCustomers({ ...tfParams, metric, limit: 100 }),
  });
  const aeQuery = useQuery({
    queryKey: ['aePerformanceRankings', timeframe, dateFrom, dateTo],
    queryFn: () => api.getAEPerformance({ ...tfParams }),
  });
  const aeRosterQuery = useQuery({ queryKey: ['aeRoster'], queryFn: () => api.getAccountExecutives() });

  const bounds = customersQuery.data?.bounds;
  const routesQuery = useQuery({
    queryKey: ['pnlRoutesRankings', bounds?.c_start, bounds?.c_end],
    queryFn: () => api.getMawbPnlRoutes({ manifest_date_from: bounds!.c_start, manifest_date_to: bounds!.c_end, limit: 15 }),
    enabled: !!bounds,
  });
  const destinationsQuery = useQuery({
    queryKey: ['destinationRankings', timeframe, dateFrom, dateTo],
    queryFn: () => api.getGeographyDashboard({ ...tfParams, destinations_limit: 15 }),
  });

  const aeNameByCode = useMemo(() => {
    const map: Record<string, string> = {};
    for (const ae of aeRosterQuery.data || []) map[ae.ae_code] = ae.display_name || ae.ae_code;
    return map;
  }, [aeRosterQuery.data]);

  const customerItems = customersQuery.data?.items || [];

  // Same rankChange omission as the AE leaderboard below — pct_growth is a $ trend, not a
  // tracked prior-period rank position, so it belongs in the byline text, not rankChange.
  const customerLeaderboardItems: LeaderboardRankingItem[] = customerItems.map((c) => ({
    userId: c.company_id,
    userName: c.company_name,
    rank: c.rank,
    value: metric === 'weight' ? c.weight : metric === 'shipments' ? c.shipments : c.revenue,
    byline: [
      c.icris_number,
      c.segment,
      typeof c.pct_growth === 'number' ? `${c.pct_growth >= 0 ? '+' : ''}${c.pct_growth.toFixed(0)}% vs prior` : null,
    ].filter(Boolean).join(' · '),
  }));

  // No client-side slice here either — same reason as customers above, so the leaderboard's
  // own page-size selector has something to page through beyond the first screenful.
  const aeItems = [...(aeQuery.data?.items || [])].sort((a, b) => b.revenue - a.revenue);

  // rankChange is deliberately omitted — this endpoint doesn't track each AE's rank in the
  // prior period, only revenue_growth_pct (a $ trend, not a position change), and the
  // component's rankChange is a small integer "moved up/down N spots" — reusing % growth
  // there would render a misleading number.
  const aeLeaderboardItems: LeaderboardRankingItem[] = aeItems.map((ae, i) => ({
    userId: ae.ae,
    userName: aeNameByCode[ae.ae] || ae.ae,
    rank: i + 1,
    value: ae.revenue,
    byline: `${ae.companies} customer${ae.companies === 1 ? '' : 's'} · ${fmtNum(ae.shipments)} shipments · avg ${fmt$(ae.avg_revenue_per_customer)}/customer`,
  }));

  const routeItems = routesQuery.data || [];
  const maxRouteProfit = routeItems[0]?.profit_loss || 1;

  const destinationItems = destinationsQuery.data?.top_destinations || [];
  const maxDestinationRevenue = destinationItems[0]?.revenue || 1;

  // Already the complete, unbounded list (not sliced to a "top N" on the backend), so unlike
  // customers/routes/destinations, export doesn't need a separate high-limit fetch — the data
  // already loaded for the tab view is "all."
  const countryItems = destinationsQuery.data?.customers_by_country || [];
  const maxCountryRevenue = countryItems[0]?.revenue || 1;

  // Exports whichever tab is currently active, for the same period/filters shown on screen —
  // but the *full* ranked list, not just the top 15 the leaderboard displays. The AE tab's
  // query already returns every AE unsliced, so that one reuses state; customers and routes
  // are capped to 15 on screen for readability, so export re-fetches those with a high limit
  // rather than exporting only what's visible.
  const exportRankings = async () => {
    let rows: Record<string, any>[];
    let sheetName: string;
    let fileTag: string;

    if (tab === 'customers') {
      sheetName = 'Top Customers';
      fileTag = `all-customers-by-${metric}`;
      const full = await api.getTopCustomers({ ...tfParams, metric, limit: 2000 });
      rows = full.items.map((c) => ({
        Rank: c.rank,
        Customer: c.company_name,
        ICRIS: c.icris_number ?? '',
        Segment: c.segment ?? '',
        Revenue: c.revenue,
        Shipments: c.shipments,
        'Weight (kg)': c.weight,
        'Growth vs Prior (%)': typeof c.pct_growth === 'number' ? c.pct_growth : '',
      }));
    } else if (tab === 'ae') {
      sheetName = 'Account Executives';
      fileTag = 'all-aes';
      const allAes = [...(aeQuery.data?.items || [])].sort((a, b) => b.revenue - a.revenue);
      rows = allAes.map((ae, i) => ({
        Rank: i + 1,
        AE: aeNameByCode[ae.ae] || ae.ae,
        'AE Code': ae.ae,
        Revenue: ae.revenue,
        Customers: ae.companies,
        Shipments: ae.shipments,
        'Avg Revenue / Customer': ae.avg_revenue_per_customer,
        'Growth vs Prior (%)': ae.revenue_growth_pct,
      }));
    } else if (tab === 'routes') {
      sheetName = 'Routes by Profit';
      fileTag = 'all-routes-by-profit';
      const full = bounds
        ? await api.getMawbPnlRoutes({ manifest_date_from: bounds.c_start, manifest_date_to: bounds.c_end, limit: 1000 })
        : [];
      rows = full.map((r, i) => ({
        Rank: i + 1,
        Route: r.route,
        MAWBs: r.mawb_count,
        'Bill Amount': r.bill_amount,
        'Profit / Loss': r.profit_loss,
      }));
    } else if (tab === 'destinations') {
      sheetName = 'Destinations';
      fileTag = 'all-destinations';
      const full = await api.getGeographyDashboard({ ...tfParams, destinations_limit: 1000 });
      rows = (full.top_destinations || []).map((d: any, i: number) => ({
        Rank: i + 1,
        Destination: d.destination,
        Revenue: d.revenue,
        Shipments: d.shipments,
        'Weight (kg)': d.weight,
        Customers: d.customers,
      }));
    } else {
      sheetName = 'Customers by Country';
      fileTag = 'all-customers-by-country';
      rows = countryItems.map((c: any, i: number) => ({
        Rank: i + 1,
        Country: c.country,
        Customers: c.customers,
        Shipments: c.shipments,
        'Weight (kg)': c.weight,
        Revenue: c.revenue,
      }));
    }

    const periodTag = bounds?.c_start && bounds?.c_end ? `${bounds.c_start}_${bounds.c_end}` : timeframe;
    exportXlsx(`${fileTag}-${periodTag}`, [{
      name: sheetName,
      rows,
      formats: { Revenue: 'currency', 'Avg Revenue / Customer': 'currency', 'Bill Amount': 'currency', 'Profit / Loss': 'currency' },
    }]);
  };

  const activeTabHasRows = tab === 'customers' ? customerItems.length > 0
    : tab === 'ae' ? aeItems.length > 0
    : tab === 'routes' ? routeItems.length > 0
    : tab === 'destinations' ? destinationItems.length > 0
    : countryItems.length > 0;

  const TABS: { key: Tab; label: string; icon: any }[] = [
    { key: 'customers', label: 'Top Customers', icon: Users },
    { key: 'ae', label: 'Top Account Executives', icon: UserCog },
    { key: 'routes', label: 'Top Routes by Profit', icon: RouteIcon },
    { key: 'destinations', label: 'Top Destinations', icon: MapPin },
    { key: 'countries', label: 'Customers by Country', icon: Globe },
  ];

  return (
    <div className="flex-1 bg-background min-h-screen p-6 space-y-6">
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-xl font-black text-slate-900 dark:text-slate-100 flex items-center gap-2">
            <Trophy size={20} className="text-amber-500" /> Rankings
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 font-medium">
            Who's driving the business — customers, account executives, and routes ranked by performance.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <DateRangeControl
            timeframe={timeframe} dateFrom={dateFrom} dateTo={dateTo}
            bounds={customersQuery.data?.bounds}
            onPreset={(v) => { setTimeframe(v); setDateFrom(''); setDateTo(''); }}
            onCustom={(f, t) => { setTimeframe('custom'); setDateFrom(f); setDateTo(t); }}
            defaultPreset="this_quarter"
          />
          <ExportButton onExport={exportRankings} disabled={!activeTabHasRows} label="Export Excel (All)" />
        </div>
      </div>

      <div className="flex gap-1 border-b border-slate-200 dark:border-slate-800">
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex items-center gap-1.5 px-4 py-2.5 text-xs font-bold border-b-2 transition-colors -mb-px ${
              tab === t.key
                ? 'border-primary text-primary'
                : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
            }`}
          >
            <t.icon size={14} /> {t.label}
          </button>
        ))}
      </div>

      {tab === 'customers' && (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/30 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-slate-800">
            <span className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Ranked by</span>
            <div className="flex gap-1">
              {METRIC_OPTIONS.map(m => (
                <button key={m.key} onClick={() => setMetric(m.key)}
                  className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-bold transition-colors ${metric === m.key ? 'bg-primary text-white' : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'}`}>
                  <m.icon size={12} /> {m.label}
                </button>
              ))}
            </div>
          </div>
          {customersQuery.isLoading ? (
            <div className="p-12 text-center text-sm text-slate-400">Loading...</div>
          ) : customerItems.length === 0 ? (
            <div className="p-12 text-center text-sm text-slate-400">No shipment activity in this period.</div>
          ) : (
            <LeaderboardRankings
              className="rounded-none border-0"
              rankings={customerLeaderboardItems}
              onUserClick={(item) => navigate(`/app/customers/${item.userId}`)}
              showPagination={customerLeaderboardItems.length > 10}
            />
          )}
        </div>
      )}

      {tab === 'ae' && (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/30 overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800">
            <span className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Ranked by revenue managed</span>
          </div>
          {aeQuery.isLoading ? (
            <div className="p-12 text-center text-sm text-slate-400">Loading...</div>
          ) : aeItems.length === 0 ? (
            <div className="p-12 text-center text-sm text-slate-400">No AE activity in this period.</div>
          ) : (
            <LeaderboardRankings
              className="rounded-none border-0"
              rankings={aeLeaderboardItems}
              onUserClick={(item) => navigate(`/app/ae-performance?ae_code=${item.userId}`)}
              showPagination={aeLeaderboardItems.length > 10}
            />
          )}
        </div>
      )}

      {tab === 'routes' && (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/30 overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800">
            <span className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Ranked by UPS profit — synced MAWBs only</span>
          </div>
          {routesQuery.isLoading ? (
            <div className="p-12 text-center text-sm text-slate-400">Loading...</div>
          ) : routeItems.length === 0 ? (
            <div className="p-12 text-center text-sm text-slate-400">
              No synced P&L data in this period — sync some on the <button onClick={() => navigate('/app/profitability')} className="text-primary font-bold hover:underline">Profitability page</button> first.
            </div>
          ) : (
            <div className="divide-y divide-slate-100 dark:divide-slate-800/50">
              {routeItems.map((r, i) => (
                <LeaderboardRow
                  key={r.route}
                  rank={i + 1}
                  title={r.route}
                  subtitle={`${r.mawb_count} MAWB${r.mawb_count === 1 ? '' : 's'} · ${fmt$(r.bill_amount)} billed`}
                  value={fmt$(r.profit_loss)}
                  valueLabel="profit"
                  barPct={(r.profit_loss / maxRouteProfit) * 100}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'destinations' && (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/30 overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800">
            <span className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Ranked by revenue</span>
          </div>
          {destinationsQuery.isLoading ? (
            <div className="p-12 text-center text-sm text-slate-400">Loading...</div>
          ) : destinationItems.length === 0 ? (
            <div className="p-12 text-center text-sm text-slate-400">No shipment activity in this period.</div>
          ) : (
            <div className="divide-y divide-slate-100 dark:divide-slate-800/50">
              {destinationItems.map((d: any, i: number) => (
                <LeaderboardRow
                  key={d.destination}
                  rank={i + 1}
                  title={d.destination}
                  subtitle={`${fmtNum(d.shipments)} shipment${d.shipments === 1 ? '' : 's'} · ${fmtNum(d.customers)} customer${d.customers === 1 ? '' : 's'} · ${fmtNum(d.weight)} kg`}
                  value={fmt$(d.revenue)}
                  valueLabel="revenue"
                  barPct={(d.revenue / maxDestinationRevenue) * 100}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'countries' && (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/30 overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800">
            <span className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Ranked by revenue</span>
          </div>
          {destinationsQuery.isLoading ? (
            <div className="p-12 text-center text-sm text-slate-400">Loading...</div>
          ) : countryItems.length === 0 ? (
            <div className="p-12 text-center text-sm text-slate-400">No shipment activity in this period.</div>
          ) : (
            <div className="divide-y divide-slate-100 dark:divide-slate-800/50">
              {countryItems.map((c: any, i: number) => (
                <LeaderboardRow
                  key={c.country}
                  rank={i + 1}
                  title={c.country}
                  subtitle={`${fmtNum(c.customers)} customer${c.customers === 1 ? '' : 's'} · ${fmtNum(c.shipments)} shipment${c.shipments === 1 ? '' : 's'} · ${fmtNum(c.weight)} kg`}
                  value={fmt$(c.revenue)}
                  valueLabel="revenue"
                  barPct={(c.revenue / maxCountryRevenue) * 100}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
