import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '@/api';
import {
  AlertCircle, ArrowUpRight, ArrowDownRight, UserX, DollarSign, Package, UserPlus,
  RefreshCw, Clock, Search, XCircle, X, Mail, ChevronLeft, ChevronRight,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';

interface Alert {
  id: string;
  category: string;
  type: string;
  severity: string;
  title: string;
  description: string;
  entity_type: string;
  entity_id: string | null;
  entity_name: string | null;
  metric_value: number | null;
  date: string;
  ae_code: string | null;
}

const getIcon = (type: string) => {
  const t = type.toLowerCase();
  if (t.includes('lost')) return <XCircle size={14} />;
  if (t.includes('overdue') || t.includes('follow-up')) return <Clock size={14} />;
  if (t.includes('new')) return <UserPlus size={14} />;
  if (t.includes('dormant') || t.includes('inactive') || t.includes('gap')) return <UserX size={14} />;
  if (t.includes('gainer') || t.includes('spike')) return <ArrowUpRight size={14} />;
  if (t.includes('decliner') || t.includes('drop')) return <ArrowDownRight size={14} />;
  if (t.includes('value')) return <DollarSign size={14} />;
  if (t.includes('heavy') || t.includes('volume')) return <Package size={14} />;
  return <AlertCircle size={14} />;
};

// Status palette — reserved for severity, never reused as a categorical color.
const SEVERITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2, info: 3 };
const SEVERITY_LABEL: Record<string, string> = { high: 'High', medium: 'Medium', low: 'Low', info: 'Info' };
const SEVERITY_DOT: Record<string, string> = { high: 'bg-rose-500', medium: 'bg-amber-500', low: 'bg-slate-400', info: 'bg-blue-500' };
const SEVERITY_TEXT: Record<string, string> = { high: 'text-rose-600 dark:text-rose-400', medium: 'text-amber-600 dark:text-amber-400', low: 'text-slate-500 dark:text-slate-400', info: 'text-blue-600 dark:text-blue-400' };
const SEVERITY_RING: Record<string, string> = { high: 'ring-rose-500/40', medium: 'ring-amber-500/40', low: 'ring-slate-400/40', info: 'ring-blue-500/40' };
const SEVERITY_BAR: Record<string, string> = { high: 'border-l-rose-500', medium: 'border-l-amber-500', low: 'border-l-slate-300 dark:border-l-slate-600', info: 'border-l-blue-500' };

const CATEGORIES = [
  { key: 'Customer', label: 'Customer' },
  { key: 'AE', label: 'AE' },
];

const PAGE_SIZE = 50;

