import React, { useState, useMemo } from 'react';
import { useParams, useNavigate, useSearchParams, useLocation } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, Download, Save, Loader2, CheckCircle2, Truck,
  BarChart3, Activity, Settings, PhoneCall,
  Mail, Phone, MapPin, Calendar, Hash, Building2, UserCog,
  FileText, Upload, Trash2, File as FileIcon, UploadCloud, Edit2, X, Check
} from 'lucide-react';
import ReactECharts from 'echarts-for-react';
import { api, type CompanyDetail, type CompanyShipment, type ActivityLog, type CallLog } from '../api';
import { FilterSelect, DateRangeControl } from '@/components/AnalyticsFilterBar';
import { useAuth } from '@/auth';

const INACTIVITY_COLORS: Record<string, { text: string; dot: string }> = {
  active:   { text: 'text-emerald-600', dot: 'bg-emerald-500' },
  quiet:    { text: 'text-sky-600',     dot: 'bg-sky-500'     },
  inactive: { text: 'text-amber-600',   dot: 'bg-amber-500'   },
  dormant:  { text: 'text-rose-600',    dot: 'bg-rose-500'    },
};

const TABS = [
  { id: 'overview',   label: 'Overview',   icon: Building2  },
  { id: 'analytics',  label: 'Analytics',  icon: BarChart3  },
  { id: 'shipments',  label: 'Shipments',  icon: Truck      },
  { id: 'call-logs',  label: 'Call Logs',  icon: PhoneCall  },
  { id: 'documents',  label: 'Documents',  icon: FileText   },
  { id: 'activity',   label: 'Activity',   icon: Activity   },
  { id: 'settings',   label: 'Settings',   icon: Settings   },
];

// ── Formatters ──────────────────────────────────────────────────────────

