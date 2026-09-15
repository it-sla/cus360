import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type CompanyConflict, type DataQualityIssue } from '../api';
import {
  CheckCircle2, ChevronDown, ChevronUp, Combine, ArrowRight, ArrowUpRight, AlertTriangle, ShieldCheck,
  ShieldAlert, Search, X, EyeOff, Inbox, Building2, Package, RefreshCw, Filter, Layers, ExternalLink,
  History, ListChecks
} from 'lucide-react';
import * as Dialog from '@radix-ui/react-dialog';

const PAGE_SIZE = 50;

/** Human labels + what each machine issue_type actually means, so the inbox is readable
 *  without going and reading crm_sync.py.
 *
 *  crm_invalid_icris and crm_blank_icris both go through the same accounts→CRM billing
 *  buffer (icris_buffer_days) — they self-resolve within that window, and need a manual
 *  CRM correction once they're past it. crm_icris_not_in_master is a different situation
 *  entirely (well-formed ICRIS, just not in the customer master yet) and lives in its own
 *  "Pending Master List" tab rather than this buffer. Everything else here is
 *  informational noise, tucked behind "Show other issue types". */
const ISSUE_META: Record<string, { label: string; hint: string; selfResolves?: boolean }> = {
  crm_invalid_icris:            { label: 'ICRIS Number Mismatch',    hint: "This ICRIS doesn't match any customer record. Self-resolves if corrected in the CRM within the accounting buffer; needs a manual fix once it's stuck." },
  crm_blank_icris:              { label: 'Blank ICRIS',              hint: 'Manifest row had no ICRIS at all. Self-resolves automatically once the CRM fills it in during the accounting buffer.' },
  crm_icris_not_in_master:      { label: 'Not In Customer Master',   hint: 'ICRIS is well-formed but matches no company in the master list — a provisional record was created. Resolves when the company master import promotes it.' },
  crm_customer_name_mismatch:   { label: 'Customer Name Mismatch',   hint: 'CRM shipper name differs from the linked company name. Usually harmless spelling drift; informational only.' },
  crm_manifest_total_mismatch:  { label: 'Manifest Total Mismatch',  hint: 'Manifest footer totals disagree with the sum of its shipment rows — pieces or weight.' },
  crm_missing_pay_term:         { label: 'Missing Pay Term',         hint: 'Row had no Pay Term. It is inferred at sync time (PP when billed, FC otherwise) but flagged for visibility.' },
  crm_missing_bill_type:        { label: 'Missing Doc/Non-Doc Type', hint: "Row had no Bill Type, so it can't be classified as Document or Non-Document — counted in the 'unclassified' bucket on document-type analytics until corrected." },
  crm_manifest_unavailable:     { label: 'Manifest Unavailable',     hint: 'The CRM did not return the manifest when the sync worker asked for it.' },
  company_master_name_conflict: { label: 'Company Name Conflict',    hint: 'The company-master import carried a different name for an existing ICRIS.' },
  temporary_database_failure:   { label: 'Database Failure',         hint: 'A sync operation hit a transient database error and was retried.' },
};

const ICRIS_BUFFER_TYPES = ['crm_invalid_icris', 'crm_blank_icris'];
const RESOLVED_BY_LABEL: Record<string, string> = { crm_sync: 'CRM Sync (auto)', company_master_import: 'Company Master Import (auto)' };
const resolvedByLabel = (v: string | null) => v ? (RESOLVED_BY_LABEL[v] || v) : '—';

const meta = (t: string) => ISSUE_META[t] || { label: t.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()), hint: '' };

const STATUS_STYLES: Record<string, string> = {
  open:     'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-900/20 dark:text-rose-400 dark:border-rose-800/50',
  reviewed: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/20 dark:text-amber-400 dark:border-amber-800/50',
  resolved: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/20 dark:text-emerald-400 dark:border-emerald-800/50',
  ignored:  'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700',
};

const CONFIDENCE_STYLES: Record<string, string> = {
  high:   'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/20 dark:text-emerald-400 dark:border-emerald-800/50',
  medium: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/20 dark:text-amber-400 dark:border-amber-800/50',
  low:    'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-900/20 dark:text-rose-400 dark:border-rose-800/50',
};

const MATCH_REASON_LABEL: Record<string, string> = {
  exact_name: 'Identical name',
  prefix: 'Name prefix only',
  fuzzy: 'Similar name',
};

const fmtNum = (n: number | null | undefined) => (n ?? 0).toLocaleString();
const fmtDateTime = (d: string | null) =>
  d ? new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';

function Badge({ className, children }: { className: string; children: React.ReactNode }) {
  return <span className={`inline-block px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wide border ${className}`}>{children}</span>;
}

/** Compact, readable description of an issue. Every producer writes a different details_json
 *  shape, so this maps each known issue_type onto the fields it actually stores rather than
 *  dumping raw `key: value` pairs at the reviewer. */
function issueDetail(issue: DataQualityIssue): string {
  const d = issue.details_json || {};
  switch (issue.issue_type) {
    case 'crm_customer_name_mismatch':
      return d.official_name
        ? `Manifest says "${issue.source_company_name || '—'}" · record says "${d.official_name}"`
        : 'Manifest name differs from the linked company record';
    case 'crm_manifest_total_mismatch': {
      const parts: string[] = [];
      const m: string[] = Array.isArray(d.mismatches) ? d.mismatches : [];
      if (m.includes('pieces')) parts.push(`pieces ${d.manifest_pieces_total} → rows ${d.shipment_pieces_total}`);
      if (m.includes('weight')) parts.push(`weight ${d.manifest_weight_total} → rows ${d.shipment_actual_weight_total}`);
      return parts.length ? `Footer vs rows: ${parts.join(' · ')}` : 'Manifest totals disagree with its rows';
    }
    case 'crm_missing_pay_term':
      return `${d.tracking_number ? `AWB ${d.tracking_number} — ` : ''}blank Pay Term, inferred ${d.inferred_pay_term || '?'}${d.bill_amount ? ` (bill ${d.bill_amount})` : ''}`;
    case 'company_master_name_conflict': {
      const names = Array.isArray(d.distinct_names) ? d.distinct_names : [];
      return names.length
        ? `Import carried ${names.length} different names: ${names.map((n: string) => `"${n}"`).join(' vs ')}`
        : 'Import carried a conflicting company name';
    }
    case 'crm_manifest_unavailable':
    case 'temporary_database_failure':
      return `${d.summary || 'Operation failed'}${d.attempt ? ` (attempt ${d.attempt})` : ''}`;
    default:
      if (d.reason) return String(d.reason);
      const entries = Object.entries(d).filter(([k]) => k !== 'resolution_reason');
      return entries.length ? entries.map(([k, v]) => `${k}: ${v}`).join(' · ') : '—';
  }
}

// ── Issues tab ────────────────────────────────────────────────────────────

// Defaults the Issues tab to just these two — the same scope as the priority banner.
// Everything else (name drift, pay term inference) is informational noise, tucked
// behind "Other issue types" until someone explicitly asks for it. crm_icris_not_in_master
// lives in its own "Pending Master List" tab, not here.
const DEFAULT_ISSUE_TYPES = ICRIS_BUFFER_TYPES.join(',');

