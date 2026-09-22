import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type LeaderboardEntry } from '../api';
import { useAuth } from '@/auth';
import { LeaderboardRankings, type LeaderboardRankingItem } from '@/components/ui/leaderboard-rankings';
import { DateRangeControl } from '@/components/AnalyticsFilterBar';
import { Trophy, DollarSign, Package, Weight, Award, Sparkles, X } from 'lucide-react';

type Metric = 'revenue' | 'shipments' | 'weight' | 'wins';

const METRIC_META: Record<Metric, { label: string; icon: typeof DollarSign; unit: string; format: (v: number) => string }> = {
  revenue: { label: 'Revenue', icon: DollarSign, unit: '', format: v => `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}` },
  shipments: { label: 'Shipments', icon: Package, unit: 'AWBs', format: v => v.toLocaleString() },
  weight: { label: 'Weight', icon: Weight, unit: 'kg', format: v => `${v.toLocaleString(undefined, { maximumFractionDigits: 0 })} kg` },
  wins: { label: 'Wins', icon: Award, unit: '', format: v => `${v.toLocaleString()} ${v === 1 ? 'win' : 'wins'}` },
};

function Podium({ entries, metric, onSelect }: { entries: LeaderboardEntry[]; metric: Metric; onSelect?: (e: LeaderboardEntry) => void }) {
  const meta = METRIC_META[metric];
  const [first, second, third] = entries;
  const slot = (e: LeaderboardEntry | undefined, place: 1 | 2 | 3) => {
    if (!e) return <div className="flex-1" />;
    const height = place === 1 ? 'h-28' : place === 2 ? 'h-20' : 'h-14';
    const color = place === 1 ? 'from-amber-400 to-amber-500' : place === 2 ? 'from-slate-300 to-slate-400' : 'from-orange-300 to-orange-400';
    return (
      <div
        className={`flex-1 flex flex-col items-center justify-end gap-2 ${onSelect ? 'cursor-pointer' : ''}`}
        onClick={onSelect ? () => onSelect(e) : undefined}
      >
        <div className="w-11 h-11 rounded-full bg-white dark:bg-slate-800 border-2 border-slate-200 dark:border-slate-700 flex items-center justify-center text-sm font-black text-slate-700 dark:text-slate-200">
          {e.display_name.charAt(0).toUpperCase()}
        </div>
        <div className="text-center">
          <p className="text-xs font-bold text-slate-800 dark:text-slate-100 truncate max-w-[100px]">{e.display_name}</p>
          <p className="text-[11px] font-semibold text-slate-500 dark:text-slate-400">{meta.format(e[metric])}</p>
        </div>
        <div className={`w-full ${height} rounded-t-lg bg-gradient-to-b ${color} flex items-start justify-center pt-1.5`}>
          <span className="text-white font-black text-lg">{place}</span>
        </div>
      </div>
    );
  };
  return (
    <div className="flex items-end gap-3 px-2">
      {slot(second, 2)}
      {slot(first, 1)}
      {slot(third, 3)}
    </div>
  );
}