const fmtNum  = (n: number | null | undefined) => (n ?? 0).toLocaleString();
const fmt$    = (n: number | null | undefined) => `$${(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDelta = (pct: number | null | undefined) => {
  if (pct === null || pct === undefined || !isFinite(pct)) return null;
  const up = pct >= 0;
  return (
    <span className={`text-[10px] font-bold ${up ? 'text-emerald-600' : 'text-rose-600'}`}>
      {up ? '▲' : '▼'} {Math.abs(pct).toFixed(1)}%
    </span>
  );
};
const fmtDate = (d: string | null) => d
  ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  : '—';
const fmtDateTime = (d: string | null) => d
  ? new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  : '—';

// ── Shared sub-components ───────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const s = INACTIVITY_COLORS[status] || INACTIVITY_COLORS.active;
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-semibold ${s.text}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} />
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

function SkeletonBlock({ className }: { className?: string }) {
  return <div className={`bg-slate-100 dark:bg-slate-800 rounded-xl animate-pulse ${className || 'h-32'}`} />;
}

function SectionCard({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="bg-white dark:bg-slate-900/50 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-sm">
      <div className="mb-5">
        <h2 className="text-base font-bold text-slate-900 dark:text-slate-100">{title}</h2>
        {subtitle && <p className="text-xs text-slate-400 dark:text-slate-400 mt-0.5">{subtitle}</p>}
      </div>
      {children}
    </div>
  );
}

function InfoRow({ label, value, icon: Icon }: { label: string; value: string | null | undefined; icon: React.ElementType }) {
  return (
    <div className="flex items-center gap-3 py-2.5 border-b border-slate-50 dark:border-slate-800/50 last:border-0">
      <Icon size={14} className="text-slate-400 dark:text-slate-400 shrink-0" />
      <span className="text-xs text-slate-400 dark:text-slate-400 w-28 shrink-0">{label}</span>
      <span className="text-sm text-slate-800 dark:text-slate-200 font-medium break-words">{value || '—'}</span>
    </div>
  );
}

function AeAssignRow({ companyId, currentAeCode }: { companyId: string; currentAeCode: string | null }) {
  const { isAdmin } = useAuth();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<'idle' | 'saved' | 'error'>('idle');

  const { data: roster } = useQuery({
    queryKey: ['account-executives', true],
    queryFn: () => api.getAccountExecutives(true),
    enabled: isAdmin,
  });

  const mutation = useMutation({
    mutationFn: (ae_code: string) => api.assignAE(companyId, ae_code, 'Manual assignment from Customer 360'),
    onSuccess: () => {
      setStatus('saved');
      queryClient.invalidateQueries({ queryKey: ['company-detail', companyId] });
      setTimeout(() => setStatus('idle'), 2000);
    },
    onError: () => setStatus('error'),
  });

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const code = e.target.value;
    if (!code || code === currentAeCode) return;
    setStatus('idle');
    mutation.mutate(code);
  };

  return (
    <div className="flex items-center gap-3 py-2.5 border-b border-slate-50 dark:border-slate-800/50 last:border-0">
      <UserCog size={14} className="text-slate-400 dark:text-slate-400 shrink-0" />
      <span className="text-xs text-slate-400 dark:text-slate-400 w-28 shrink-0">Assigned AE</span>
      <div className="flex items-center gap-2 flex-1 min-w-0">
        {isAdmin ? (
          <>
            <select
              value={currentAeCode || ''}
              onChange={handleChange}
              disabled={mutation.isPending}
              className="text-sm text-slate-800 dark:text-slate-200 font-medium bg-white dark:bg-slate-900/50 border border-slate-200 dark:border-slate-700 rounded-lg px-2 py-1 outline-none disabled:opacity-50 cursor-pointer"
            >
              <option value="">Unassigned</option>
              {(roster || []).map(ae => (
                <option key={ae.ae_code} value={ae.ae_code}>{ae.display_name ? `${ae.display_name} (${ae.ae_code})` : ae.ae_code}</option>
              ))}
            </select>
            {mutation.isPending && <Loader2 size={13} className="animate-spin text-slate-400" />}
            {status === 'saved' && <span className="text-xs font-semibold text-emerald-600 dark:text-emerald-400 flex items-center gap-1"><CheckCircle2 size={13} /> Saved</span>}
            {status === 'error' && <span className="text-xs font-semibold text-red-600 dark:text-red-400">Failed — try again</span>}
          </>
        ) : (
          <span className="text-sm text-slate-800 dark:text-slate-200 font-medium">{currentAeCode || 'Unassigned'}</span>
        )}
      </div>
    </div>
  );
}

// ── Overview Tab ─────────────────────────────────────────────────────────

function OverviewTab({ company }: { company: CompanyDetail }) {
  const s = company.summary || ({} as any);

  const healthScore = useMemo(() => {
    let score = 50;
    if (s.shipment_count > 0) score += 15;
    if (s.inactivity_status === 'active') score += 15;
    else if (s.inactivity_status === 'dormant') score -= 15;
    if ((s.name_mismatch_count || 0) > 0) score -= 10;
    if (s.matched_shipment_count > (s.unmatched_shipment_count || 0)) score += 5;
    return Math.max(0, Math.min(100, score));
  }, [s]);

  const healthColor = healthScore >= 70 ? 'text-emerald-600' : healthScore >= 40 ? 'text-amber-600' : 'text-rose-600';

  return (
    <div className="space-y-6">
      {/* KPI Strip */}
      <div className="flex flex-wrap items-center gap-6 py-4 border-b border-slate-100 dark:border-slate-800/50">
        {[
          { label: 'AWBs',          value: fmtNum(s.shipment_count)     },
          { label: 'Packages',      value: fmtNum(s.package_count)      },
          { label: 'Last Shipment', value: fmtDate(s.last_shipment_date) },
          { label: 'Days Inactive', value: s.days_since_last_shipment != null ? `${s.days_since_last_shipment}d` : '—' },
          { label: 'Documents',     value: fmtNum(s.document_count)     },
        ].map((item, i) => (
          <React.Fragment key={item.label}>
            {i > 0 && <div className="w-px h-8 bg-slate-200 dark:bg-slate-800 hidden sm:block" />}
            <div>
              <div className="text-[10px] font-bold text-slate-400 dark:text-slate-400 uppercase tracking-wider mb-0.5">{item.label}</div>
              <div className="text-xl font-bold text-slate-900 dark:text-slate-100 tracking-tight">{item.value}</div>
            </div>
          </React.Fragment>
        ))}
        <div className="w-px h-8 bg-slate-200 dark:bg-slate-800 hidden sm:block" />
        <div>
          <div className="text-[10px] font-bold text-slate-400 dark:text-slate-400 uppercase tracking-wider mb-0.5">Health</div>
          <div className={`text-xl font-bold tracking-tight ${healthColor}`}>{healthScore}</div>
        </div>
      </div>

      {/* Info Grids */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <SectionCard title="Company Identity">
          <InfoRow icon={Hash}      label="ICRIS"       value={company.icris_number}    />
          <InfoRow icon={Building2} label="Legal Name"  value={company.legal_name}      />
          <InfoRow icon={Building2} label="Type"        value={company.customer_type}   />
          <AeAssignRow companyId={company.id} currentAeCode={company.assigned_ae_code} />
          <InfoRow icon={Calendar}  label="Created"     value={fmtDate(company.created_at)} />
          {company.is_provisional && (
            <div className="mt-3 text-xs font-semibold text-amber-700 bg-amber-50 px-3 py-2 rounded-lg border border-amber-200">
              Provisional — awaiting ICRIS verification
            </div>
          )}
        </SectionCard>

        <SectionCard title="Contact Details">
          <InfoRow icon={Mail}   label="Email"   value={company.email}          />
          <InfoRow icon={Phone}  label="Phone"   value={company.phone}          />
          <InfoRow icon={MapPin} label="Address" value={company.address}        />
          <InfoRow icon={Hash}   label="PAN/VAT" value={company.pan_vat_number} />
        </SectionCard>
      </div>

      {/* Shipment Match Status */}
      <SectionCard title="Shipment Match Status" subtitle="Matched vs unmatched Air Waybills">
        <div className="grid grid-cols-3 gap-4">
          {[
            { label: 'Matched',    value: s.matched_shipment_count   || 0, color: 'text-emerald-600 bg-emerald-50 border-emerald-200 dark:bg-emerald-900/20 dark:border-emerald-800 dark:text-emerald-400' },
            { label: 'Suggested',  value: s.suggested_shipment_count || 0, color: 'text-amber-600 bg-amber-50 border-amber-200 dark:bg-amber-900/20 dark:border-amber-800 dark:text-amber-400'       },
            { label: 'Unmatched',  value: s.unmatched_shipment_count || 0, color: 'text-rose-600 bg-rose-50 border-rose-200 dark:bg-rose-900/20 dark:border-rose-800 dark:text-rose-400'          },
          ].map((item) => (
            <div key={item.label} className={`text-center py-4 rounded-xl border ${item.color}`}>
              <div className="text-[10px] font-bold uppercase tracking-wider opacity-70 mb-1">{item.label}</div>
              <div className="text-2xl font-extrabold">{item.value}</div>
            </div>
          ))}
        </div>
      </SectionCard>
    </div>
  );
}

// ── Analytics Tab ────────────────────────────────────────────────────────

function AnalyticsTab({ companyId }: { companyId: string }) {
  const [filters, setFilters] = useState({
    timeframe: 'all_time',
    dateFrom: '',
    dateTo: '',
    destination: '',
  });
  const updateFilter = (key: string, value: string) => setFilters(f => ({ ...f, [key]: value }));

  const { data: analytics, isLoading } = useQuery({
    queryKey: ['company-analytics', companyId, filters],
    queryFn: () => api.getCompanyAnalytics(companyId, {
      timeframe: filters.timeframe,
      date_from: filters.timeframe === 'custom' ? filters.dateFrom : undefined,
      date_to: filters.timeframe === 'custom' ? filters.dateTo : undefined,
      destination: filters.destination || undefined,
    }),
    enabled: !!companyId,
  });

  return (
    <div className="space-y-6">
      {/* Filter Bar. No Origin filter — every shipment's own export_country is blank in
          the source data (this business ships almost exclusively from Nepal), so there's
          no real per-shipment origin-country signal to filter by. */}
      <div className="flex flex-wrap items-center gap-2">
        <DateRangeControl
          timeframe={filters.timeframe} dateFrom={filters.dateFrom} dateTo={filters.dateTo} bounds={analytics?.bounds}
          onPreset={(v) => { updateFilter('timeframe', v); updateFilter('dateFrom', ''); updateFilter('dateTo', ''); }}
          onCustom={(f, t) => { updateFilter('timeframe', 'custom'); updateFilter('dateFrom', f); updateFilter('dateTo', t); }}
          defaultPreset="all_time"
        />
        <FilterSelect icon={MapPin} value={filters.destination} onChange={(e) => updateFilter('destination', e.target.value)}
          options={(analytics?.destination_options || []).map(d => d.import_country)} placeholder="All Destinations" />
      </div>

      {isLoading || !analytics ? (
        <div className="space-y-4">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">{[1, 2, 3, 4].map(i => <SkeletonBlock key={i} className="h-20" />)}</div>
          {[1, 2].map((i) => <SkeletonBlock key={i} className="h-56" />)}
        </div>
      ) : (
        <>
          {/* KPI Cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[
              { label: 'Revenue', value: fmt$(analytics.kpi_cards.revenue.value), pct: analytics.kpi_cards.revenue.pop_pct },
              { label: 'Total Shipments', value: fmtNum(analytics.kpi_cards.shipments.value), pct: analytics.kpi_cards.shipments.pop_pct },
              { label: 'Total Weight', value: `${fmtNum(analytics.kpi_cards.weight.value)} kg`, pct: analytics.kpi_cards.weight.pop_pct },
              { label: 'Avg Shipment Value', value: fmt$(analytics.kpi_cards.avg_shipment_value.value), pct: analytics.kpi_cards.avg_shipment_value.pop_pct },
            ].map(kpi => (
              <div key={kpi.label} className="bg-white dark:bg-slate-900/50 border border-slate-200 dark:border-slate-800 rounded-2xl p-4 shadow-sm">
                <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">{kpi.label}</div>
                <div className="text-xl font-bold text-slate-900 dark:text-slate-100 tracking-tight">{kpi.value}</div>
                {filters.timeframe !== 'all_time' && fmtDelta(kpi.pct) && <div className="mt-0.5">{fmtDelta(kpi.pct)}</div>}
              </div>
            ))}
          </div>

          {/* Revenue & Shipment Trend */}
          <SectionCard title="Revenue & Shipment Trend" subtitle="Monthly revenue and shipment volume">
            <div className="h-[280px]">
              {analytics.trend.length > 0 ? (
                <ReactECharts
                  option={{
                    grid: { top: 30, right: 50, left: 60, bottom: 20 },
                    tooltip: { trigger: 'axis' },
                    legend: { data: ['Revenue', 'Shipments'], top: 0, textStyle: { fontSize: 11 } },
                    xAxis: { type: 'category', data: analytics.trend.map(d => d.month) },
                    yAxis: [
                      { type: 'value', name: 'Revenue ($)', position: 'left' },
                      { type: 'value', name: 'Shipments', position: 'right', splitLine: { show: false } },
                    ],
                    series: [
                      { name: 'Revenue', type: 'line', smooth: true, yAxisIndex: 0, data: analytics.trend.map(d => d.revenue), itemStyle: { color: '#0F766E' } },
                      { name: 'Shipments', type: 'bar', yAxisIndex: 1, data: analytics.trend.map(d => d.shipments), itemStyle: { color: '#0EA5E9', opacity: 0.6 } },
                    ],
                  }}
                  style={{ height: '100%', width: '100%' }}
                />
              ) : <div className="py-12 text-center text-xs text-slate-400 dark:text-slate-400">No trend data for this period</div>}
            </div>
          </SectionCard>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <SectionCard title="Shipment Weight" subtitle="Total weight (kg)">
              <div className="h-[240px]">
                {analytics.weights.length > 0 ? (
                  <ReactECharts
                    option={{
                      grid: { top: 10, right: 20, left: 40, bottom: 20 },
                      tooltip: { trigger: 'axis' },
                      xAxis: { type: 'category', data: analytics.weights.map(d => d.weight_unit) },
                      yAxis: { type: 'value' },
                      series: [{ type: 'bar', data: analytics.weights.map(d => d.total), itemStyle: { color: '#0F766E' } }]
                    }}
                    style={{ height: '100%', width: '100%' }}
                  />
                ) : <div className="py-12 text-center text-xs text-slate-400 dark:text-slate-400">No weight data for this period</div>}
              </div>
            </SectionCard>

            <SectionCard title="Destination Distribution" subtitle={`${analytics.destinations.length} destinations`}>
              <div className="h-[240px]">
                {analytics.destinations.length > 0 ? (
                  <ReactECharts
                    option={{
                      grid: { top: 10, right: 50, left: 60, bottom: 20 },
                      tooltip: { trigger: 'axis' },
                      xAxis: { type: 'value' },
                      yAxis: { type: 'category', data: analytics.destinations.slice(0, 10).map(d => d.import_country) },
                      series: [{ type: 'bar', data: analytics.destinations.slice(0, 10).map(d => d.count), itemStyle: { color: '#8B5CF6' } }]
                    }}
                    style={{ height: '100%', width: '100%' }}
                  />
                ) : <div className="py-12 text-center text-xs text-slate-400 dark:text-slate-400">No destination data for this period</div>}
              </div>
            </SectionCard>
          </div>
        </>
      )}
    </div>
  );
}

// ── Shipments Tab ────────────────────────────────────────────────────────

function ShipmentsTab({ companyId }: { companyId: string }) {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 15;

  const { data: shipments, isLoading } = useQuery({
    queryKey: ['company-shipments', companyId],
    queryFn: () => api.getCompanyShipments(companyId),
    enabled: !!companyId,
  });

  const filtered = useMemo(() => {
    if (!shipments) return [];
    const q = search.toLowerCase();
    const matched = !search ? shipments : shipments.filter((s: CompanyShipment) =>
      s.shipment_number?.toLowerCase().includes(q) ||
      s.import_country?.toLowerCase().includes(q) ||
      s.export_country?.toLowerCase().includes(q)
    );
    // Most recent shipment first — undated rows (shouldn't normally happen) sink to the bottom
    // rather than interleaving with dated ones.
    return [...matched].sort((a: CompanyShipment, b: CompanyShipment) => {
      if (!a.shipment_date) return 1;
      if (!b.shipment_date) return -1;
      return b.shipment_date.localeCompare(a.shipment_date);
    });
  }, [shipments, search]);

  const paged      = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);

  if (isLoading) return <div className="space-y-2">{[1, 2, 3, 4, 5].map((i) => <SkeletonBlock key={i} className="h-10" />)}</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <input
          type="text"
          placeholder="Search shipments…"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(0); }}
          className="h-9 px-3 bg-white dark:bg-slate-900/50 border border-slate-200 dark:border-slate-800 rounded-lg text-xs text-slate-800 dark:text-slate-200 placeholder:text-slate-400 dark:text-slate-400 focus:ring-2 focus:ring-teal-500/20 focus:border-teal-400 outline-none w-64"
        />
        <span className="text-xs text-slate-400 dark:text-slate-400">{filtered.length} shipments</span>
      </div>

      <div className="bg-white dark:bg-slate-900/50 border border-slate-200 dark:border-slate-800 rounded-2xl overflow-hidden shadow-sm">
        <table className="w-full text-left text-xs">
          <thead className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-800">
            <tr className="text-[10px] uppercase font-bold tracking-wider text-slate-500 dark:text-slate-400">
              <th className="px-4 py-3">AWB #</th>
              <th className="px-4 py-3">Date</th>
              <th className="px-4 py-3">Origin</th>
              <th className="px-4 py-3">Destination</th>
              <th className="px-4 py-3 text-right">Weight</th>
              <th className="px-4 py-3 text-right">Pieces</th>
              <th className="px-4 py-3">Bill Type</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800/50">
            {paged.length === 0 ? (
              <tr><td colSpan={7} className="py-12 text-center text-sm text-slate-400 dark:text-slate-400">No shipments found</td></tr>
            ) : paged.map((row: CompanyShipment) => (
              <tr key={row.id} className="transition-colors">
                <td className="px-4 py-3 font-semibold text-slate-900 dark:text-slate-100 font-mono">{row.shipment_number}</td>
                <td className="px-4 py-3 text-slate-500 dark:text-slate-400">{fmtDate(row.shipment_date)}</td>
                <td className="px-4 py-3 text-slate-600 dark:text-slate-300">{row.export_country || '—'}</td>
                <td className="px-4 py-3 text-slate-600 dark:text-slate-300">{row.import_country || '—'}</td>
                <td className="px-4 py-3 text-right text-slate-700 dark:text-slate-200 tabular-nums">{row.shipment_weight != null ? `${row.shipment_weight} ${row.weight_unit || 'kg'}` : '—'}</td>
                <td className="px-4 py-3 text-right text-slate-700 dark:text-slate-200 tabular-nums">{row.pieces || '—'}</td>
                <td className="px-4 py-3 text-slate-500 dark:text-slate-400">{row.bill_type || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <span className="text-xs text-slate-400 dark:text-slate-400">Page {page + 1} of {totalPages}</span>
          <div className="flex gap-1">
            <button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}
              className="h-7 px-2.5 border border-slate-200 dark:border-slate-800 rounded-lg text-xs font-medium text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800/50 disabled:opacity-40 transition-all">Prev</button>
            <button onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1}
              className="h-7 px-2.5 border border-slate-200 dark:border-slate-800 rounded-lg text-xs font-medium text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800/50 disabled:opacity-40 transition-all">Next</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Call Logs Tab ────────────────────────────────────────────────────────

const STAGE_COLORS: Record<string, string> = {
  win:      'text-emerald-600 bg-emerald-50 dark:bg-emerald-500/10',
  loss:     'text-rose-600 bg-rose-50 dark:bg-rose-500/10',
  prospect: 'text-sky-600 bg-sky-50 dark:bg-sky-500/10',
};

function CallLogsTab({ companyId }: { companyId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['company-call-logs', companyId],
    queryFn: () => api.getCompanyCallLogs(companyId),
    enabled: !!companyId,
  });

  if (isLoading) return <div className="space-y-2">{[1, 2, 3, 4, 5].map((i) => <SkeletonBlock key={i} className="h-10" />)}</div>;

  const logs = data?.items ?? [];

  return (
    <div className="space-y-4">
      <span className="text-xs text-slate-400 dark:text-slate-400">{logs.length} call{logs.length === 1 ? '' : 's'} logged in the CRM</span>

      <div className="bg-white dark:bg-slate-900/50 border border-slate-200 dark:border-slate-800 rounded-2xl overflow-hidden shadow-sm">
        <table className="w-full text-left text-xs">
          <thead className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-800">
            <tr className="text-[10px] uppercase font-bold tracking-wider text-slate-500 dark:text-slate-400">
              <th className="px-4 py-3">Date</th>
              <th className="px-4 py-3">Stage</th>
              <th className="px-4 py-3">Contact</th>
              <th className="px-4 py-3">Type</th>
              <th className="px-4 py-3">AE</th>
              <th className="px-4 py-3">Remarks</th>
              <th className="px-4 py-3">Follow up</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800/50">
            {logs.length === 0 ? (
              <tr><td colSpan={7} className="py-12 text-center text-sm text-slate-400 dark:text-slate-400">No call logs found</td></tr>
            ) : logs.map((row: CallLog) => {
              const stageKey = (row.stage || '').toLowerCase();
              const stageClass = STAGE_COLORS[stageKey] || 'text-slate-500 bg-slate-50 dark:bg-slate-800/50';
              return (
                <tr key={row.id} className="transition-colors">
                  <td className="px-4 py-3 text-slate-500 dark:text-slate-400 whitespace-nowrap">{fmtDate(row.call_date)}</td>
                  <td className="px-4 py-3">
                    {row.stage ? <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${stageClass}`}>{row.stage}</span> : <span className="text-slate-400">—</span>}
                  </td>
                  <td className="px-4 py-3 text-slate-700 dark:text-slate-200">
                    <div>{row.contact_person || '—'}</div>
                    {row.phone && <div className="text-[10px] text-slate-400 dark:text-slate-500">{row.phone}</div>}
                  </td>
                  <td className="px-4 py-3 text-slate-600 dark:text-slate-300 whitespace-nowrap">{row.call_type || '—'}</td>
                  <td className="px-4 py-3 font-mono text-slate-600 dark:text-slate-300">{row.ae_code || '—'}</td>
                  <td className="px-4 py-3 text-slate-600 dark:text-slate-300 max-w-xs">
                    <div>{row.remarks || '—'}</div>
                    {row.supervisor_comment && <div className="text-[10px] text-slate-400 dark:text-slate-500 mt-0.5">Supervisor: {row.supervisor_comment}</div>}
                  </td>
                  <td className="px-4 py-3 text-slate-500 dark:text-slate-400 whitespace-nowrap">{fmtDate(row.follow_up_date)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Documents Tab ────────────────────────────────────────────────────────

function DocumentsTab({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  
  const [uploading, setUploading] = useState(false);
  const [form, setForm] = useState({ title: '', category: 'other', description: '' });
  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  const [editingDocId, setEditingDocId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ title: '', category: 'other' });

  const { data: documents, isLoading } = useQuery({
    queryKey: ['company-documents', companyId],
    queryFn: () => api.getCompanyDocuments(companyId),
    enabled: !!companyId,
  });

  const uploadMutation = useMutation({
    mutationFn: (data: { file: File, title: string, category: string, description: string }) => 
      api.uploadCompanyDocument(companyId, data.file, data.title, data.category, data.description),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['company-documents', companyId] });
      setForm({ title: '', category: 'other', description: '' });
      setSelectedFile(null);
      setUploading(false);
    },
    onError: () => setUploading(false)
  });

  const archiveMutation = useMutation({
    mutationFn: (docId: string) => api.archiveDocument(docId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['company-documents', companyId] })
  });

  const updateMutation = useMutation({
    mutationFn: (data: { id: string, title: string, category: string }) => api.updateDocument(data.id, { title: data.title, category: data.category }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['company-documents', companyId] });
      setEditingDocId(null);
    }
  });

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      setSelectedFile(file);
      if (!form.title) setForm(f => ({ ...f, title: file.name }));
    }
  };

  const handleUpload = () => {
    if (!selectedFile || !form.title) return;
    setUploading(true);
    uploadMutation.mutate({ file: selectedFile, title: form.title, category: form.category, description: form.description });
  };

  if (isLoading) return <div className="space-y-3"><SkeletonBlock className="h-32" /><SkeletonBlock className="h-64" /></div>;

  const docs = (documents || []).filter(d => d.status !== 'archived');

  return (
    <div className="space-y-6 max-w-5xl">
      <SectionCard title="Upload Document" subtitle="Add contracts, invoices, or identity files.">
        <div className="flex flex-col md:flex-row gap-6">
          <div className="flex-1 space-y-4">
            <div>
              <label className="text-[10px] font-bold text-slate-400 dark:text-slate-400 uppercase tracking-widest mb-1.5 block">Document Title</label>
              <input type="text" value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} className="w-full h-9 px-3 bg-white dark:bg-slate-900/50 border border-slate-200 dark:border-slate-800 rounded-lg text-xs text-slate-800 dark:text-slate-200 outline-none focus:border-teal-400" placeholder="e.g. Service Agreement 2026" />
            </div>
            <div className="flex gap-4">
              <div className="flex-1">
                <label className="text-[10px] font-bold text-slate-400 dark:text-slate-400 uppercase tracking-widest mb-1.5 block">Category</label>
                <select value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))} className="w-full h-9 px-3 bg-white dark:bg-slate-900/50 border border-slate-200 dark:border-slate-800 rounded-lg text-xs text-slate-800 dark:text-slate-200 outline-none focus:border-teal-400 cursor-pointer">
                  <option value="company_registration">Company Registration</option>
                  <option value="pan_vat">PAN / VAT</option>
                  <option value="kyc">KYC</option>
                  <option value="contract">Contract</option>
                  <option value="rate_sheet">Rate Sheet</option>
                  <option value="invoice">Invoice</option>
                  <option value="correspondence">Correspondence</option>
                  <option value="operations">Operations</option>
                  <option value="other">Other</option>
                </select>
              </div>
            </div>
          </div>
          <div className="w-full md:w-64 shrink-0">
            <input type="file" ref={fileInputRef} onChange={handleFileChange} className="hidden" />
            {!selectedFile ? (
              <button onClick={() => fileInputRef.current?.click()} className="w-full h-full min-h-[100px] border-2 border-dashed border-slate-200 dark:border-slate-800 hover:border-teal-400 hover:bg-teal-50/50 rounded-xl flex flex-col items-center justify-center gap-2 text-slate-400 dark:text-slate-400 hover:text-teal-600 transition-colors">
                <UploadCloud size={24} />
                <span className="text-xs font-semibold">Select File</span>
              </button>
            ) : (
              <div className="w-full h-full min-h-[100px] border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50 rounded-xl p-4 flex flex-col justify-between">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200 truncate"><FileIcon size={16} className="text-teal-600 shrink-0"/><span className="truncate" title={selectedFile.name}>{selectedFile.name}</span></div>
                </div>
                <div className="text-[10px] font-medium text-slate-500 dark:text-slate-400 mb-3">{Math.round(selectedFile.size / 1024)} KB</div>
                <div className="flex gap-2">
                  <button onClick={handleUpload} disabled={uploading || !form.title} className="flex-1 h-7 bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white rounded text-[11px] font-bold transition-colors flex items-center justify-center gap-1.5">
                    {uploading ? <Loader2 size={12} className="animate-spin"/> : <Upload size={12}/>} {uploading ? 'Uploading...' : 'Upload'}
                  </button>
                  <button onClick={() => setSelectedFile(null)} disabled={uploading} className="h-7 px-3 bg-white dark:bg-slate-900/50 border border-slate-200 dark:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800 rounded text-[11px] font-bold text-slate-600 dark:text-slate-300 transition-colors">Cancel</button>
                </div>
              </div>
            )}
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Company Documents" subtitle={`${docs.length} files available`}>
        {docs.length === 0 ? (
          <div className="py-12 text-center text-sm text-slate-400 dark:text-slate-400">No documents uploaded yet.</div>
        ) : (
          <div className="border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden shadow-sm">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-800">
                  <th className="px-4 py-2 text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest">Document</th>
                  <th className="px-4 py-2 text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest">Category</th>
                  <th className="px-4 py-2 text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest">Size</th>
                  <th className="px-4 py-2 text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest">Uploaded</th>
                  <th className="px-4 py-2 text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="text-xs divide-y divide-slate-100 dark:divide-slate-800/50 bg-white dark:bg-slate-900/50">
                {docs.map(d => (
                  <tr key={d.id} className="transition-colors">
                    {editingDocId === d.id ? (
                      <>
                        <td className="px-4 py-3">
                          <input type="text" value={editForm.title} onChange={e => setEditForm(f => ({ ...f, title: e.target.value }))} className="w-full h-8 px-2 border border-slate-300 rounded text-xs outline-none focus:border-teal-400" />
                        </td>
                        <td className="px-4 py-3">
                          <select value={editForm.category} onChange={e => setEditForm(f => ({ ...f, category: e.target.value }))} className="w-full h-8 px-2 border border-slate-300 rounded text-xs outline-none focus:border-teal-400">
                            <option value="company_registration">Company Registration</option>
                            <option value="pan_vat">PAN / VAT</option>
                            <option value="kyc">KYC</option>
                            <option value="contract">Contract</option>
                            <option value="rate_sheet">Rate Sheet</option>
                            <option value="invoice">Invoice</option>
                            <option value="correspondence">Correspondence</option>
                            <option value="operations">Operations</option>
                            <option value="other">Other</option>
                          </select>
                        </td>
                        <td className="px-4 py-3 text-slate-500 dark:text-slate-400">{Math.round((d.file_size_bytes || 0) / 1024)} KB</td>
                        <td className="px-4 py-3 text-slate-500 dark:text-slate-400">{fmtDate(d.uploaded_at || null)}</td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex items-center justify-end gap-2">
                            <button onClick={() => updateMutation.mutate({ id: d.id, ...editForm })} className="p-1.5 text-teal-600 hover:bg-teal-50 rounded transition-colors" title="Save">
                              <Check size={14} />
                            </button>
                            <button onClick={() => setEditingDocId(null)} className="p-1.5 text-slate-400 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded transition-colors" title="Cancel">
                              <X size={14} />
                            </button>
                          </div>
                        </td>
                      </>
                    ) : (
                      <>
                        <td className="px-4 py-3 font-semibold text-slate-900 dark:text-slate-100"><div className="flex items-center gap-2"><FileText size={14} className="text-slate-400 dark:text-slate-400"/> {d.title}</div></td>
                        <td className="px-4 py-3 text-slate-500 dark:text-slate-400 capitalize">{d.category}</td>
                        <td className="px-4 py-3 text-slate-500 dark:text-slate-400">{Math.round((d.file_size_bytes || 0) / 1024)} KB</td>
                        <td className="px-4 py-3 text-slate-500 dark:text-slate-400">{fmtDate(d.uploaded_at || null)}</td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex items-center justify-end gap-2">
                            <a href={`/api/v1/documents/${d.id}/download`} target="_blank" rel="noreferrer" className="p-1.5 text-slate-400 dark:text-slate-400 hover:text-teal-600 hover:bg-teal-50 rounded transition-colors" title="Download">
                              <Download size={14} />
                            </a>
                            <button onClick={() => { setEditingDocId(d.id); setEditForm({ title: d.title, category: d.category }); }} className="p-1.5 text-slate-400 dark:text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors" title="Edit">
                              <Edit2 size={14} />
                            </button>
                            <button onClick={() => { if(confirm('Are you sure you want to delete this document?')) archiveMutation.mutate(d.id); }} className="p-1.5 text-slate-400 dark:text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded transition-colors" title="Delete">
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}

// ── Activity Tab ─────────────────────────────────────────────────────────

function ActivityTab({ companyId }: { companyId: string }) {
  const { data: activities, isLoading } = useQuery({
    queryKey: ['company-activity', companyId],
    queryFn: () => api.getCompanyActivity(companyId),
    enabled: !!companyId,
  });

  if (isLoading) return <div className="space-y-3">{[1, 2, 3, 4].map((i) => <SkeletonBlock key={i} className="h-14" />)}</div>;
  if (!activities || activities.length === 0) return <div className="py-16 text-center text-sm text-slate-400 dark:text-slate-400">No activity recorded yet.</div>;

  return (
    <SectionCard title="Activity Timeline" subtitle={`${activities.length} events`}>
      <div className="relative pl-5">
        <div className="absolute left-[9px] top-2 bottom-2 w-px bg-slate-200 dark:bg-slate-700" />
        <div className="space-y-5">
          {activities.map((act: ActivityLog) => (
            <div key={act.id} className="flex items-start gap-4 relative">
              <div className="w-5 h-5 rounded-full bg-white dark:bg-slate-900/50 border-2 border-slate-200 dark:border-slate-800 flex items-center justify-center shrink-0 z-10 -ml-5">
                <div className="w-1.5 h-1.5 rounded-full bg-teal-500" />
              </div>
              <div className="min-w-0 flex-1 pt-0.5 pb-1">
                <div className="text-sm text-slate-700 dark:text-slate-200 font-medium">{act.description}</div>
                <div className="text-xs text-slate-400 dark:text-slate-400 mt-0.5">{act.source} · {fmtDateTime(act.created_at)}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </SectionCard>
  );
}

// ── Settings Tab ─────────────────────────────────────────────────────────

function SettingsTab({ company }: { company: CompanyDetail }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    company_name:    company.company_name    || '',
    legal_name:      company.legal_name      || '',
    phone:           company.phone           || '',
    email:           company.email           || '',
    address:         company.address         || '',
    pan_vat_number:  company.pan_vat_number  || '',
    customer_type:   company.customer_type   || '',
    status:          company.status          || 'active',
    notes:           company.notes           || '',
  });

  const mutation = useMutation({
    mutationFn: (data: Record<string, unknown>) => api.updateCompany(company.id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['company-detail', company.id] });
      queryClient.invalidateQueries({ queryKey: ['companies'] });
    },
  });

  const handleSubmit = () => {
    const changes: Record<string, unknown> = {};
    Object.entries(form).forEach(([k, v]) => { if (v !== ((company as any)[k] || '')) changes[k] = v; });
    if (Object.keys(changes).length > 0) mutation.mutate(changes);
  };

  const fieldCls = 'w-full h-9 px-3 bg-white dark:bg-slate-900/50 border border-slate-200 dark:border-slate-800 rounded-lg text-xs text-slate-800 dark:text-slate-200 focus:ring-2 focus:ring-teal-500/20 focus:border-teal-400 transition-all outline-none';

  return (
    <div className="max-w-xl space-y-6">
      <SectionCard title="Company Settings" subtitle="Edit core company details">
        <div className="space-y-4">
          {[
            { key: 'company_name',   label: 'Company Name',   type: 'text'  },
            { key: 'legal_name',     label: 'Legal Name',     type: 'text'  },
            { key: 'email',          label: 'Email',          type: 'email' },
            { key: 'phone',          label: 'Phone',          type: 'tel'   },
            { key: 'pan_vat_number', label: 'PAN / VAT',      type: 'text'  },
            { key: 'customer_type',  label: 'Customer Type',  type: 'text'  },
          ].map((f) => (
            <div key={f.key}>
              <label className="text-[10px] font-bold text-slate-400 dark:text-slate-400 uppercase tracking-widest mb-1.5 block">{f.label}</label>
              <input type={f.type} value={(form as any)[f.key]}
                onChange={(e) => setForm((s) => ({ ...s, [f.key]: e.target.value }))}
                className={fieldCls} />
            </div>
          ))}

          <div>
            <label className="text-[10px] font-bold text-slate-400 dark:text-slate-400 uppercase tracking-widest mb-1.5 block">Address</label>
            <textarea value={form.address} onChange={(e) => setForm((s) => ({ ...s, address: e.target.value }))} rows={3}
              className="w-full px-3 py-2 bg-white dark:bg-slate-900/50 border border-slate-200 dark:border-slate-800 rounded-lg text-xs text-slate-800 dark:text-slate-200 focus:ring-2 focus:ring-teal-500/20 focus:border-teal-400 transition-all outline-none resize-none" />
          </div>

          <div>
            <label className="text-[10px] font-bold text-slate-400 dark:text-slate-400 uppercase tracking-widest mb-1.5 block">Status</label>
            <select value={form.status} onChange={(e) => setForm((s) => ({ ...s, status: e.target.value }))}
              className={`${fieldCls} cursor-pointer`}>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
              <option value="provisional">Provisional</option>
            </select>
          </div>

          <div>
            <label className="text-[10px] font-bold text-slate-400 dark:text-slate-400 uppercase tracking-widest mb-1.5 block">Notes</label>
            <textarea value={form.notes} onChange={(e) => setForm((s) => ({ ...s, notes: e.target.value }))} rows={4}
              placeholder="Internal notes…"
              className="w-full px-3 py-2 bg-white dark:bg-slate-900/50 border border-slate-200 dark:border-slate-800 rounded-lg text-xs text-slate-800 dark:text-slate-200 placeholder:text-slate-400 dark:text-slate-400 focus:ring-2 focus:ring-teal-500/20 focus:border-teal-400 transition-all outline-none resize-none" />
          </div>
        </div>
      </SectionCard>

      <div className="flex items-center gap-3">
        <button onClick={handleSubmit} disabled={mutation.isPending}
          className="h-9 px-4 bg-teal-700 hover:bg-teal-800 text-white rounded-xl text-xs font-bold transition-colors flex items-center gap-1.5 disabled:opacity-50">
          {mutation.isPending ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
          {mutation.isPending ? 'Saving…' : 'Save Changes'}
        </button>
        {mutation.isSuccess && (
          <span className="text-xs text-emerald-600 font-semibold flex items-center gap-1">
            <CheckCircle2 size={14} /> Saved
          </span>
        )}
      </div>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────

const TAB_IDS = TABS.map(t => t.id);

export default function Customer360() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  // location.key === 'default' means this entry has no real predecessor in history (a fresh
  // page load / new tab / direct link) — anything else means we arrived via an in-app link
  // click, so go back to wherever that actually was (Rankings, Alerts, Search, ...) instead
  // of always dumping the user onto the Customer Directory regardless of where they came from.
  const goBack = () => {
    if (location.key !== 'default') navigate(-1);
    else navigate('/app/customers');
  };
  const [urlParams, setUrlParams] = useSearchParams();
  const [activeTab, setActiveTabState] = useState(() => {
    const tab = urlParams.get('tab');
    return tab && TAB_IDS.includes(tab) ? tab : 'overview';
  });
  // Keep the active tab in the URL so reload / back-forward / sharing a link land on the same tab.
  const setActiveTab = (tab: string) => {
    setActiveTabState(tab);
    setUrlParams(prev => {
      const next = new URLSearchParams(prev);
      next.set('tab', tab);
      return next;
    }, { replace: true });
  };
  const [exportingPdf, setExportingPdf] = useState(false);

  const { data: company, isLoading } = useQuery({
    queryKey: ['company-detail', id],
    queryFn: () => api.getCompany(id!),
    enabled: !!id,
  });

  const handleExportDossier = async () => {
    if (!company || exportingPdf) return;
    setExportingPdf(true);
    try {
      await api.downloadCompanyDossier(company.id, company.company_name);
    } catch {
      alert('Failed to generate the dossier PDF. Please try again.');
    } finally {
      setExportingPdf(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex-1 overflow-auto p-8">
        <div className="max-w-5xl mx-auto space-y-4">
          <SkeletonBlock className="h-20" />
          <SkeletonBlock className="h-10" />
          <SkeletonBlock className="h-64" />
        </div>
      </div>
    );
  }

  if (!company) {
    return (
      <div className="flex-1 overflow-auto p-8">
        <div className="max-w-5xl mx-auto py-16 text-center text-sm text-slate-400 dark:text-slate-400">Company not found.</div>
      </div>
    );
  }

  const inact = company.inactivity_status || 'active';

  return (
    <div className="flex-1 overflow-hidden flex flex-col bg-background">

      {/* Page Header */}
      <div className="shrink-0 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800">
        <div className="px-8 pt-6 pb-0">
          <div className="flex items-center gap-3 mb-5">
            <button onClick={goBack} aria-label="Back to Customer Directory" title="Back to Customer Directory"
              className="h-8 w-8 rounded-lg border border-slate-200 dark:border-slate-700 flex items-center justify-center text-slate-400 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-all">
              <ArrowLeft size={15} />
            </button>
            <div className="min-w-0 flex-1">
              <button onClick={goBack} className="text-[11px] font-medium text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 transition-colors">
                Customer Directory
              </button>
              <div className="flex items-center gap-2.5 flex-wrap">
                <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100 tracking-tight">{company.company_name}</h1>
                <StatusBadge status={inact} />
                {company.is_provisional && (
                  <span className="text-[9px] font-bold text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded border border-amber-200">PROVISIONAL</span>
                )}
              </div>
              <p className="text-xs text-slate-400 dark:text-slate-400 mt-0.5">
                {company.icris_number ? `ICRIS: ${company.icris_number}` : 'No ICRIS'} · Created {fmtDate(company.created_at)}
              </p>
            </div>
            <button onClick={handleExportDossier} disabled={exportingPdf} className="h-8 px-3 border border-slate-200 dark:border-slate-700 rounded-lg text-xs font-semibold text-slate-500 dark:text-slate-400 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors flex items-center gap-1.5 disabled:opacity-50">
              {exportingPdf ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
              {exportingPdf ? 'Generating…' : 'PDF'}
            </button>
          </div>

          {/* Tabs */}
          <div className="flex gap-0 -mb-px">
            {TABS.map((tab) => {
              const isActive = activeTab === tab.id;
              return (
                <button key={tab.id} onClick={() => setActiveTab(tab.id)}
                  className={`relative px-4 py-2.5 text-sm font-medium flex items-center gap-1.5 transition-colors ${
                    isActive ? 'text-teal-700 dark:text-teal-400 font-semibold' : 'text-slate-400 dark:text-slate-400 hover:text-slate-600 dark:hover:text-slate-300'
                  }`}>
                  <tab.icon size={14} />
                  {tab.label}
                  {isActive && <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-teal-600" />}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Tab Content */}
      <div className="flex-1 overflow-y-auto px-8 py-8">
        <div className="max-w-5xl mx-auto">
          {activeTab === 'overview'  && <OverviewTab  company={company}              />}
          {activeTab === 'analytics' && <AnalyticsTab companyId={company.id}         />}
          {activeTab === 'shipments' && <ShipmentsTab companyId={company.id}         />}
          {activeTab === 'call-logs' && <CallLogsTab  companyId={company.id}         />}
          {activeTab === 'documents' && <DocumentsTab companyId={company.id}         />}
          {activeTab === 'activity'  && <ActivityTab  companyId={company.id}         />}
          {activeTab === 'settings'  && <SettingsTab  company={company}              />}
        </div>
      </div>
    </div>
  );
}