function IssuesTab() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [filters, setFilters] = useState<{ issue_type: string; status: string; severity: string; q: string; icris_buffer_state: '' | 'pending' | 'stuck'; sort: '' | 'revenue' }>(
    { issue_type: DEFAULT_ISSUE_TYPES, status: 'open', severity: '', q: '', icris_buffer_state: '', sort: '' }
  );
  const [showOtherTypes, setShowOtherTypes] = useState(false);
  const [page, setPage] = useState(0);
  const [debouncedQ, setDebouncedQ] = useState('');
  const [bulkTarget, setBulkTarget] = useState<{ status: string; label: string } | null>(null);
  const [fixTarget, setFixTarget] = useState<DataQualityIssue | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(filters.q), 350);
    return () => clearTimeout(t);
  }, [filters.q]);

  useEffect(() => { setPage(0); }, [filters.issue_type, filters.status, filters.severity, filters.icris_buffer_state, filters.sort, debouncedQ]);

  const { data: summary, isLoading: summaryLoading } = useQuery({
    queryKey: ['dq-summary'],
    queryFn: () => api.getDataQualitySummary(),
  });

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['dq-issues', filters.issue_type, filters.status, filters.severity, filters.icris_buffer_state, filters.sort, debouncedQ, page],
    queryFn: () => api.getDataQualityIssues({
      issue_type: filters.issue_type || undefined,
      status: filters.status || undefined,
      severity: filters.severity || undefined,
      q: debouncedQ || undefined,
      icris_buffer_state: filters.icris_buffer_state || undefined,
      sort: filters.sort || undefined,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    }),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['dq-issues'] });
    queryClient.invalidateQueries({ queryKey: ['dq-summary'] });
  };

  const patchOne = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => api.patchDataQualityIssue(id, status),
    onSuccess: invalidate,
  });

  const bulkPatch = useMutation({
    mutationFn: (status: string) => api.bulkPatchDataQualityIssues({
      status,
      issue_type: filters.issue_type || undefined,
      severity: filters.severity || undefined,
      current_status: filters.status || undefined,
    }),
    onSuccess: () => { invalidate(); setBulkTarget(null); },
  });

  const items = data?.items || [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const byType = summary?.by_type || [];
  const otherRows = byType.filter(r => !ICRIS_BUFFER_TYPES.includes(r.issue_type));
  const otherOpenTotal = otherRows.reduce((n, r) => n + r.open_count, 0);
  const bufferDays = summary?.icris_buffer_days ?? 30;
  const stuckIcris = summary?.icris_buffer_age.find(r => r.state === 'stuck');
  const isViewingStuck = filters.icris_buffer_state === 'stuck';
  const fmt$ = (v: number) => `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  const viewStuckIcris = () => {
    setFilters(f => ({ ...f, issue_type: DEFAULT_ISSUE_TYPES, status: 'open', icris_buffer_state: 'stuck', sort: 'revenue' }));
    setShowOtherTypes(false);
  };

  return (
    <div className="space-y-5">
      {/* Priority KPI — ICRIS Number Mismatch + Blank ICRIS, unified under one 30-day
          accounting buffer. Most self-resolves once accounts bills it and a later CRM sync
          fills in the real ICRIS; this card is specifically the slice that's past that
          window and holding real revenue out of every customer-facing report until
          someone corrects it in the CRM. */}
      <button
        onClick={viewStuckIcris}
        className={`w-full text-left bg-white dark:bg-slate-900 border rounded-xl p-4 shadow-sm flex flex-col sm:flex-row sm:items-center gap-4 transition-colors ${
          isViewingStuck ? 'border-rose-400 dark:border-rose-600 ring-1 ring-rose-300/50' : 'border-slate-200 dark:border-slate-800 hover:border-rose-300 dark:hover:border-rose-700'
        }`}
      >
        <div className="w-11 h-11 rounded-full bg-rose-50 dark:bg-rose-900/20 border border-rose-200 dark:border-rose-800/50 flex items-center justify-center shrink-0">
          <ShieldAlert size={20} className="text-rose-600 dark:text-rose-400" />
        </div>
        <div className="flex-1">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-2xl font-black text-slate-900 dark:text-white tracking-tight">
              {summaryLoading ? '—' : fmtNum(stuckIcris?.open_count ?? 0)}
            </span>
            <span className="text-sm font-bold text-slate-700 dark:text-slate-200">ICRIS Issues — Stuck &gt;{bufferDays} Days</span>
            {!!stuckIcris && <Badge className="bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-900/20 dark:text-rose-400 dark:border-rose-800/50">{fmt$(stuckIcris.revenue_at_risk)} at risk</Badge>}
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            ICRIS Number Mismatch and Blank ICRIS both normally self-resolve within accounting's {bufferDays}-day billing buffer, once a later CRM sync fills in
            the real ICRIS. Past that window it isn't self-resolving — needs a manual correction in the CRM.
          </p>
        </div>
        <div className="text-xs font-bold text-rose-600 dark:text-rose-400 shrink-0 flex items-center gap-1">
          {isViewingStuck ? 'Viewing' : 'View sorted by revenue'} <ArrowUpRight size={13} />
        </div>
      </button>

      {/* Everything else — collapsed by default, since it's either self-resolving (blank ICRIS
          gets relinked automatically on a later sync) or informational noise (spelling drift,
          inferred pay terms). Surfacing 80k+ of it above the one real problem defeats the page. */}
      <button
        onClick={() => setShowOtherTypes(v => !v)}
        className="w-full flex items-center justify-between px-4 py-2.5 bg-slate-50 dark:bg-slate-900/50 border border-slate-200 dark:border-slate-800 rounded-xl text-xs font-semibold text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800/50 transition-colors"
      >
        <span className="flex items-center gap-2">
          <Layers size={13} />
          Other issue types ({fmtNum(otherOpenTotal)} open — self-resolving or informational, not urgent)
        </span>
        {showOtherTypes ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>

      {showOtherTypes && (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center gap-2">
            <Layers size={14} className="text-slate-400" />
            <h3 className="text-xs font-bold text-slate-900 dark:text-slate-100 uppercase tracking-wider">Issues by Type</h3>
            <span className="text-[11px] text-slate-400">click a row to filter the list below</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-800">
                <tr className="text-[10px] uppercase font-bold tracking-wider text-slate-500 dark:text-slate-400">
                  <th className="px-4 py-2">Type</th>
                  <th className="px-4 py-2 text-right">Open</th>
                  <th className="px-4 py-2 text-right">Resolved</th>
                  <th className="px-4 py-2 text-right">Ignored</th>
                  <th className="px-4 py-2 text-right">Customers</th>
                  <th className="px-4 py-2">Last Seen</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/50">
                {otherRows.map(row => {
                  const m = meta(row.issue_type);
                  const active = filters.issue_type === row.issue_type;
                  return (
                    <tr
                      key={row.issue_type}
                      onClick={() => setFilters(f => ({ ...f, issue_type: active ? DEFAULT_ISSUE_TYPES : row.issue_type }))}
                      className="cursor-pointer"
                    >
                      <td className={`px-4 py-2.5 ${active ? 'border-l-2 border-indigo-500' : 'border-l-2 border-transparent'}`}>
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-slate-800 dark:text-slate-200">{m.label}</span>
                          {m.selfResolves && <Badge className="bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/20 dark:text-emerald-400 dark:border-emerald-800/50">self-resolves</Badge>}
                          {active && <span className="text-[9px] font-bold text-indigo-600 dark:text-indigo-400 uppercase tracking-wide">Filtering</span>}
                        </div>
                        {m.hint && <div className="text-[11px] text-slate-400 dark:text-slate-500 mt-0.5 max-w-xl">{m.hint}</div>}
                      </td>
                      <td className="px-4 py-2.5 text-right font-bold text-slate-900 dark:text-slate-100">{fmtNum(row.open_count)}</td>
                      <td className="px-4 py-2.5 text-right text-emerald-600 dark:text-emerald-400">{fmtNum(row.resolved_count)}</td>
                      <td className="px-4 py-2.5 text-right text-slate-500 dark:text-slate-400">{fmtNum(row.ignored_count)}</td>
                      <td className="px-4 py-2.5 text-right text-slate-600 dark:text-slate-300">{fmtNum(row.affected_companies)}</td>
                      <td className="px-4 py-2.5 text-slate-500 dark:text-slate-400 whitespace-nowrap">{fmtDateTime(row.last_seen_at)}</td>
                    </tr>
                  );
                })}
                {!summaryLoading && otherRows.length === 0 && (
                  <tr><td colSpan={6} className="px-4 py-8 text-center text-slate-400">No other issues recorded.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Toolbar — filters and bulk actions share one flat strip so the table below reads
          as the page's one real focal surface, not one box among several equal-weight boxes. */}
      <div className="flex flex-col lg:flex-row lg:items-center gap-3 py-1">
        <div className="flex flex-1 flex-wrap items-center gap-2">
          <div className="relative w-full sm:w-56">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={filters.q}
              onChange={e => setFilters(f => ({ ...f, q: e.target.value }))}
              placeholder="Search customer or ICRIS…"
              className="w-full h-9 pl-9 pr-8 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg text-xs font-semibold text-slate-800 dark:text-slate-200 outline-none focus:border-indigo-400"
            />
            {filters.q && (
              <button onClick={() => setFilters(f => ({ ...f, q: '' }))} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400">
                <X size={14} />
              </button>
            )}
          </div>
          <select
            value={filters.issue_type}
            onChange={e => setFilters(f => ({ ...f, issue_type: e.target.value }))}
            className="h-9 px-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg text-xs font-semibold text-slate-700 dark:text-slate-200 outline-none cursor-pointer"
          >
            <option value={DEFAULT_ISSUE_TYPES}>Blank ICRIS + Mismatch</option>
            <option value="crm_blank_icris">Blank ICRIS only</option>
            <option value="crm_invalid_icris">ICRIS Number Mismatch only</option>
            <option value="crm_missing_pay_term">Missing Pay Term only</option>
            <option value="crm_missing_bill_type">Missing Doc/Non-Doc Type only</option>
          </select>
          <select
            value={filters.status}
            onChange={e => setFilters(f => ({ ...f, status: e.target.value }))}
            className="h-9 px-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg text-xs font-semibold text-slate-700 dark:text-slate-200 outline-none cursor-pointer"
          >
            <option value="open">Open</option>
            <option value="reviewed">Reviewed</option>
            <option value="resolved">Resolved</option>
            <option value="ignored">Ignored</option>
            <option value="">All Statuses</option>
          </select>
          <select
            value={filters.severity}
            onChange={e => setFilters(f => ({ ...f, severity: e.target.value }))}
            className="h-9 px-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg text-xs font-semibold text-slate-700 dark:text-slate-200 outline-none cursor-pointer"
          >
            <option value="">All Severities</option>
            <option value="error">Errors</option>
            <option value="warning">Warnings</option>
          </select>
          <button
            onClick={() => setFilters(f => ({ ...f, sort: f.sort === 'revenue' ? '' : 'revenue' }))}
            title="Sort by revenue at risk"
            className={`h-9 px-3 rounded-lg text-xs font-semibold flex items-center gap-1.5 border transition-colors ${
              filters.sort === 'revenue'
                ? 'bg-amber-50 border-amber-300 text-amber-700 dark:bg-amber-900/20 dark:border-amber-700 dark:text-amber-400'
                : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800/50'
            }`}
          >
            <ArrowUpRight size={13} /> Revenue at risk
          </button>
          {(filters.issue_type !== DEFAULT_ISSUE_TYPES || filters.severity || filters.q || filters.status !== 'open' || filters.icris_buffer_state || filters.sort) && (
            <button
              onClick={() => setFilters({ issue_type: DEFAULT_ISSUE_TYPES, status: 'open', severity: '', q: '', icris_buffer_state: '', sort: '' })}
              className="text-xs font-semibold text-rose-500 px-1"
            >
              Clear
            </button>
          )}
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <div className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
            <Filter size={13} className="text-slate-400" />
            <span className="font-bold text-slate-700 dark:text-slate-200">{fmtNum(total)}</span> matching
            {filters.issue_type && filters.issue_type !== DEFAULT_ISSUE_TYPES && <Badge className="bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-900/20 dark:text-indigo-300 dark:border-indigo-800/50">{meta(filters.issue_type).label}</Badge>}
          </div>
          {total > 0 && filters.status !== 'resolved' && filters.status !== 'ignored' && (
            <div className="flex items-center gap-2">
              <button
                onClick={() => setBulkTarget({ status: 'resolved', label: 'Resolve' })}
                className="px-3 py-1.5 bg-emerald-600 text-white rounded-lg text-xs font-bold flex items-center gap-1.5 transition-colors hover:bg-emerald-700"
              >
                <CheckCircle2 size={13} /> Resolve All
              </button>
              <button
                onClick={() => setBulkTarget({ status: 'ignored', label: 'Ignore' })}
                className="px-3 py-1.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-200 rounded-lg text-xs font-bold flex items-center gap-1.5 hover:bg-slate-50 dark:hover:bg-slate-800/50"
              >
                <EyeOff size={13} /> Ignore All
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Issue list */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-800">
              <tr className="text-[10px] uppercase font-bold tracking-wider text-slate-500 dark:text-slate-400">
                <th className="px-4 py-2">Issue</th>
                <th className="px-4 py-2">Customer</th>
                <th className="px-4 py-2">Detail</th>
                <th className="px-4 py-2 text-right">Revenue at Risk</th>
                <th className="px-4 py-2">Last Seen</th>
                <th className="px-4 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/50">
              {isLoading ? (
                [...Array(6)].map((_, i) => (
                  <tr key={i} className="animate-pulse">
                    <td className="px-4 py-3"><div className="h-4 bg-slate-100 dark:bg-slate-800 rounded w-40" /></td>
                    <td className="px-4 py-3"><div className="h-4 bg-slate-100 dark:bg-slate-800 rounded w-36" /></td>
                    <td className="px-4 py-3"><div className="h-4 bg-slate-100 dark:bg-slate-800 rounded w-56" /></td>
                    <td className="px-4 py-3"><div className="h-4 bg-slate-100 dark:bg-slate-800 rounded w-20 ml-auto" /></td>
                    <td className="px-4 py-3"><div className="h-4 bg-slate-100 dark:bg-slate-800 rounded w-28" /></td>
                    <td className="px-4 py-3" />
                  </tr>
                ))
              ) : items.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-16 text-center">
                    <CheckCircle2 size={32} className="mx-auto text-emerald-500 mb-3" />
                    <p className="text-sm font-bold text-slate-700 dark:text-slate-200">Nothing here</p>
                    <p className="text-xs text-slate-400 mt-1">No issues match the current filters.</p>
                  </td>
                </tr>
              ) : items.map(issue => {
                const sourceHref = issue.shipment_id
                  ? `/app/awb?shipment=${issue.shipment_id}`
                  : issue.mawb_id
                  ? `/app/mawb?mawb=${issue.mawb_id}`
                  : null;
                return (
                <tr
                  key={issue.id}
                  onClick={() => sourceHref && navigate(sourceHref)}
                  className={`transition-colors ${sourceHref ? 'cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/40' : ''}`}
                >
                  <td className="px-4 py-3">
                    <div className="font-bold text-slate-800 dark:text-slate-200">{meta(issue.issue_type).label}</div>
                    <div className="mt-1 flex items-center gap-1.5 flex-wrap">
                      <Badge className={STATUS_STYLES[issue.status] || STATUS_STYLES.open}>{issue.status}</Badge>
                      {issue.severity === 'error' && <Badge className="bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-900/20 dark:text-rose-400 dark:border-rose-800/50">error</Badge>}
                      {issue.icris_buffer_state === 'stuck' && <Badge className="bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/20 dark:text-amber-400 dark:border-amber-800/50">stuck &gt;{bufferDays}d</Badge>}
                      {issue.icris_buffer_state === 'pending' && <Badge className="bg-slate-100 text-slate-500 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700">pending</Badge>}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="text-slate-800 dark:text-slate-200 font-medium truncate max-w-[190px]" title={issue.source_company_name || ''}>
                      {issue.source_company_name || <span className="text-slate-400 italic">Not supplied</span>}
                    </div>
                    {issue.source_icris_number && (
                      <div className="font-mono text-[10px] text-slate-500 dark:text-slate-400 mt-0.5">
                        {issue.issue_type === 'crm_invalid_icris' && <span className="text-rose-500 dark:text-rose-400 not-italic font-sans font-bold uppercase tracking-wide mr-1">bad value:</span>}
                        {issue.source_icris_number}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-slate-600 dark:text-slate-300 max-w-[320px]">
                    <span className="line-clamp-2">{issueDetail(issue)}</span>
                    {sourceHref && (
                      <span className="inline-flex items-center gap-1 mt-1 text-[10px] font-bold uppercase tracking-wide text-primary">
                        <ExternalLink size={10} /> View source {issue.shipment_id ? 'shipment' : 'manifest'}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right font-bold text-slate-900 dark:text-slate-100 whitespace-nowrap">
                    {issue.revenue_at_risk > 0 ? fmt$(issue.revenue_at_risk) : <span className="text-slate-300 dark:text-slate-600 font-normal">—</span>}
                  </td>
                  <td className="px-4 py-3 text-slate-500 dark:text-slate-400 whitespace-nowrap">{fmtDateTime(issue.last_seen_at)}</td>
                  <td className="px-4 py-3 text-right whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                    {issue.status === 'open' || issue.status === 'reviewed' ? (
                      <div className="flex items-center justify-end gap-1.5">
                        {issue.issue_type !== 'crm_manual_link_preserved' && (
                          <button
                            onClick={() => setFixTarget(issue)}
                            className="px-2 py-1 rounded border border-indigo-200 dark:border-indigo-800/50 text-indigo-700 dark:text-indigo-400 font-bold text-[10px] uppercase tracking-wide"
                          >
                            Fix
                          </button>
                        )}
                        <button
                          onClick={() => patchOne.mutate({ id: issue.id, status: 'resolved' })}
                          disabled={patchOne.isPending}
                          className="px-2 py-1 rounded border border-emerald-200 dark:border-emerald-800/50 text-emerald-700 dark:text-emerald-400 font-bold text-[10px] uppercase tracking-wide disabled:opacity-40"
                        >
                          Resolve
                        </button>
                        <button
                          onClick={() => patchOne.mutate({ id: issue.id, status: 'ignored' })}
                          disabled={patchOne.isPending}
                          className="px-2 py-1 rounded border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 font-bold text-[10px] uppercase tracking-wide disabled:opacity-40"
                        >
                          Ignore
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => patchOne.mutate({ id: issue.id, status: 'open' })}
                        disabled={patchOne.isPending}
                        className="px-2 py-1 rounded border border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 font-bold text-[10px] uppercase tracking-wide disabled:opacity-40"
                      >
                        Reopen
                      </button>
                    )}
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {totalPages > 1 && (
          <div className="px-4 py-3 bg-slate-50 dark:bg-slate-800/50 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between text-xs font-medium text-slate-600 dark:text-slate-300">
            <span>
              Showing <strong>{page * PAGE_SIZE + 1}</strong>–<strong>{Math.min((page + 1) * PAGE_SIZE, total)}</strong> of <strong>{fmtNum(total)}</strong>
              {isFetching && <RefreshCw size={11} className="inline ml-2 animate-spin text-slate-400" />}
            </span>
            <div className="flex items-center gap-2">
              <button disabled={page === 0} onClick={() => setPage(p => Math.max(0, p - 1))}
                className="px-3 py-1 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md font-semibold disabled:opacity-40">Previous</button>
              <span className="px-2 font-bold text-slate-800 dark:text-slate-200">Page {page + 1} of {fmtNum(totalPages)}</span>
              <button disabled={page + 1 >= totalPages} onClick={() => setPage(p => p + 1)}
                className="px-3 py-1 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md font-semibold disabled:opacity-40">Next</button>
            </div>
          </div>
        )}
      </div>

      {/* Bulk confirm */}
      <Dialog.Root open={!!bulkTarget} onOpenChange={o => !o && setBulkTarget(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50" />
          <Dialog.Content className="fixed top-[50%] left-[50%] w-[90vw] max-w-[480px] translate-x-[-50%] translate-y-[-50%] rounded-2xl bg-white dark:bg-slate-900 p-6 shadow-2xl z-50 border border-slate-200 dark:border-slate-800 focus:outline-none">
            <Dialog.Title className="text-lg font-bold text-slate-900 dark:text-white mb-2">
              {bulkTarget?.label} {fmtNum(total)} issues?
            </Dialog.Title>
            <Dialog.Description className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
              This applies to <strong>every issue matching the current filters</strong>, not just the page you can see.
            </Dialog.Description>
            <div className="bg-slate-50 dark:bg-slate-950 p-3 rounded-lg mt-4 border border-slate-200 dark:border-slate-800 text-xs space-y-1 text-slate-600 dark:text-slate-400">
              <div><span className="font-semibold text-slate-500">Type:</span> {filters.issue_type && filters.issue_type !== DEFAULT_ISSUE_TYPES ? meta(filters.issue_type).label : 'ICRIS Number Mismatch + Blank ICRIS'}</div>
              <div><span className="font-semibold text-slate-500">Severity:</span> {filters.severity || 'All'}</div>
              <div><span className="font-semibold text-slate-500">Current status:</span> {filters.status || 'All'}</div>
              <div className="pt-1 text-slate-500">Marking an issue resolved does not change any shipment or customer data — it only clears it from this inbox.</div>
            </div>
            <div className="mt-6 flex justify-end gap-3">
              <Dialog.Close asChild>
                <button className="px-4 py-2 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-semibold rounded-lg border border-slate-300 dark:border-slate-700" disabled={bulkPatch.isPending}>Cancel</button>
              </Dialog.Close>
              <button
                onClick={() => bulkTarget && bulkPatch.mutate(bulkTarget.status)}
                disabled={bulkPatch.isPending}
                className="px-4 py-2 bg-indigo-600 text-white font-bold rounded-lg disabled:opacity-50"
              >
                {bulkPatch.isPending ? 'Applying…' : `Yes, ${bulkTarget?.label} All`}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <FixDialog issue={fixTarget} onClose={() => setFixTarget(null)} onFixed={invalidate} />
    </div>
  );
}

/** Company search box shared by the assign-company and merge-target fix flows.
 *  350ms debounce mirrors the issue-list search above. */
function CompanyPicker({ value, onChange }: { value: { id: string; company_name: string } | null; onChange: (c: { id: string; company_name: string } | null) => void }) {
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  useEffect(() => { const t = setTimeout(() => setDebouncedQ(q), 350); return () => clearTimeout(t); }, [q]);
  const { data } = useQuery({
    queryKey: ['company-picker', debouncedQ],
    queryFn: () => api.getCompanies({ q: debouncedQ, status: 'official', limit: 8 }),
    enabled: debouncedQ.length >= 2 && !value,
  });
  if (value) {
    return (
      <div className="flex items-center justify-between px-3 py-2 bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-200 dark:border-indigo-800/50 rounded-lg text-xs">
        <span className="font-bold text-indigo-800 dark:text-indigo-300">{value.company_name}</span>
        <button onClick={() => onChange(null)} className="text-indigo-500"><X size={13} /></button>
      </div>
    );
  }
  return (
    <div className="relative">
      <input
        autoFocus
        value={q}
        onChange={e => setQ(e.target.value)}
        placeholder="Search company name or ICRIS…"
        className="w-full h-9 px-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg text-xs font-semibold outline-none focus:border-indigo-400"
      />
      {data && data.items.length > 0 && (
        <div className="absolute z-10 mt-1 w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg shadow-lg max-h-48 overflow-y-auto">
          {data.items.map(c => (
            <button
              key={c.company_id}
              onClick={() => onChange({ id: c.company_id, company_name: c.company_name })}
              className="w-full text-left px-3 py-2 text-xs hover:bg-slate-50 dark:hover:bg-slate-800 border-b border-slate-100 dark:border-slate-800 last:border-0"
            >
              <div className="font-bold text-slate-800 dark:text-slate-200">{c.company_name}</div>
              <div className="font-mono text-[10px] text-slate-500">{c.icris_number}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The per-row "Fix" modal. Form shape depends on issue_type; every action it can submit
 *  maps 1:1 onto backend/app/main.py's /data-quality/issues/{id}/fix dispatch, so this is
 *  the only place that needs to know what each issue_type's real remediation looks like. */
function FixDialog({ issue, onClose, onFixed }: { issue: DataQualityIssue | null; onClose: () => void; onFixed: () => void }) {
  const [company, setCompany] = useState<{ id: string; company_name: string } | null>(null);
  const [newIcris, setNewIcris] = useState('');
  const [newName, setNewName] = useState('');
  const [creatingNew, setCreatingNew] = useState(false);
  const [fieldValue, setFieldValue] = useState('');
  const [nameChoice, setNameChoice] = useState<'alias' | 'rename'>('alias');
  const [renameValue, setRenameValue] = useState('');

  useEffect(() => {
    if (issue) {
      setCompany(null); setNewIcris(''); setNewName(''); setCreatingNew(false);
      setFieldValue(''); setNameChoice('alias'); setRenameValue(issue.details_json?.official_name || '');
    }
  }, [issue]);

  const fix = useMutation({
    mutationFn: (body: Parameters<typeof api.fixDataQualityIssue>[1]) => api.fixDataQualityIssue(issue!.id, body),
    onSuccess: () => { onFixed(); onClose(); },
  });
  const createAndAssign = useMutation({
    mutationFn: async () => {
      const created = await api.createCompany({ icris_number: newIcris.trim(), company_name: newName.trim() });
      return api.fixDataQualityIssue(issue!.id, { action: 'assign_company', company_id: created.id });
    },
    onSuccess: () => { onFixed(); onClose(); },
  });

  if (!issue) return null;
  const t = issue.issue_type;
  const pending = fix.isPending || createAndAssign.isPending;
  const field = issue.details_json?.field || (t === 'crm_missing_pay_term' ? 'pay_term' : t === 'crm_missing_bill_type' ? 'bill_type' : '');

  let body: React.ReactNode;
  let canSubmit = false;
  let submit = () => {};

  if (t === 'crm_blank_icris' || t === 'crm_invalid_icris') {
    canSubmit = creatingNew ? !!(newIcris.trim() && newName.trim()) : !!company;
    submit = () => creatingNew ? createAndAssign.mutate() : fix.mutate({ action: 'assign_company', company_id: company!.id });
    body = (
      <div className="space-y-3">
        <p className="text-xs text-slate-500 dark:text-slate-400">Link this shipment to the correct customer. The link is manual, so future CRM syncs will never overwrite it.</p>
        {!creatingNew ? (
          <>
            <CompanyPicker value={company} onChange={setCompany} />
            <button onClick={() => setCreatingNew(true)} className="text-[11px] font-bold text-indigo-600 dark:text-indigo-400">+ Create new company instead</button>
          </>
        ) : (
          <>
            <input value={newIcris} onChange={e => setNewIcris(e.target.value)} placeholder="ICRIS number" className="w-full h-9 px-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg text-xs font-semibold outline-none focus:border-indigo-400" />
            <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Company name" className="w-full h-9 px-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg text-xs font-semibold outline-none focus:border-indigo-400" />
            <button onClick={() => setCreatingNew(false)} className="text-[11px] font-bold text-slate-500">← Search existing companies instead</button>
          </>
        )}
      </div>
    );
  } else if (t === 'crm_missing_bill_type') {
    canSubmit = !!fieldValue;
    submit = () => fix.mutate({ action: 'set_field', field, value: fieldValue });
    body = (
      <div className="space-y-3">
        <p className="text-xs text-slate-500 dark:text-slate-400">Classify this shipment as Document or Non-Document. It's marked as manually overridden, so CRM sync won't replace it.</p>
        <select value={fieldValue} onChange={e => setFieldValue(e.target.value)} className="w-full h-9 px-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg text-xs font-semibold outline-none focus:border-indigo-400 cursor-pointer">
          <option value="">Select Bill Type…</option>
          <option value="Document">Document</option>
          <option value="Non-Doc">Non-Doc</option>
          <option value="Letter">Letter</option>
        </select>
      </div>
    );
  } else if (t === 'crm_numeric_parse_error' || t === 'crm_missing_pay_term') {
    canSubmit = !!fieldValue.trim();
    submit = () => fix.mutate({ action: 'set_field', field, value: fieldValue.trim() });
    body = (
      <div className="space-y-3">
        <p className="text-xs text-slate-500 dark:text-slate-400">Enter the correct value for <strong>{field}</strong>. It's marked as manually overridden, so CRM sync won't replace it.</p>
        <input value={fieldValue} onChange={e => setFieldValue(e.target.value)} placeholder={`Correct ${field}`} className="w-full h-9 px-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg text-xs font-semibold outline-none focus:border-indigo-400" />
      </div>
    );
  } else if (t === 'crm_customer_name_mismatch' || t === 'company_master_name_conflict') {
    const canRename = nameChoice === 'rename' || t === 'company_master_name_conflict';
    canSubmit = canRename ? !!renameValue.trim() : true;
    submit = () => canRename
      ? fix.mutate({ action: 'rename_company', company_name: renameValue.trim() })
      : fix.mutate({ action: 'save_alias' });
    body = (
      <div className="space-y-3">
        {t === 'crm_customer_name_mismatch' && (
          <div className="flex gap-4 text-xs font-semibold text-slate-700 dark:text-slate-200">
            <label className="flex items-center gap-1.5"><input type="radio" checked={nameChoice === 'alias'} onChange={() => setNameChoice('alias')} /> Save CRM name as an alias</label>
            <label className="flex items-center gap-1.5"><input type="radio" checked={nameChoice === 'rename'} onChange={() => setNameChoice('rename')} /> Rename the official company</label>
          </div>
        )}
        {canRename && (
          <input value={renameValue} onChange={e => setRenameValue(e.target.value)} placeholder="Official company name" className="w-full h-9 px-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg text-xs font-semibold outline-none focus:border-indigo-400" />
        )}
      </div>
    );
  } else if (t === 'crm_icris_not_in_master') {
    canSubmit = !!company;
    submit = () => fix.mutate({ action: 'merge', target_id: company!.id });
    body = (
      <div className="space-y-3">
        <p className="text-xs text-slate-500 dark:text-slate-400">Fold this provisional company into the official one it actually belongs to. This permanently merges its shipments and documents in and deletes the provisional record.</p>
        <CompanyPicker value={company} onChange={setCompany} />
      </div>
    );
  } else {
    canSubmit = true;
    submit = () => fix.mutate({ action: 'acknowledge' });
    body = <p className="text-xs text-slate-500 dark:text-slate-400">No automatic remediation exists for this issue type yet — acknowledging just clears it from the inbox, same as Resolve.</p>;
  }

  return (
    <Dialog.Root open={!!issue} onOpenChange={o => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50" />
        <Dialog.Content className="fixed top-[50%] left-[50%] w-[90vw] max-w-[480px] translate-x-[-50%] translate-y-[-50%] rounded-2xl bg-white dark:bg-slate-900 p-6 shadow-2xl z-50 border border-slate-200 dark:border-slate-800 focus:outline-none">
          <Dialog.Title className="text-lg font-bold text-slate-900 dark:text-white mb-1">Fix: {meta(t).label}</Dialog.Title>
          <Dialog.Description className="text-xs text-slate-500 dark:text-slate-400 mb-4">{issue.source_company_name || issue.source_icris_number || (issue.details_json?.tracking_number ? `AWB ${issue.details_json.tracking_number}` : 'Untitled')}</Dialog.Description>
          {body}
          <div className="mt-6 flex justify-end gap-3">
            <Dialog.Close asChild>
              <button className="px-4 py-2 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-semibold rounded-lg border border-slate-300 dark:border-slate-700" disabled={pending}>Cancel</button>
            </Dialog.Close>
            <button onClick={submit} disabled={!canSubmit || pending} className="px-4 py-2 bg-indigo-600 text-white font-bold rounded-lg disabled:opacity-50">
              {pending ? 'Applying…' : 'Apply Fix'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ── Merge candidates tab ──────────────────────────────────────────────────

// M-2: source_id alone is NOT unique across conflict rows -- the same provisional
// company can appear as a candidate for more than one target. Keying selection/expand
// state on source_id made checking one row silently toggle every row sharing it. Every
// selection/expand/React-key use below must key on the full (source_id, target_id) pair.
const conflictKey = (c: CompanyConflict) => `${c.source_id}:${c.target_id}`;

function MergeTab() {
  const queryClient = useQueryClient();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [conflictsToMerge, setConflictsToMerge] = useState<CompanyConflict[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showLowConfidence, setShowLowConfidence] = useState(true);
  const [mergeError, setMergeError] = useState<string | null>(null);

  const { data: allConflicts = [], isLoading } = useQuery({
    queryKey: ['company-conflicts'],
    queryFn: () => api.getCompanyConflicts(),
  });

  const conflicts = showLowConfidence ? allConflicts : allConflicts.filter(c => c.confidence !== 'low');

  const bulkMergeMutation = useMutation({
    mutationFn: async (items: CompanyConflict[]) => {
      for (const item of items) {
        await api.mergeCompanies(item.source_id, item.target_id);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['company-conflicts'] });
      queryClient.invalidateQueries({ queryKey: ['companies'] });
      queryClient.invalidateQueries({ queryKey: ['dq-summary'] });
      // Same gap as NotInMasterTab's merge mutation: a cached ['search', ...] result from
      // before the merge can still show the now-archived source company.
      queryClient.invalidateQueries({ queryKey: ['search'] });
      setIsDialogOpen(false);
      setConflictsToMerge([]);
      setSelectedIds(new Set());
    },
    // Without this, a failed merge (network error, permission error, a company already
    // merged elsewhere) left the dialog sitting open with the "Yes, Merge" button back to
    // its normal state and nothing telling the admin it didn't actually go through.
    onError: (err: any) => setMergeError(err?.response?.data?.detail || 'Merge failed -- nothing was changed. Check your connection and try again.'),
  });

  const toggleSelect = (id: string, checked: boolean) => {
    const next = new Set(selectedIds);
    if (checked) next.add(id); else next.delete(id);
    setSelectedIds(next);
  };

  const lowInSelection = conflictsToMerge.filter(c => c.confidence === 'low').length;

  if (isLoading) return <div className="text-center p-12 text-slate-400 text-sm">Loading merge candidates…</div>;

  if (allConflicts.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center p-12 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm">
        <div className="w-16 h-16 bg-emerald-100 dark:bg-emerald-900/30 text-emerald-500 rounded-full flex items-center justify-center mb-4">
          <CheckCircle2 size={32} />
        </div>
        <h2 className="text-xl font-bold text-slate-900 dark:text-white">No merge candidates</h2>
        <p className="text-slate-500 mt-2 text-sm">No provisional company resembles an existing official record.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="bg-amber-50 dark:bg-amber-900/10 border border-amber-200 dark:border-amber-800/40 rounded-xl p-3.5 flex gap-3">
        <AlertTriangle size={16} className="text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
        <div className="text-xs text-amber-800 dark:text-amber-300 leading-relaxed">
          <strong>Merging archives the provisional record.</strong> Its shipments, documents and history move to
          the master record and its name is kept as an alias — except any shipment already manually linked to it, which stays
          put rather than moving. Only <em>Identical name</em> matches are safe to accept without reading both names —
          everything else is a suggestion.
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-xs font-semibold text-slate-700 dark:text-slate-300 cursor-pointer">
            <input
              type="checkbox"
              checked={selectedIds.size === conflicts.length && conflicts.length > 0}
              onChange={e => setSelectedIds(e.target.checked ? new Set(conflicts.map(conflictKey)) : new Set())}
              className="w-4 h-4 rounded border-slate-300 text-indigo-600 cursor-pointer"
            />
            Select all shown
          </label>
          <label className="flex items-center gap-2 text-xs font-medium text-slate-500 dark:text-slate-400 cursor-pointer">
            <input type="checkbox" checked={showLowConfidence} onChange={e => setShowLowConfidence(e.target.checked)}
              className="w-3.5 h-3.5 rounded border-slate-300 text-indigo-600 cursor-pointer" />
            Show low-confidence ({allConflicts.filter(c => c.confidence === 'low').length})
          </label>
        </div>
        {selectedIds.size > 0 && (
          <button
            onClick={() => { setMergeError(null); setConflictsToMerge(conflicts.filter(c => selectedIds.has(conflictKey(c)))); setIsDialogOpen(true); }}
            className="px-4 py-2 bg-indigo-600 text-white rounded-lg flex items-center gap-2 text-xs font-bold uppercase tracking-wider shadow-sm"
          >
            <Combine size={14} /> Merge Selected ({selectedIds.size})
          </button>
        )}
      </div>

      {conflicts.map(conflict => (
        <div key={conflictKey(conflict)} className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-sm overflow-hidden">
          <div
            onClick={() => setExpandedId(expandedId === conflictKey(conflict) ? null : conflictKey(conflict))}
            className="p-4 sm:p-5 flex flex-col sm:flex-row gap-4 sm:items-center cursor-pointer"
          >
            <div className="flex items-center" onClick={e => e.stopPropagation()}>
              <input
                type="checkbox"
                checked={selectedIds.has(conflictKey(conflict))}
                onChange={e => toggleSelect(conflictKey(conflict), e.target.checked)}
                className="w-4 h-4 rounded border-slate-300 text-indigo-600 cursor-pointer"
              />
            </div>

            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 mb-1 flex-wrap">
                <Badge className={CONFIDENCE_STYLES[conflict.confidence]}>{conflict.confidence} confidence</Badge>
                <Badge className="bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700">
                  {MATCH_REASON_LABEL[conflict.match_reason]} · {Math.round((conflict.score || 0) * 100)}%
                </Badge>
              </div>
              <h3 className="font-bold text-slate-900 dark:text-white text-base truncate">{conflict.source_company_name}</h3>
              <div className="font-mono text-xs text-slate-500 mt-0.5">ICRIS: {conflict.source_icris_number || 'N/A'}</div>
              <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-1 flex items-center gap-3">
                <span className="flex items-center gap-1"><Package size={11} /> {fmtNum(conflict.source_shipment_count)} AWBs</span>
                {conflict.source_document_count > 0 && <span>{conflict.source_document_count} docs</span>}
              </div>
            </div>

            <div className="hidden sm:flex flex-col items-center justify-center px-3 shrink-0">
              <ArrowRight className="text-slate-400" size={18} />
              <span className="text-[10px] uppercase font-bold mt-1 tracking-wider text-slate-500">Merge Into</span>
            </div>

            <div className="flex-1 min-w-0 sm:text-right border-t border-dashed border-slate-200 dark:border-slate-800 sm:border-0 pt-3 sm:pt-0">
              <div className="flex items-center sm:justify-end gap-1.5 mb-1">
                <ShieldCheck size={13} className="text-emerald-500" />
                <Badge className="bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/20 dark:text-emerald-400 dark:border-emerald-800/50">Master Record</Badge>
              </div>
              <h3 className="font-bold text-slate-900 dark:text-white text-base truncate">{conflict.target_company_name}</h3>
              <div className="font-mono text-xs text-slate-500 mt-0.5">ICRIS: {conflict.target_icris_number}</div>
              <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-1 sm:text-right">
                <span className="inline-flex items-center gap-1"><Package size={11} /> {fmtNum(conflict.target_shipment_count)} AWBs</span>
              </div>
            </div>

            <div className="flex items-center justify-between sm:justify-end sm:w-44 gap-2 sm:ml-2 border-t border-slate-200 dark:border-slate-800 sm:border-0 pt-3 sm:pt-0 shrink-0">
              <button
                onClick={e => { e.stopPropagation(); setMergeError(null); setConflictsToMerge([conflict]); setIsDialogOpen(true); }}
                className="flex-1 sm:flex-none px-3 py-2 bg-indigo-600 text-white rounded-lg flex justify-center items-center gap-2 text-xs font-bold uppercase tracking-wider shadow-sm"
              >
                <Combine size={14} /> Merge
              </button>
              <button className="p-1.5 text-slate-400">
                {expandedId === conflictKey(conflict) ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
              </button>
            </div>
          </div>

          {conflict.other_candidates > 0 && (
            <div className="px-5 py-2 bg-rose-50 dark:bg-rose-900/10 border-t border-rose-200 dark:border-rose-800/40 flex items-center gap-2">
              <AlertTriangle size={13} className="text-rose-600 dark:text-rose-400 shrink-0" />
              <span className="text-[11px] font-semibold text-rose-700 dark:text-rose-400">
                Ambiguous — {conflict.other_candidates} other {conflict.other_candidates === 1 ? 'company' : 'companies'} match this name equally well. The target shown is only the best-scoring guess; verify before merging.
              </span>
            </div>
          )}

          {expandedId === conflictKey(conflict) && (
            <div className="px-5 pb-5 pt-4 border-t border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50 grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <h4 className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">Provisional Record</h4>
                <div className="text-xs text-slate-700 dark:text-slate-300 space-y-1">
                  <p><span className="text-slate-500">ID:</span> <span className="font-mono">{conflict.source_id}</span></p>
                  <p><span className="text-slate-500">First seen:</span> {fmtDateTime(conflict.source_created_at)}</p>
                  <p><span className="text-slate-500">Match basis:</span> {MATCH_REASON_LABEL[conflict.match_reason]} ({Math.round((conflict.score || 0) * 100)}% name similarity)</p>
                </div>
              </div>
              <div>
                <h4 className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">Impact If Merged</h4>
                <ul className="text-xs text-slate-700 dark:text-slate-300 space-y-1">
                  <li>{fmtNum(conflict.source_shipment_count)} air waybills reassigned to {conflict.target_company_name}</li>
                  <li>{fmtNum(conflict.source_document_count)} documents reassigned</li>
                  <li>&ldquo;{conflict.source_company_name}&rdquo; kept as an alias on the master record</li>
                  <li className="text-amber-600 dark:text-amber-400 font-semibold">Provisional record {conflict.source_icris_number} archived (not deleted)</li>
                </ul>
              </div>
            </div>
          )}
        </div>
      ))}

      <Dialog.Root open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50" />
          <Dialog.Content className="fixed top-[50%] left-[50%] max-h-[85vh] overflow-y-auto w-[90vw] max-w-[520px] translate-x-[-50%] translate-y-[-50%] rounded-2xl bg-white dark:bg-slate-900 p-6 shadow-2xl z-50 border border-slate-200 dark:border-slate-800 focus:outline-none">
            <div className="flex items-center gap-3 text-rose-600 mb-4">
              <div className="p-2 bg-rose-100 dark:bg-rose-900/30 rounded-full"><AlertTriangle size={22} /></div>
              <Dialog.Title className="text-lg font-bold text-slate-900 dark:text-white">Confirm Company Merge</Dialog.Title>
            </div>

            <Dialog.Description className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
              {conflictsToMerge.length === 1 ? (
                <>Merge <strong className="text-slate-900 dark:text-white">{conflictsToMerge[0]?.source_company_name}</strong> into{' '}
                  <strong className="text-slate-900 dark:text-white">{conflictsToMerge[0]?.target_company_name}</strong>.</>
              ) : (
                <>Merge <strong className="text-slate-900 dark:text-white">{conflictsToMerge.length} provisional records</strong> into their best-scoring master records.</>
              )}
            </Dialog.Description>

            {lowInSelection > 0 && (
              <div className="mt-3 p-3 rounded-lg bg-rose-50 dark:bg-rose-900/10 border border-rose-200 dark:border-rose-800/40 text-xs text-rose-700 dark:text-rose-400">
                <strong>{lowInSelection} of these {lowInSelection === 1 ? 'is' : 'are'} low-confidence</strong> — matched on a partial or fuzzy
                name, or the source matches several companies. These are frequently distinct businesses, not typos.
              </div>
            )}

            <div className="bg-slate-50 dark:bg-slate-950 p-4 rounded-lg mt-4 border border-slate-200 dark:border-slate-800">
              <h4 className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">What happens</h4>
              <ul className="text-xs text-slate-600 dark:text-slate-400 space-y-1.5">
                <li className="flex gap-2"><CheckCircle2 size={14} className="text-emerald-500 shrink-0 mt-0.5" />
                  {fmtNum(conflictsToMerge.reduce((n, c) => n + c.source_shipment_count, 0))} air waybills reassigned to the master record.</li>
                <li className="flex gap-2"><CheckCircle2 size={14} className="text-emerald-500 shrink-0 mt-0.5" />
                  Provisional names kept as aliases so future CRM rows still match.</li>
                <li className="flex gap-2"><AlertTriangle size={14} className="text-rose-500 shrink-0 mt-0.5" />
                  The provisional records are <strong>archived</strong>, not deleted. Any shipment manually linked to one stays put rather than moving to the master record.</li>
              </ul>
            </div>

            {mergeError && (
              <div className="mt-4 p-3 rounded-lg bg-rose-50 dark:bg-rose-900/10 border border-rose-200 dark:border-rose-800/40 text-xs text-rose-700 dark:text-rose-400">
                <strong>Merge failed:</strong> {mergeError}
              </div>
            )}

            <div className="mt-6 flex justify-end gap-3">
              <Dialog.Close asChild>
                <button className="px-4 py-2 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-semibold rounded-lg border border-slate-300 dark:border-slate-700" disabled={bulkMergeMutation.isPending}>Cancel</button>
              </Dialog.Close>
              <button
                onClick={() => conflictsToMerge.length > 0 && bulkMergeMutation.mutate(conflictsToMerge)}
                disabled={bulkMergeMutation.isPending}
                className="px-4 py-2 bg-rose-600 text-white font-bold rounded-lg disabled:opacity-50"
              >
                {bulkMergeMutation.isPending ? 'Merging…' : 'Yes, Merge'}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

// ── Pending Master List tab ─────────────────────────────────────────────────
// Sourced directly from companies.is_provisional, NOT the crm_icris_not_in_master issue
// log: most provisional companies never got an issue row (customer_clean_list import never
// writes one; most crm_scrape ones predate that call), so the issue log undercounts badly —
// this tab used to show ~3 rows when 261 companies were actually pending. is_provisional is
// promoted/cleared by company_imports.py and is the only reliable source of truth here.

function NotInMasterTab() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [page, setPage] = useState(0);
  // A merge always targets one official company; mergeSources holds one or many provisional
  // companies being folded into it -- the single "Merge" button on a row and the multi-select
  // "Merge Selected" bar both just populate this the same way and share one dialog/mutation.
  const [mergeSources, setMergeSources] = useState<{ id: string; name: string }[] | null>(null);
  const [mergeTarget, setMergeTarget] = useState<{ id: string; company_name: string } | null>(null);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Map<string, string>>(new Map());

  useEffect(() => { const t = setTimeout(() => setDebouncedQ(q), 350); return () => clearTimeout(t); }, [q]);
  useEffect(() => { setPage(0); }, [debouncedQ]);
  // Selection is scoped to the current page's rows -- once the page or search changes, the
  // checked ids no longer correspond to visible rows, so drop them rather than carry along a
  // hidden selection the user can't see or review before merging.
  useEffect(() => { setSelected(new Map()); }, [debouncedQ, page]);

  const { data, isLoading } = useQuery({
    queryKey: ['dq-not-in-master', debouncedQ, page],
    queryFn: () => api.getCompanies({ status: 'provisional', q: debouncedQ || undefined, limit: PAGE_SIZE, offset: page * PAGE_SIZE }),
  });

  const merge = useMutation({
    mutationFn: async () => {
      // Sequential, not Promise.all: these are independent writes against the same target
      // company row, and merge_companies isn't designed for concurrent callers reassigning
      // shipments onto it at once.
      for (const source of mergeSources!) await api.mergeCompanies(source.id, mergeTarget!.id);
    },
    onSettled: () => {
      // Runs even on partial failure (source 2 of 3 failed) so the list reflects whichever
      // merges actually went through instead of silently hiding them until next reload.
      queryClient.invalidateQueries({ queryKey: ['dq-not-in-master'] });
      queryClient.invalidateQueries({ queryKey: ['dq-summary'] });
      // The merged-away provisional company can still be sitting in a cached ['search', ...]
      // or ['companies', ...] result from before the merge -- without this, it keeps showing
      // up in Universal Search / the Customer Directory until that cache naturally expires.
      queryClient.invalidateQueries({ queryKey: ['search'] });
      queryClient.invalidateQueries({ queryKey: ['companies'] });
    },
    onSuccess: () => {
      setMergeSources(null); setMergeTarget(null); setSelected(new Map());
    },
    // Same gap as MergeTab's bulkMergeMutation: a failed merge otherwise left the dialog
    // open with no indication anything went wrong.
    onError: (err: any) => setMergeError(err?.response?.data?.detail || 'Merge failed -- some companies may already be merged. Check the list and try again.'),
  });

  const items = data?.items || [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const allOnPageSelected = items.length > 0 && items.every(c => selected.has(c.company_id));
  const toggleSelectAll = () => {
    setSelected(prev => {
      if (allOnPageSelected) return new Map();
      const next = new Map(prev);
      items.forEach(c => next.set(c.company_id, c.company_name));
      return next;
    });
  };
  const toggleSelectOne = (id: string, name: string) => {
    setSelected(prev => {
      const next = new Map(prev);
      if (next.has(id)) next.delete(id); else next.set(id, name);
      return next;
    });
  };

  return (
    <div className="space-y-4">
      <div className="bg-indigo-50 dark:bg-indigo-900/10 border border-indigo-200 dark:border-indigo-800/40 rounded-xl p-3.5 flex gap-3">
        <ListChecks size={16} className="text-indigo-600 dark:text-indigo-400 shrink-0 mt-0.5" />
        <div className="text-xs text-indigo-800 dark:text-indigo-300 leading-relaxed">
          <strong>These aren't errors.</strong> Each row is a well-formed ICRIS that simply isn't in the customer master list yet — a provisional
          company record was already created automatically. This queue resolves itself once you run a company-master import that includes the ICRIS,
          which promotes the record. If a row is actually the same customer as an existing official company under a different ICRIS, use Merge instead
          of waiting on an import.
        </div>
      </div>

      <div className="flex items-center gap-2">
        <div className="relative w-full sm:w-64">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Search company or ICRIS…"
            className="w-full h-9 pl-9 pr-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg text-xs font-semibold text-slate-800 dark:text-slate-200 outline-none focus:border-indigo-400"
          />
        </div>
        <span className="text-xs text-slate-500 dark:text-slate-400"><span className="font-semibold">{fmtNum(total)}</span> provisional companies</span>
        {selected.size > 0 && (
          <button
            onClick={() => { setMergeError(null); setMergeSources(Array.from(selected, ([id, name]) => ({ id, name }))); setMergeTarget(null); }}
            className="ml-auto px-3 py-1.5 rounded-lg bg-indigo-600 text-white font-bold text-xs"
          >
            Merge Selected ({selected.size})
          </button>
        )}
      </div>

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-800">
              <tr className="text-[10px] uppercase font-bold tracking-wider text-slate-500 dark:text-slate-400">
                <th className="px-4 py-2 w-8">
                  <input type="checkbox" checked={allOnPageSelected} onChange={toggleSelectAll} disabled={items.length === 0} className="cursor-pointer" />
                </th>
                <th className="px-4 py-2">Company</th>
                <th className="px-4 py-2">ICRIS</th>
                <th className="px-4 py-2 text-right">Shipments</th>
                <th className="px-4 py-2">Created</th>
                <th className="px-4 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/50">
              {isLoading ? (
                [...Array(4)].map((_, i) => (
                  <tr key={i} className="animate-pulse">
                    <td className="px-4 py-3" />
                    <td className="px-4 py-3"><div className="h-4 bg-slate-100 dark:bg-slate-800 rounded w-40" /></td>
                    <td className="px-4 py-3"><div className="h-4 bg-slate-100 dark:bg-slate-800 rounded w-24" /></td>
                    <td className="px-4 py-3"><div className="h-4 bg-slate-100 dark:bg-slate-800 rounded w-12 ml-auto" /></td>
                    <td className="px-4 py-3"><div className="h-4 bg-slate-100 dark:bg-slate-800 rounded w-28" /></td>
                    <td className="px-4 py-3" />
                  </tr>
                ))
              ) : items.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-16 text-center">
                    <CheckCircle2 size={32} className="mx-auto text-emerald-500 mb-3" />
                    <p className="text-sm font-bold text-slate-700 dark:text-slate-200">Nothing here</p>
                    <p className="text-xs text-slate-400 mt-1">No provisional companies match the current search.</p>
                  </td>
                </tr>
              ) : items.map(c => (
                <tr
                  key={c.company_id}
                  onClick={() => navigate(`/app/customers/${c.company_id}`)}
                  className={`cursor-pointer transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/40 ${selected.has(c.company_id) ? 'bg-indigo-50/60 dark:bg-indigo-900/10' : ''}`}
                >
                  <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                    <input type="checkbox" checked={selected.has(c.company_id)} onChange={() => toggleSelectOne(c.company_id, c.company_name)} className="cursor-pointer" />
                  </td>
                  <td className="px-4 py-3">
                    <div className="text-slate-800 dark:text-slate-200 font-medium">{c.company_name}</div>
                    <Badge className="mt-1 bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/20 dark:text-amber-400 dark:border-amber-800/50">provisional</Badge>
                  </td>
                  <td className="px-4 py-3 font-mono text-slate-600 dark:text-slate-300">{c.icris_number || '—'}</td>
                  <td className="px-4 py-3 text-right text-slate-700 dark:text-slate-300">{fmtNum(c.shipment_count)}</td>
                  <td className="px-4 py-3 text-slate-500 dark:text-slate-400 whitespace-nowrap">{fmtDateTime(c.crm_last_synced_at)}</td>
                  <td className="px-4 py-3 text-right whitespace-nowrap" onClick={e => e.stopPropagation()}>
                    <button
                      onClick={() => { setMergeError(null); setMergeSources([{ id: c.company_id, name: c.company_name }]); setMergeTarget(null); }}
                      className="px-2 py-1 rounded border border-indigo-200 dark:border-indigo-800/50 text-indigo-700 dark:text-indigo-400 font-bold text-[10px] uppercase tracking-wide"
                    >
                      Merge
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {totalPages > 1 && (
          <div className="px-4 py-3 bg-slate-50 dark:bg-slate-800/50 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between text-xs font-medium text-slate-600 dark:text-slate-300">
            <span>Showing <strong>{page * PAGE_SIZE + 1}</strong>–<strong>{Math.min((page + 1) * PAGE_SIZE, total)}</strong> of <strong>{fmtNum(total)}</strong></span>
            <div className="flex items-center gap-2">
              <button disabled={page === 0} onClick={() => setPage(p => Math.max(0, p - 1))}
                className="px-3 py-1 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md font-semibold disabled:opacity-40">Previous</button>
              <span className="px-2 font-bold text-slate-800 dark:text-slate-200">Page {page + 1} of {fmtNum(totalPages)}</span>
              <button disabled={page + 1 >= totalPages} onClick={() => setPage(p => p + 1)}
                className="px-3 py-1 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md font-semibold disabled:opacity-40">Next</button>
            </div>
          </div>
        )}
      </div>

      <Dialog.Root open={!!mergeSources} onOpenChange={o => !o && setMergeSources(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50" />
          <Dialog.Content className="fixed top-[50%] left-[50%] w-[90vw] max-w-[480px] translate-x-[-50%] translate-y-[-50%] rounded-2xl bg-white dark:bg-slate-900 p-6 shadow-2xl z-50 border border-slate-200 dark:border-slate-800 focus:outline-none">
            <Dialog.Title className="text-lg font-bold text-slate-900 dark:text-white mb-1">
              {mergeSources && mergeSources.length === 1 ? `Merge ${mergeSources[0].name}` : `Merge ${mergeSources?.length ?? 0} companies`}
            </Dialog.Title>
            <Dialog.Description className="text-xs text-slate-500 dark:text-slate-400 mb-3">
              Pick the official company {mergeSources && mergeSources.length === 1 ? 'this provisional record actually belongs to' : 'these provisional records actually belong to'}. This moves {mergeSources && mergeSources.length === 1 ? 'its' : 'their'} shipments and documents over and archives the provisional {mergeSources && mergeSources.length === 1 ? 'record' : 'records'} (any shipment already manually linked stays put).
            </Dialog.Description>
            {mergeSources && mergeSources.length > 1 && (
              <ul className="mb-3 max-h-28 overflow-y-auto rounded-lg border border-slate-200 dark:border-slate-800 divide-y divide-slate-100 dark:divide-slate-800 text-xs text-slate-700 dark:text-slate-300">
                {mergeSources.map(s => <li key={s.id} className="px-3 py-1.5">{s.name}</li>)}
              </ul>
            )}
            <CompanyPicker value={mergeTarget} onChange={setMergeTarget} />
            {mergeError && (
              <div className="mt-3 p-3 rounded-lg bg-rose-50 dark:bg-rose-900/10 border border-rose-200 dark:border-rose-800/40 text-xs text-rose-700 dark:text-rose-400">
                <strong>Merge failed:</strong> {mergeError}
              </div>
            )}
            <div className="mt-6 flex justify-end gap-3">
              <Dialog.Close asChild>
                <button className="px-4 py-2 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-semibold rounded-lg border border-slate-300 dark:border-slate-700" disabled={merge.isPending}>Cancel</button>
              </Dialog.Close>
              <button onClick={() => merge.mutate()} disabled={!mergeTarget || merge.isPending} className="px-4 py-2 bg-indigo-600 text-white font-bold rounded-lg disabled:opacity-50">
                {merge.isPending ? 'Merging…' : mergeSources && mergeSources.length > 1 ? `Merge ${mergeSources.length}` : 'Merge'}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

// ── Resolution Log tab ──────────────────────────────────────────────────────
// Before/after view of resolved issues, so it's visible which ones CRM sync (or a
// company-master import) actually fixed on its own vs. which were closed by a human.

function ResolutionLogTab() {
  const [issueType, setIssueType] = useState('');
  const [resolvedBy, setResolvedBy] = useState('');
  const [days, setDays] = useState(30);
  const [page, setPage] = useState(0);

  useEffect(() => { setPage(0); }, [issueType, resolvedBy, days]);

  const { data, isLoading } = useQuery({
    queryKey: ['dq-resolution-log', issueType, resolvedBy, days, page],
    queryFn: () => api.getDataQualityResolutionLog({
      issue_type: issueType || undefined,
      resolved_by: resolvedBy || undefined,
      days,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    }),
  });

  const items = data?.items || [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const autoCount = items.filter(i => i.resolved_by === 'crm_sync' || i.resolved_by === 'company_master_import').length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <select value={days} onChange={e => setDays(Number(e.target.value))}
          className="h-9 px-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg text-xs font-semibold text-slate-700 dark:text-slate-200 outline-none cursor-pointer">
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
          <option value={365}>Last year</option>
        </select>
        <select value={issueType} onChange={e => setIssueType(e.target.value)}
          className="h-9 px-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg text-xs font-semibold text-slate-700 dark:text-slate-200 outline-none cursor-pointer">
          <option value="">All Issue Types</option>
          <option value="crm_invalid_icris">ICRIS Number Mismatch</option>
          <option value="crm_blank_icris">Blank ICRIS</option>
          <option value="crm_icris_not_in_master">Not In Customer Master</option>
        </select>
        <select value={resolvedBy} onChange={e => setResolvedBy(e.target.value)}
          className="h-9 px-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg text-xs font-semibold text-slate-700 dark:text-slate-200 outline-none cursor-pointer">
          <option value="">Resolved By: Anyone</option>
          <option value="crm_sync">CRM Sync (auto)</option>
          <option value="company_master_import">Company Master Import (auto)</option>
        </select>
        <span className="text-xs text-slate-500 dark:text-slate-400 ml-auto">
          <span className="font-semibold">{fmtNum(total)}</span> resolved
          {items.length > 0 && <span className="ml-1.5">· {autoCount}/{items.length} on this page auto-resolved</span>}
        </span>
      </div>

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-800">
              <tr className="text-[10px] uppercase font-bold tracking-wider text-slate-500 dark:text-slate-400">
                <th className="px-4 py-2">Issue</th>
                <th className="px-4 py-2">Before</th>
                <th className="px-4 py-2">After</th>
                <th className="px-4 py-2">Resolved By</th>
                <th className="px-4 py-2 text-right">Time to Resolve</th>
                <th className="px-4 py-2">Resolved</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/50">
              {isLoading ? (
                [...Array(4)].map((_, i) => (
                  <tr key={i} className="animate-pulse">
                    <td className="px-4 py-3"><div className="h-4 bg-slate-100 dark:bg-slate-800 rounded w-32" /></td>
                    <td className="px-4 py-3"><div className="h-4 bg-slate-100 dark:bg-slate-800 rounded w-32" /></td>
                    <td className="px-4 py-3"><div className="h-4 bg-slate-100 dark:bg-slate-800 rounded w-32" /></td>
                    <td className="px-4 py-3"><div className="h-4 bg-slate-100 dark:bg-slate-800 rounded w-24" /></td>
                    <td className="px-4 py-3" />
                    <td className="px-4 py-3" />
                  </tr>
                ))
              ) : items.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-16 text-center">
                    <History size={32} className="mx-auto text-slate-300 mb-3" />
                    <p className="text-sm font-bold text-slate-700 dark:text-slate-200">Nothing resolved in this window</p>
                    <p className="text-xs text-slate-400 mt-1">Try a wider date range.</p>
                  </td>
                </tr>
              ) : items.map(row => {
                const auto = row.resolved_by === 'crm_sync' || row.resolved_by === 'company_master_import';
                return (
                  <tr key={row.id}>
                    <td className="px-4 py-3 font-bold text-slate-800 dark:text-slate-200">{meta(row.issue_type).label}</td>
                    <td className="px-4 py-3 text-slate-500 dark:text-slate-400">
                      <div>{row.before_company_name || <span className="italic text-slate-400">Not supplied</span>}</div>
                      {row.before_icris && <div className="font-mono text-[10px] mt-0.5">{row.before_icris}</div>}
                    </td>
                    <td className="px-4 py-3 text-slate-800 dark:text-slate-200">
                      <div className="flex items-center gap-1.5">
                        {row.after_company_name || <span className="italic text-slate-400">—</span>}
                        {row.after_is_provisional && <Badge className="bg-slate-100 text-slate-500 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700">provisional</Badge>}
                      </div>
                      {row.after_icris && <div className="font-mono text-[10px] text-slate-500 dark:text-slate-400 mt-0.5">{row.after_icris}</div>}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <Badge className={auto
                        ? 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/20 dark:text-emerald-400 dark:border-emerald-800/50'
                        : 'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700'}>
                        {resolvedByLabel(row.resolved_by)}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-right text-slate-600 dark:text-slate-300 whitespace-nowrap">
                      {row.days_to_resolve < 1 ? '< 1 day' : `${Math.round(row.days_to_resolve)}d`}
                    </td>
                    <td className="px-4 py-3 text-slate-500 dark:text-slate-400 whitespace-nowrap">{fmtDateTime(row.resolved_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {totalPages > 1 && (
          <div className="px-4 py-3 bg-slate-50 dark:bg-slate-800/50 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between text-xs font-medium text-slate-600 dark:text-slate-300">
            <span>Showing <strong>{page * PAGE_SIZE + 1}</strong>–<strong>{Math.min((page + 1) * PAGE_SIZE, total)}</strong> of <strong>{fmtNum(total)}</strong></span>
            <div className="flex items-center gap-2">
              <button disabled={page === 0} onClick={() => setPage(p => Math.max(0, p - 1))}
                className="px-3 py-1 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md font-semibold disabled:opacity-40">Previous</button>
              <span className="px-2 font-bold text-slate-800 dark:text-slate-200">Page {page + 1} of {fmtNum(totalPages)}</span>
              <button disabled={page + 1 >= totalPages} onClick={() => setPage(p => p + 1)}
                className="px-3 py-1 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md font-semibold disabled:opacity-40">Next</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────

export default function DataQuality() {
  const [tab, setTab] = useState<'issues' | 'merge' | 'not-in-master' | 'log'>('issues');

  const { data: summary } = useQuery({ queryKey: ['dq-summary'], queryFn: () => api.getDataQualitySummary() });
  const { data: conflicts } = useQuery({ queryKey: ['company-conflicts'], queryFn: () => api.getCompanyConflicts() });

  const TABS = [
    { id: 'issues' as const, label: 'Issues', icon: Inbox, count: summary?.totals.open },
    { id: 'merge' as const, label: 'Merge Candidates', icon: Building2, count: conflicts?.length },
    { id: 'not-in-master' as const, label: 'Pending Master List', icon: ListChecks, count: summary?.icris_not_in_master_open },
    { id: 'log' as const, label: 'History', icon: History, count: undefined },
  ];

  return (
    <div className="flex-1 flex flex-col h-full bg-background overflow-hidden">
      <div className="shrink-0 px-6 pt-6 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
        <h1 className="text-2xl font-bold text-slate-900 dark:text-white tracking-tight">Data Quality</h1>
        <p className="text-sm text-slate-500 font-medium mt-1">
          Sync and import defects, duplicate customer records, and how they got resolved.
        </p>
        <div className="flex gap-0 -mb-px mt-4">
          {TABS.map(t => {
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`relative px-4 py-2.5 text-sm font-medium flex items-center gap-2 transition-colors ${
                  active ? 'text-indigo-600 dark:text-indigo-400 font-semibold' : 'text-slate-400 dark:text-slate-400'
                }`}
              >
                <t.icon size={14} />
                {t.label}
                {t.count !== undefined && (
                  <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-extrabold ${
                    active ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300' : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'
                  }`}>{fmtNum(t.count)}</span>
                )}
                {active && <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-indigo-600" />}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex-1 overflow-auto p-4 sm:p-6">
        <div className="max-w-[1200px] mx-auto">
          {tab === 'issues' && <IssuesTab />}
          {tab === 'merge' && <MergeTab />}
          {tab === 'not-in-master' && <NotInMasterTab />}
          {tab === 'log' && <ResolutionLogTab />}
        </div>
      </div>
    </div>
  );
}
