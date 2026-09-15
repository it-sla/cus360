import { Fragment, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '@/api';
import type { PipelineItem } from '@/api';
import { AlertTriangle, XCircle, Clock, MessageSquare } from 'lucide-react';

function formatMoney(value: number | null) {
  if (value === null || value === undefined) return '—';
  return `$${Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function formatDate(value: string) {
  return new Date(value + 'T00:00:00').toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// "3h ago" / "2d ago" style label — mirrors relativeDate() in app-shell.tsx, but that one
// works off a plain YYYY-MM-DD calendar day; this needs sub-day precision for a staleness
// warning ("last synced 6 hours ago"), so it's its own small function rather than a shared util.
function hoursAgo(iso: string): number {
  return (Date.now() - new Date(iso).getTime()) / 3600000;
}
function relativeSyncTime(iso: string): string {
  const hrs = hoursAgo(iso);
  if (hrs < 1) return 'less than an hour ago';
  if (hrs < 24) return `${Math.round(hrs)}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

// Pipeline syncs run a few times a day (crm_pipeline_schedule_cron). Twice that interval
// with no fresh sync means either the schedule is disabled or it's failing silently —
// worth a visible warning rather than letting stale data pass as current.
const STALE_AFTER_HOURS = 24;

export default function Pipeline() {
  const navigate = useNavigate();
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [lostOnly, setLostOnly] = useState(false);
  const [aeFilter, setAeFilter] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['pipeline', overdueOnly, lostOnly, aeFilter],
    queryFn: () => api.getPipeline({ overdue_only: overdueOnly || undefined, lost_only: lostOnly || undefined, ae_code: aeFilter || undefined }),
    refetchInterval: 60000,
  });

  const items: PipelineItem[] = data?.items ?? [];
  const aeCodes = Array.from(new Set(items.map((i) => i.ae_code).filter(Boolean))) as string[];
  const revenueAtRisk = items.filter((i) => i.is_overdue).reduce((sum, i) => sum + (i.revenue_usd ?? 0), 0);
  const isStale = !!data?.as_of && hoursAgo(data.as_of) > STALE_AFTER_HOURS;

  return (
    <div className="flex-1 overflow-y-auto bg-background p-4 sm:p-6 lg:p-8">
      <div className="max-w-[1600px] mx-auto space-y-6">
        <div className="space-y-4">
          <div>
            <h1 className="text-2xl font-black text-slate-900 dark:text-white tracking-tight">Active Pipeline</h1>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-1 max-w-3xl">
              CRM Active Pipeline, scraped periodically. Rows flag amber once the Expected Date has passed with no Win/Loss recorded, and red once marked Loss — both surface as alerts on the Alerts page too. Tally against actual shipments manually.
              {data?.as_of && <span className="ml-1 whitespace-nowrap">Last synced {new Date(data.as_of).toLocaleString()}.</span>}
            </p>
          </div>

          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              {isStale && data?.as_of && (
                <span className="flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1.5 rounded-full whitespace-nowrap bg-amber-50 border border-amber-200 text-amber-700 dark:bg-amber-950/20 dark:border-amber-900 dark:text-amber-400">
                  <Clock size={12} className="shrink-0" /> Sync stale — {relativeSyncTime(data.as_of)}
                </span>
              )}
              {data && data.overdue_count > 0 && (
                <span className="flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1.5 rounded-full whitespace-nowrap bg-amber-50 border border-amber-200 text-amber-700 dark:bg-amber-950/20 dark:border-amber-900 dark:text-amber-400">
                  <AlertTriangle size={12} className="shrink-0" /> {data.overdue_count} needs follow-up{revenueAtRisk > 0 ? ` · ${formatMoney(revenueAtRisk)} at risk` : ''}
                </span>
              )}
              {data && data.lost_count > 0 && (
                <span className="flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1.5 rounded-full whitespace-nowrap bg-rose-50 border border-rose-200 text-rose-700 dark:bg-rose-950/20 dark:border-rose-900 dark:text-rose-400">
                  <XCircle size={12} className="shrink-0" /> {data.lost_count} lost
                </span>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <select
                value={aeFilter}
                onChange={(e) => setAeFilter(e.target.value)}
                className="h-9 px-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg text-xs font-semibold text-slate-700 dark:text-slate-300 outline-none hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
              >
                <option value="">All AEs</option>
                {aeCodes.map((code) => (
                  <option key={code} value={code}>{code}</option>
                ))}
              </select>
              <div className="flex items-center gap-1 h-9 px-1 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg">
                <button
                  type="button"
                  onClick={() => setOverdueOnly((v) => !v)}
                  className={`h-7 px-2.5 rounded-md text-xs font-semibold whitespace-nowrap transition-colors ${
                    overdueOnly ? 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400' : 'text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800'
                  }`}
                >
                  Needs follow-up
                </button>
                <button
                  type="button"
                  onClick={() => setLostOnly((v) => !v)}
                  className={`h-7 px-2.5 rounded-md text-xs font-semibold whitespace-nowrap transition-colors ${
                    lostOnly ? 'bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-400' : 'text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800'
                  }`}
                >
                  Lost only
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800">
          <table className="w-full text-sm table-fixed">
            <colgroup>
              <col className="w-[14%]" />
              <col className="w-[21%]" />
              <col className="w-[4%]" />
              <col className="w-[8%]" />
              <col className="w-[10%]" />
              <col className="w-[9%]" />
              <col className="w-[10%]" />
              <col className="w-[6%]" />
              <col className="w-[7%]" />
              <col className="w-[5%]" />
              <col className="w-[6%]" />
            </colgroup>
            <thead>
              <tr className="bg-slate-50 dark:bg-slate-900 text-left text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                <th className="px-3 py-2.5 truncate">Expected Date</th>
                <th className="px-3 py-2.5 truncate">Company</th>
                <th className="px-2 py-2.5 text-center" title="Rows with this icon have remarks — click to view">
                  <MessageSquare size={13} className="inline-block" />
                </th>
                <th className="px-3 py-2.5 truncate">ICRIS</th>
                <th className="px-3 py-2.5 truncate">Country</th>
                <th className="px-3 py-2.5 truncate text-right" title="Weight (kg)">Wt (kg)</th>
                <th className="px-3 py-2.5 truncate text-right">Revenue</th>
                <th className="px-3 py-2.5 truncate text-right">Pcs</th>
                <th className="px-3 py-2.5 truncate" title="Category">Cat.</th>
                <th className="px-3 py-2.5 truncate">AE</th>
                <th className="px-3 py-2.5 truncate" title="Win/Loss">W/L</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr><td colSpan={11} className="px-4 py-8 text-center text-slate-400">Loading…</td></tr>
              )}
              {isError && (
                <tr><td colSpan={11} className="px-4 py-8 text-center text-rose-600 dark:text-rose-400 font-semibold">
                  Couldn't load the pipeline — retrying automatically.
                </td></tr>
              )}
              {!isLoading && !isError && items.length === 0 && (
                <tr><td colSpan={11} className="px-4 py-8 text-center text-slate-400">
                  No pipeline rows. Sync happens from the <button onClick={() => navigate('/app/sync')} className="text-primary font-bold hover:underline">CRM Sync page</button>.
                </td></tr>
              )}
              {items.map((item) => {
                const hasRemark = !!item.remarks;
                const isExpanded = expandedId === item.id;
                return (
                  <Fragment key={item.id}>
                    <tr
                      onClick={() => hasRemark && setExpandedId(isExpanded ? null : item.id)}
                      className={`border-t border-slate-100 dark:border-slate-800 ${hasRemark ? 'cursor-pointer' : ''} ${
                        item.is_lost ? 'bg-rose-50/60 dark:bg-rose-950/10' : item.is_overdue ? 'bg-amber-50/60 dark:bg-amber-950/10' : ''
                      }`}
                    >
                      <td className={`px-3 py-2 font-medium whitespace-nowrap ${
                        item.is_lost ? 'text-rose-700 dark:text-rose-400' : item.is_overdue ? 'text-amber-700 dark:text-amber-400' : 'text-slate-700 dark:text-slate-300'
                      }`}>
                        {formatDate(item.expected_date)}
                        {item.is_overdue && <span className="block text-[10px] font-bold uppercase tracking-wide">Follow up</span>}
                      </td>
                      <td className="px-3 py-2 text-slate-900 dark:text-white font-medium break-words">{item.company_name}</td>
                      <td className="px-3 py-2 text-center">
                        {hasRemark && (
                          <span title={isExpanded ? 'Hide remarks' : 'View remarks'} className="inline-flex items-center justify-center w-6 h-6 rounded-md text-slate-400 hover:text-primary hover:bg-slate-100 dark:text-slate-500 dark:hover:text-primary dark:hover:bg-slate-800 transition-colors">
                            <MessageSquare size={14} className={isExpanded ? 'fill-current' : ''} />
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-slate-500 dark:text-slate-400 truncate">{item.icris_number ?? '—'}</td>
                      <td className="px-3 py-2 text-slate-500 dark:text-slate-400 truncate">{item.country ?? '—'}</td>
                      <td className="px-3 py-2 text-right text-slate-700 dark:text-slate-300">{item.weight_kg ?? '—'}</td>
                      <td className="px-3 py-2 text-right text-slate-700 dark:text-slate-300">{formatMoney(item.revenue_usd)}</td>
                      <td className="px-3 py-2 text-right text-slate-700 dark:text-slate-300">{item.pieces ?? '—'}</td>
                      <td className="px-3 py-2 text-slate-500 dark:text-slate-400 truncate">{item.category ?? '—'}</td>
                      <td className="px-3 py-2 text-slate-500 dark:text-slate-400 truncate">{item.ae_code ?? '—'}</td>
                      <td className="px-3 py-2 truncate">
                        {item.is_lost ? (
                          <span className="inline-flex items-center gap-1 text-[11px] font-bold uppercase text-rose-600 dark:text-rose-400">
                            <XCircle size={12} /> {item.win_loss}
                          </span>
                        ) : (
                          <span className="text-slate-500 dark:text-slate-400">{item.win_loss || '—'}</span>
                        )}
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr className="border-t border-slate-100 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/40">
                        <td colSpan={11} className="px-3 py-2 text-xs text-slate-600 dark:text-slate-300">
                          <span className="inline-flex items-center gap-1.5">
                            <MessageSquare size={12} className="shrink-0 text-slate-400 dark:text-slate-500" />
                            <span className="font-semibold text-slate-500 dark:text-slate-400">Remarks:</span>
                            {item.remarks}
                          </span>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