function WinsDetailModal({ entry, dateFrom, dateTo, onClose }: { entry: LeaderboardEntry; dateFrom: string; dateTo: string; onClose: () => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ['leaderboard-wins-detail', entry.ae_code, dateFrom, dateTo],
    queryFn: () => api.getLeaderboardWinsDetail(entry.ae_code, dateFrom, dateTo),
  });

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xl max-w-md w-full max-h-[80vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-800">
          <div>
            <h2 className="text-sm font-black text-slate-900 dark:text-white">{entry.display_name}'s wins</h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">{entry.wins} {entry.wins === 1 ? 'company' : 'companies'} marked Win this period</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200">
            <X size={18} />
          </button>
        </div>
        <div className="overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800">
          {isLoading ? (
            <div className="px-5 py-8 text-center text-sm text-slate-400">Loading…</div>
          ) : !data?.companies.length ? (
            <div className="px-5 py-8 text-center text-sm text-slate-400">No won companies found for this range.</div>
          ) : (
            data.companies.map(c => (
              <div key={c.company_key} className="px-5 py-3">
                <p className="text-sm font-bold text-slate-800 dark:text-slate-100">{c.company_name}</p>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                  Won {c.first_win_date}{c.last_win_date !== c.first_win_date ? ` – ${c.last_win_date}` : ''} · {c.log_count} log{c.log_count === 1 ? '' : 's'}
                </p>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

export default function Leaderboard() {
  const { user, isAdmin } = useAuth();
  const [metric, setMetric] = useState<Metric>('revenue');
  // Same DateRangeControl used across the analytics suite — admin/super_admin only,
  // since the backend ignores these params (and stays pinned to the current month)
  // for every other role.
  const [timeframe, setTimeframe] = useState('this_month');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [selectedEntry, setSelectedEntry] = useState<LeaderboardEntry | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['leaderboard', isAdmin ? timeframe : null, isAdmin ? customFrom : null, isAdmin ? customTo : null],
    queryFn: () => api.getLeaderboard(isAdmin ? { timeframe, date_from: customFrom || undefined, date_to: customTo || undefined } : undefined),
  });

  const entries = data?.leaderboards[metric] || [];
  const meta = METRIC_META[metric];
  // Ranking zero AEs 1..N on a metric nobody has any value for (typically Wins, since
  // the CRM has never sent one yet) would crown a fake #1 — show a metric-specific
  // empty state instead of a podium full of zeros.
  const hasStandings = entries.some(e => e[metric] > 0);
  const rankings: LeaderboardRankingItem[] = entries.map(e => ({
    userId: e.ae_code,
    userName: e.display_name,
    rank: e.rank,
    value: e[metric],
  }));
  // Wins drill-down (which companies made up the count) is admin-only — everyone
  // else just sees the motivational number, same as every other metric here.
  const winsClickable = isAdmin && metric === 'wins';
  const selectEntryByCode = (aeCode: string) => {
    const e = entries.find(x => x.ae_code === aeCode);
    if (e) setSelectedEntry(e);
  };

  return (
    <div className="flex-1 overflow-y-auto bg-background relative">
      <div className="max-w-[900px] mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="w-11 h-11 rounded-full bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/50 flex items-center justify-center shrink-0">
              <Trophy size={20} className="text-amber-600 dark:text-amber-400" />
            </div>
            <div>
              <h1 className="text-xl sm:text-2xl font-black text-slate-900 dark:text-white tracking-tight">Leaderboard</h1>
              <p className="mt-1 text-xs sm:text-sm text-slate-500 dark:text-slate-400 font-medium">
                {data ? `${data.period.label} · every AE, ranked by ${meta.label.toLowerCase()}` : 'Loading standings…'}
              </p>
            </div>
          </div>

          {isAdmin && (
            <DateRangeControl
              timeframe={timeframe} dateFrom={customFrom} dateTo={customTo}
              bounds={data?.period ? { c_start: data.period.start, c_end: data.period.end } : undefined}
              onPreset={(v) => { setTimeframe(v); setCustomFrom(''); setCustomTo(''); }}
              onCustom={(f, t) => { setTimeframe('custom'); setCustomFrom(f); setCustomTo(t); }}
            />
          )}
        </div>

        <div className="flex gap-1.5 bg-slate-100 dark:bg-slate-800/60 p-1 rounded-xl w-fit">
          {(Object.keys(METRIC_META) as Metric[]).map(m => {
            const Icon = METRIC_META[m].icon;
            const active = metric === m;
            return (
              <button
                key={m}
                onClick={() => setMetric(m)}
                className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-bold transition-colors ${
                  active ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm' : 'text-slate-500 dark:text-slate-400 hover:text-slate-700'
                }`}
              >
                <Icon size={13} /> {METRIC_META[m].label}
              </button>
            );
          })}
        </div>

        {isLoading ? (
          <div className="text-center py-16 text-sm text-slate-400">Loading standings…</div>
        ) : entries.length === 0 || !hasStandings ? (
          <div className="flex flex-col items-center justify-center py-16 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800">
            <Sparkles size={28} className="text-slate-300 mb-3" />
            <p className="text-sm font-bold text-slate-700 dark:text-slate-200">No {meta.label.toLowerCase()} recorded in this range</p>
            <p className="text-xs text-slate-400 mt-1">
              {metric === 'wins'
                ? 'The board fills in once a call log is marked Win in this range.'
                : 'The board fills in as AE-coded shipments come through.'}
            </p>
          </div>
        ) : (
          <>
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-sm">
              <Podium entries={entries} metric={metric} onSelect={winsClickable ? (e) => setSelectedEntry(e) : undefined} />
            </div>

            <LeaderboardRankings
              rankings={rankings}
              currentUserId={user?.ae_code || undefined}
              showPagination={rankings.length > 10}
              defaultPageSize={10}
              onUserClick={winsClickable ? (r) => selectEntryByCode(r.userId) : undefined}
            />
          </>
        )}

        {selectedEntry && data && (
          <WinsDetailModal
            entry={selectedEntry}
            dateFrom={data.period.start}
            dateTo={data.period.end}
            onClose={() => setSelectedEntry(null)}
          />
        )}
      </div>
    </div>
  );
}