function metricLabel(alert: Alert): string {
  if (alert.metric_value === null || alert.metric_value === undefined) return '—';
  const t = alert.type.toLowerCase();
  const v = alert.metric_value;
  if (t.includes('revenue') || t.includes('value') || t.includes('lost')) return `$${Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  if (t.includes('overdue') || t.includes('follow-up') || t.includes('dormant') || t.includes('inactive') || t.includes('gap')) return `${v}d`;
  if (t.includes('heavy')) return `${v.toLocaleString(undefined, { maximumFractionDigits: 0 })} kg`;
  if (t.includes('dormancy')) return `${v} acct${v === 1 ? '' : 's'}`;
  return v.toLocaleString();
}

export default function Alerts() {
  const navigate = useNavigate();
  const [severityFilter, setSeverityFilter] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<string>('');
  const [aeFilter, setAeFilter] = useState<string>('');
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<'severity' | 'metric'>('severity');
  const [page, setPage] = useState(0);

  const { data, isLoading, dataUpdatedAt, refetch, isFetching } = useQuery({
    queryKey: ['alerts'],
    queryFn: api.getAlerts,
    refetchInterval: 60000,
  });

  const aeListQuery = useQuery({ queryKey: ['accountExecutives'], queryFn: () => api.getAccountExecutives(true) });

  const sendTierEmailsMutation = useMutation({ mutationFn: () => api.sendTierAlertEmails() });

  const allAlerts: Alert[] = data?.alerts || [];
  // SB, RTL, JS excluded from the AE filter dropdown per request — no display name on
  // file for any of them (account_executives.display_name is null), unlike every other
  // AE code here.
  const aeOptions = (aeListQuery.data ?? []).filter((a: any) => !['SB', 'RTL', 'JS'].includes(a.ae_code));

  const aeScoped = useMemo(() => (aeFilter ? allAlerts.filter((a) => a.ae_code === aeFilter) : allAlerts), [allAlerts, aeFilter]);

  const severityCounts = useMemo(() => {
    const counts: Record<string, number> = { high: 0, medium: 0, low: 0, info: 0 };
    for (const a of aeScoped) counts[a.severity] = (counts[a.severity] || 0) + 1;
    return counts;
  }, [aeScoped]);

  const filtered = useMemo(() => {
    let rows = aeScoped;
    if (severityFilter) rows = rows.filter((a) => a.severity === severityFilter);
    if (categoryFilter) rows = rows.filter((a) => a.category === categoryFilter);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      rows = rows.filter((a) => a.title.toLowerCase().includes(q) || a.description.toLowerCase().includes(q) || (a.entity_name || '').toLowerCase().includes(q));
    }
    return [...rows].sort((a, b) => {
      if (sortBy === 'metric') return Math.abs(b.metric_value || 0) - Math.abs(a.metric_value || 0);
      return SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    });
  }, [aeScoped, severityFilter, categoryFilter, search, sortBy]);

  // Any filter/sort change invalidates the current page.
  useEffect(() => { setPage(0); }, [severityFilter, categoryFilter, aeFilter, search, sortBy]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageRows = filtered.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

  const hasFilters = !!(severityFilter || categoryFilter || aeFilter || search);
  const clearFilters = () => { setSeverityFilter(null); setCategoryFilter(''); setAeFilter(''); setSearch(''); };

  const handleClick = (alert: Alert) => {
    if (alert.entity_type === 'company' && alert.entity_id) navigate(`/app/customers/${alert.entity_id}`);
    // An "AE Portfolio Risk / Inactive" alert is a rollup ("22 dormant accounts") — clicking
    // it should surface those accounts right here (scope the AE filter + jump to Customer
    // alerts), not navigate away to AE Performance where none of that list exists.
    else if (alert.entity_type === 'ae' && alert.entity_name) {
      setAeFilter(alert.entity_name);
      setCategoryFilter('Customer');
      setSeverityFilter(null);
    }
    else if (alert.entity_type === 'pipeline') navigate('/app/pipeline');
    else if (alert.entity_type === 'mawb') navigate('/app/mawb');
  };

  return (
    <div className="flex-1 overflow-y-auto bg-background p-4 sm:p-6 lg:p-8">
      <div className="max-w-[1800px] mx-auto space-y-5">

        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-black text-slate-900 dark:text-white tracking-tight">Intelligence Alerts</h1>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
              {dataUpdatedAt ? `Updated ${new Date(dataUpdatedAt).toLocaleTimeString()}` : 'Loading…'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => sendTierEmailsMutation.mutate()}
              disabled={sendTierEmailsMutation.isPending}
              title="Sends the Tier Shipping Gap email digest right now, outside its daily schedule"
              className="h-9 px-3 flex items-center gap-1.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-200 rounded-lg text-xs font-semibold hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50"
            >
              <Mail size={14} className={sendTierEmailsMutation.isPending ? 'animate-pulse' : ''} /> Send Tier Alert Emails
            </button>
            <button
              onClick={() => refetch()}
              className="h-9 px-3 flex items-center gap-1.5 bg-slate-900 text-white dark:bg-white dark:text-slate-900 rounded-lg text-xs font-semibold hover:opacity-90"
            >
              <RefreshCw size={14} className={isFetching ? 'animate-spin' : ''} /> Refresh
            </button>
          </div>
        </div>

        {sendTierEmailsMutation.isSuccess && (
          <div className={`text-xs font-medium rounded-lg px-3 py-2 border ${sendTierEmailsMutation.data.enabled ? 'text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/20 border-emerald-200 dark:border-emerald-900' : 'text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-900'}`}>
            {sendTierEmailsMutation.data.enabled
              ? `Sent: ${sendTierEmailsMutation.data.ae_emails_sent} AE email(s), ${sendTierEmailsMutation.data.admin_emails_sent} admin email(s), covering ${sendTierEmailsMutation.data.total_breaches} overdue account(s).`
              : `Not sent — email sending isn't enabled (TIER_ALERT_EMAIL_ENABLED / SMTP_USERNAME / SMTP_PASSWORD). ${sendTierEmailsMutation.data.total_breaches} account(s) are currently overdue and would be included once enabled.`}
            {sendTierEmailsMutation.data.ae_codes_without_email.length > 0 && (
              <span className="block mt-1 text-slate-500 dark:text-slate-400">
                No email on file for AE code(s): {sendTierEmailsMutation.data.ae_codes_without_email.join(', ')} — their accounts are still covered by the admin digest.
              </span>
            )}
          </div>
        )}
        {sendTierEmailsMutation.isError && (
          <div className="text-xs font-medium text-rose-700 dark:text-rose-400 bg-rose-50 dark:bg-rose-900/20 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
            Could not send tier alert emails.
          </div>
        )}

        {/* Severity summary — doubles as the severity filter, replacing a separate pill row */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {(['high', 'medium', 'low', 'info'] as const).map((sev) => {
            const active = severityFilter === sev;
            return (
              <button
                key={sev}
                onClick={() => setSeverityFilter(active ? null : sev)}
                className={`text-left rounded-xl border bg-white dark:bg-slate-900 px-4 py-3 transition-all ${
                  active
                    ? `border-transparent ring-2 ${SEVERITY_RING[sev]}`
                    : 'border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700'
                }`}
              >
                <div className="flex items-center gap-1.5 mb-1">
                  <span className={`w-2 h-2 rounded-full ${SEVERITY_DOT[sev]}`} />
                  <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">{SEVERITY_LABEL[sev]}</span>
                </div>
                <div className={`text-xl font-black tabular-nums ${SEVERITY_TEXT[sev]}`}>{(severityCounts[sev] || 0).toLocaleString()}</div>
              </button>
            );
          })}
        </div>

        {/* Filter bar — one row: search, then three dropdowns, sort pinned right */}
        <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
          <div className="relative flex-1 min-w-[180px] sm:max-w-xs">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search alerts…"
              className="w-full h-9 pl-8 pr-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg text-xs outline-none focus:ring-2 focus:ring-primary/40"
            />
          </div>
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="h-9 px-2.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg text-xs font-semibold text-slate-600 dark:text-slate-300 outline-none"
          >
            <option value="">All Categories</option>
            {CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>
          <select
            value={aeFilter}
            onChange={(e) => setAeFilter(e.target.value)}
            className="h-9 px-2.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg text-xs font-semibold text-slate-600 dark:text-slate-300 outline-none"
          >
            <option value="">All AEs</option>
            {aeOptions.map((a: any) => (
              <option key={a.ae_code} value={a.ae_code}>{a.display_name ? `${a.display_name} (${a.ae_code})` : a.ae_code}</option>
            ))}
          </select>
          {hasFilters && (
            <button
              onClick={clearFilters}
              className="h-9 px-2.5 rounded-lg text-xs font-semibold flex items-center gap-1 text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
            >
              <X size={12} /> Clear
            </button>
          )}
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as any)}
            className="h-9 px-2.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg text-xs font-semibold text-slate-600 dark:text-slate-300 outline-none sm:ml-auto"
          >
            <option value="severity">Sort: Severity</option>
            <option value="metric">Sort: Impact</option>
          </select>
        </div>

        {/* Alert list */}
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden bg-white dark:bg-slate-900">
          {isLoading && (
            <div className="px-4 py-16 text-center text-sm text-slate-400">Loading alerts…</div>
          )}
          {!isLoading && filtered.length === 0 && (
            <div className="px-4 py-16 text-center text-sm text-slate-400">No alerts match these filters.</div>
          )}
          {!isLoading && pageRows.length > 0 && (
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {pageRows.map((alert) => {
                const clickable = ['company', 'ae', 'pipeline', 'mawb'].includes(alert.entity_type);
                return (
                  <div
                    key={alert.id}
                    onClick={() => clickable && handleClick(alert)}
                    className={`flex items-start gap-3 px-4 py-3 border-l-4 ${SEVERITY_BAR[alert.severity]} ${clickable ? 'cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50' : ''} transition-colors`}
                  >
                    <span className={`mt-0.5 shrink-0 ${SEVERITY_TEXT[alert.severity]}`}>{getIcon(alert.type)}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2 flex-wrap">
                        <span className="font-semibold text-slate-900 dark:text-white text-sm leading-tight">{alert.title}</span>
                        <span className="text-[10px] font-bold uppercase tracking-wide text-slate-400 dark:text-slate-500">{alert.category}</span>
                      </div>
                      <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 truncate">{alert.description}</div>
                    </div>
                    <div className="shrink-0 text-right pl-2">
                      <div className="font-mono text-xs font-semibold text-slate-700 dark:text-slate-300">{metricLabel(alert)}</div>
                      <div className="text-[10px] text-slate-400 dark:text-slate-500 mt-0.5">{alert.ae_code || '—'} · {alert.date}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {!isLoading && filtered.length > 0 && (
            <div className="flex items-center justify-between px-4 py-2.5 border-t border-slate-200 dark:border-slate-800 text-xs text-slate-500 dark:text-slate-400">
              <span>{page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, filtered.length)} of {filtered.length}</span>
              <div className="flex gap-2">
                <button disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))} className="p-1.5 rounded-md border border-slate-200 dark:border-slate-700 disabled:opacity-30 hover:bg-slate-50 dark:hover:bg-slate-800">
                  <ChevronLeft size={14} />
                </button>
                <button disabled={page >= totalPages - 1} onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))} className="p-1.5 rounded-md border border-slate-200 dark:border-slate-700 disabled:opacity-30 hover:bg-slate-50 dark:hover:bg-slate-800">
                  <ChevronRight size={14} />
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
