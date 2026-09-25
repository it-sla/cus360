import { Fragment, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '@/api';
import type { PipelineItem } from '@/api';
import { useAuth } from '@/auth';
import { AlertTriangle, XCircle, Clock, MessageSquare, CheckCircle2, History, ArrowRightCircle, Ghost, RotateCcw } from 'lucide-react';

function formatMoney(value: number | null) {
  if (value === null || value === undefined) return '—';
  const n = Number(value);
  return n === Math.floor(n)
    ? `$${n.toLocaleString()}`
    : `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(value: string) {
  return new Date(value + 'T00:00:00').toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function hoursAgo(iso: string): number {
  return (Date.now() - new Date(iso).getTime()) / 3600000;
}
function relativeSyncTime(iso: string): string {
  const hrs = hoursAgo(iso);
  if (hrs < 1) return 'less than an hour ago';
  if (hrs < 24) return `${Math.round(hrs)}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

const STALE_AFTER_HOURS = 24;

export default function Pipeline() {
  const navigate = useNavigate();
  const { hasRole } = useAuth();
  // Past logs (snapshots + the date-change log) are a drill-down into archived history
  // rather than the everyday "what's active right now" view every role gets — restricted
  // to the roles that actually chase AEs on pipeline hygiene.
  const canSeeLogs = hasRole(['admin', 'sales_lead']);
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [lostOnly, setLostOnly] = useState(false);
  const [aeFilter, setAeFilter] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [historyMode, setHistoryMode] = useState(false);
  const [historyDate, setHistoryDate] = useState('');
  // Within Past logs: snapshot view (pick a day, see that day's grid) vs date-change log
  // (every pushed/vanished/reappeared Expected Date, with an AE summary).
  const [logView, setLogView] = useState<'snapshot' | 'date-changes'>('snapshot');
  const [eventTypeFilter, setEventTypeFilter] = useState('');

  const { data: liveData, isLoading: liveLoading, isError: liveError } = useQuery({
    queryKey: ['pipeline', overdueOnly, lostOnly, aeFilter],
    queryFn: () => api.getPipeline({ overdue_only: overdueOnly || undefined, lost_only: lostOnly || undefined, ae_code: aeFilter || undefined }),
    refetchInterval: 60000,
    enabled: !historyMode,
  });

  const { data: historyDates } = useQuery({
    queryKey: ['pipeline-history-dates'],
    queryFn: () => api.getPipelineHistoryDates(),
    enabled: canSeeLogs && historyMode && logView === 'snapshot',
  });

  const { data: historyData, isLoading: historyLoading, isError: historyError } = useQuery({
    queryKey: ['pipeline-history', historyDate, aeFilter],
    queryFn: () => api.getPipelineHistory(historyDate, aeFilter || undefined),
    enabled: canSeeLogs && historyMode && logView === 'snapshot' && !!historyDate,
  });

  const { data: dateEventsData, isLoading: dateEventsLoading, isError: dateEventsError } = useQuery({
    queryKey: ['pipeline-date-events', aeFilter, eventTypeFilter],
    queryFn: () => api.getPipelineDateEvents({ ae_code: aeFilter || undefined, event_type: eventTypeFilter || undefined }),
    enabled: canSeeLogs && historyMode && logView === 'date-changes',
  });

  const showDateChanges = historyMode && logView === 'date-changes';
  const data = historyMode ? historyData : liveData;
  const isLoading = showDateChanges ? dateEventsLoading : historyMode ? (!!historyDate && historyLoading) : liveLoading;
  const isError = showDateChanges ? dateEventsError : historyMode ? historyError : liveError;

  // Unfiltered, so the AE dropdown keeps every option once an AE is selected —
  // deriving codes from the filtered `items` would collapse the list to just
  // the currently selected AE.
  const { data: allAeData } = useQuery({
    queryKey: ['pipeline-ae-codes'],
    queryFn: () => api.getPipeline({}),
  });

  const items: PipelineItem[] = data?.items ?? [];
  const aeCodes = Array.from(new Set((allAeData?.items ?? []).map((i) => i.ae_code).filter(Boolean))) as string[];
  const revenueAtRisk = items.filter((i) => i.is_overdue).reduce((sum, i) => sum + (i.revenue_usd ?? 0), 0);
  const isStale = !historyMode && !!liveData?.as_of && hoursAgo(liveData.as_of) > STALE_AFTER_HOURS;

  return (
    <div className="flex-1 overflow-y-auto bg-background p-4 sm:p-6 lg:p-8">
      <div className="max-w-[1600px] mx-auto space-y-6">
        <div className="space-y-4">
          <div>
            <h1 className="text-2xl font-black text-slate-900 dark:text-white tracking-tight">Active Pipeline</h1>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-1 max-w-3xl">
              CRM Active Pipeline, scraped periodically. Rows flag amber when overdue, red when lost.
            </p>
            {!historyMode && liveData?.as_of && (
              <p className="flex items-center gap-1.5 text-xs text-slate-400 dark:text-slate-500 mt-1.5">
                <Clock size={11} className="shrink-0" />
                Last synced {new Date(liveData.as_of).toLocaleString()}
              </p>
            )}
          </div>

          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              {canSeeLogs && (
                <div className="flex items-center h-9 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setHistoryMode((v) => !v)}
                    className={`flex items-center gap-1.5 h-full px-3 text-xs font-semibold whitespace-nowrap transition-colors ${
                      historyMode
                        ? 'bg-primary/10 text-primary'
                        : 'text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800'
                    }`}
                  >
                    <History size={12} className="shrink-0" /> Past logs
                  </button>
                  {historyMode && (
                    <>
                      <div className="flex items-center h-full border-l border-slate-200 dark:border-slate-800">
                        <button
                          type="button"
                          onClick={() => setLogView('snapshot')}
                          className={`h-full px-2.5 text-xs font-semibold whitespace-nowrap ${logView === 'snapshot' ? 'bg-slate-100 dark:bg-slate-800 text-slate-900 dark:text-white' : 'text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800'}`}
                        >
                          Snapshot
                        </button>
                        <button
                          type="button"
                          onClick={() => setLogView('date-changes')}
                          className={`h-full px-2.5 text-xs font-semibold whitespace-nowrap ${logView === 'date-changes' ? 'bg-slate-100 dark:bg-slate-800 text-slate-900 dark:text-white' : 'text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800'}`}
                        >
                          Date changes
                        </button>
                      </div>
                      {logView === 'snapshot' && (
                        <select
                          value={historyDate}
                          onChange={(e) => setHistoryDate(e.target.value)}
                          disabled={!historyDates?.dates.length}
                          className="h-full pl-2.5 pr-3 border-l border-slate-200 dark:border-slate-800 text-xs font-semibold text-slate-700 dark:text-slate-300 outline-none hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
                        >
                          {historyDates?.dates.length ? (
                            <>
                              <option value="">Select a date…</option>
                              {historyDates.dates.map((d) => (
                                <option key={d.snapshot_date} value={d.snapshot_date}>{formatDate(d.snapshot_date)} ({d.count})</option>
                              ))}
                            </>
                          ) : (
                            <option value="">No history yet</option>
                          )}
                        </select>
                      )}
                      {logView === 'date-changes' && (
                        <select
                          value={eventTypeFilter}
                          onChange={(e) => setEventTypeFilter(e.target.value)}
                          className="h-full pl-2.5 pr-3 border-l border-slate-200 dark:border-slate-800 text-xs font-semibold text-slate-700 dark:text-slate-300 outline-none hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
                        >
                          <option value="">All changes</option>
                          <option value="pushed">Pushed</option>
                          <option value="vanished">Vanished</option>
                          <option value="reappeared">Reappeared</option>
                          <option value="pulled_in">Pulled in</option>
                        </select>
                      )}
                    </>
                  )}
                </div>
              )}
              {isStale && (
                <span className="flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1.5 rounded-full whitespace-nowrap bg-amber-50 border border-amber-200 text-amber-700 dark:bg-amber-950/20 dark:border-amber-900 dark:text-amber-400">
                  <Clock size={12} className="shrink-0" /> Sync stale — {relativeSyncTime(liveData!.as_of!)}
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
              {!showDateChanges && (
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
              )}
            </div>
          </div>
        </div>

        {showDateChanges && (
          <div className="space-y-4">
            {dateEventsData && dateEventsData.by_ae.length > 0 && (
              <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-slate-50 dark:bg-slate-900 text-left text-xs font-semibold text-slate-500 dark:text-slate-400 capitalize tracking-wide">
                      <th className="px-3 py-2.5">AE</th>
                      <th className="px-3 py-2.5 text-right">Pushed</th>
                      <th className="px-3 py-2.5 text-right">Days pushed</th>
                      <th className="px-3 py-2.5 text-right">Vanished</th>
                      <th className="px-3 py-2.5 text-right">Reappeared</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dateEventsData.by_ae.map((a) => (
                      <tr key={a.ae_code} className="border-t border-slate-100 dark:border-slate-800">
                        <td className="px-3 py-2 font-semibold text-slate-900 dark:text-white">{a.ae_code}</td>
                        <td className="px-3 py-2 text-right text-amber-700 dark:text-amber-400 font-medium">{a.pushed || '—'}</td>
                        <td className="px-3 py-2 text-right text-slate-600 dark:text-slate-300">{a.days_pushed_total || '—'}</td>
                        <td className="px-3 py-2 text-right text-rose-700 dark:text-rose-400 font-medium">{a.vanished || '—'}</td>
                        <td className="px-3 py-2 text-right text-sky-700 dark:text-sky-400 font-medium">{a.reappeared || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-50 dark:bg-slate-900 text-left text-xs font-semibold text-slate-500 dark:text-slate-400 capitalize tracking-wide">
                    <th className="px-3 py-2.5">Date</th>
                    <th className="px-3 py-2.5">Company</th>
                    <th className="px-3 py-2.5">AE</th>
                    <th className="px-3 py-2.5">Change</th>
                    <th className="px-3 py-2.5 text-right">Revenue</th>
                  </tr>
                </thead>
                <tbody>
                  {isLoading && (
                    <tr><td colSpan={5} className="px-4 py-8 text-center text-slate-400">Loading…</td></tr>
                  )}
                  {isError && (
                    <tr><td colSpan={5} className="px-4 py-8 text-center text-rose-600 dark:text-rose-400 font-semibold">Couldn't load the date-change log.</td></tr>
                  )}
                  {!isLoading && !isError && (dateEventsData?.items.length ?? 0) === 0 && (
                    <tr><td colSpan={5} className="px-4 py-8 text-center text-slate-400">No date changes in the last 30 days.</td></tr>
                  )}
                  {dateEventsData?.items.map((e) => (
                    <tr key={e.id} className="border-t border-slate-100 dark:border-slate-800">
                      <td className="px-3 py-2.5 text-slate-500 dark:text-slate-400 whitespace-nowrap">{formatDate(e.event_date)}</td>
                      <td className="px-3 py-2.5 text-slate-900 dark:text-white font-medium">{e.company_name}</td>
                      <td className="px-3 py-2.5 text-slate-500 dark:text-slate-400">{e.ae_code ?? '—'}</td>
                      <td className="px-3 py-2.5">
                        {e.event_type === 'vanished' ? (
                          <span className="inline-flex items-center gap-1 text-xs font-semibold text-rose-700 dark:text-rose-400">
                            <Ghost size={12} className="shrink-0" /> Vanished{e.old_expected_date ? ` (was ${formatDate(e.old_expected_date)}${e.was_overdue ? ', overdue' : ''})` : ''}
                          </span>
                        ) : e.event_type === 'reappeared' ? (
                          <span className="inline-flex items-center gap-1 text-xs font-semibold text-sky-700 dark:text-sky-400">
                            <RotateCcw size={12} className="shrink-0" /> Reappeared {e.old_expected_date ? formatDate(e.old_expected_date) : '—'} → {e.new_expected_date ? formatDate(e.new_expected_date) : '—'}
                          </span>
                        ) : (
                          <span className={`inline-flex items-center gap-1 text-xs font-semibold ${e.event_type === 'pushed' ? 'text-amber-700 dark:text-amber-400' : 'text-slate-600 dark:text-slate-300'}`}>
                            <ArrowRightCircle size={12} className="shrink-0" />
                            {e.old_expected_date ? formatDate(e.old_expected_date) : '—'} → {e.new_expected_date ? formatDate(e.new_expected_date) : '—'}
                            {e.days_shifted != null && ` (${e.days_shifted > 0 ? '+' : ''}${e.days_shifted}d)`}
                            {e.was_overdue && ' · was overdue'}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-right text-slate-700 dark:text-slate-300 font-medium">{formatMoney(e.revenue_usd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {!showDateChanges && (
        <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800">
          <table className="w-full text-sm table-fixed">
            <colgroup>
              <col className="w-[12%]" />
              <col className="w-[20%]" />
              <col className="w-[12%]" />
              <col className="w-[6%]" />
              <col className="w-[9%]" />
              <col className="w-[11%]" />
              <col className="w-[6%]" />
              <col className="w-[7%]" />
              <col className="w-[7%]" />
              <col className="w-[10%]" />
            </colgroup>
            <thead>
              <tr className="bg-slate-50 dark:bg-slate-900 text-left text-xs font-semibold text-slate-500 dark:text-slate-400 capitalize tracking-wide">
                <th className="px-3 py-2.5">Expected Date</th>
                <th className="px-3 py-2.5">Company</th>
                <th className="px-3 py-2.5">ICRIS</th>
                <th className="px-3 py-2.5">Country</th>
                <th className="px-3 py-2.5 text-right">Weight</th>
                <th className="px-3 py-2.5 text-right">Revenue</th>
                <th className="px-3 py-2.5 text-right">Pieces</th>
                <th className="px-3 py-2.5">Tier</th>
                <th className="px-3 py-2.5">AE</th>
                <th className="px-3 py-2.5">Status</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr><td colSpan={10} className="px-4 py-8 text-center text-slate-400">Loading…</td></tr>
              )}
              {isError && (
                <tr><td colSpan={10} className="px-4 py-8 text-center text-rose-600 dark:text-rose-400 font-semibold">
                  Couldn't load the pipeline — retrying automatically.
                </td></tr>
              )}
              {historyMode && !historyDate && (
                <tr><td colSpan={10} className="px-4 py-8 text-center text-slate-400">
                  Pick a date above to see that day's pipeline snapshot.
                </td></tr>
              )}
              {!isLoading && !isError && (!historyMode || historyDate) && items.length === 0 && (
                <tr><td colSpan={10} className="px-4 py-8 text-center text-slate-400">
                  {historyMode
                    ? 'No archived rows for that date.'
                    : <>No pipeline rows. Sync happens from the <button onClick={() => navigate('/app/sync')} className="text-primary font-bold hover:underline">CRM Sync page</button>.</>}
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
                      <td className={`px-3 py-2.5 font-medium ${
                        item.is_lost ? 'text-rose-700 dark:text-rose-400' : item.is_overdue ? 'text-amber-700 dark:text-amber-400' : 'text-slate-700 dark:text-slate-300'
                      }`}>
                        <div className="flex flex-col gap-0.5">
                          <span className="whitespace-nowrap">{formatDate(item.expected_date)}</span>
                          {item.is_overdue && (
                            <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400 w-fit">
                              Follow up
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-slate-900 dark:text-white font-medium">
                        <span className="break-words">{item.company_name}</span>
                        {hasRemark && (
                          <span title={isExpanded ? 'Hide remarks' : 'View remarks'} className="inline-flex items-center justify-center w-5 h-5 ml-1.5 rounded text-slate-400 hover:text-primary hover:bg-slate-100 dark:text-slate-500 dark:hover:text-primary dark:hover:bg-slate-800 transition-colors align-middle">
                            <MessageSquare size={12} className={isExpanded ? 'fill-current' : ''} />
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-slate-500 dark:text-slate-400 font-mono text-xs tracking-wide whitespace-nowrap">{item.icris_number ?? '—'}</td>
                      <td className="px-3 py-2.5 text-slate-500 dark:text-slate-400 truncate">{item.country ?? '—'}</td>
                      <td className="px-3 py-2.5 text-right text-slate-700 dark:text-slate-300">{item.weight_kg ?? '—'}</td>
                      <td className="px-3 py-2.5 text-right text-slate-700 dark:text-slate-300 font-medium">{formatMoney(item.revenue_usd)}</td>
                      <td className="px-3 py-2.5 text-right text-slate-700 dark:text-slate-300">{item.pieces ?? '—'}</td>
                      <td className="px-3 py-2.5 text-slate-500 dark:text-slate-400 truncate">{item.category ?? '—'}</td>
                      <td className="px-3 py-2.5 text-slate-500 dark:text-slate-400 truncate">{item.ae_code ?? '—'}</td>
                      <td className="px-3 py-2.5">
                        {item.is_lost ? (
                          <span className="inline-flex items-center gap-1 text-[11px] font-bold px-1.5 py-0.5 rounded-full bg-rose-100 text-rose-600 dark:bg-rose-900/30 dark:text-rose-400">
                            <XCircle size={11} /> Loss
                          </span>
                        ) : item.win_loss?.toLowerCase() === 'win' ? (
                          <span className="inline-flex items-center gap-1 text-[11px] font-bold px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400">
                            <CheckCircle2 size={11} /> Win
                          </span>
                        ) : (
                          <span className="text-slate-400 dark:text-slate-500">{item.win_loss || '—'}</span>
                        )}
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr className="border-t border-slate-100 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/40">
                        <td colSpan={10} className="px-3 py-2.5 text-xs text-slate-600 dark:text-slate-300">
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
        )}
      </div>
    </div>
  );
}
