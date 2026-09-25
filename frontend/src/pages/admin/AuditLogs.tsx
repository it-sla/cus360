import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { adminApi } from '../../api';
import { ExportButton } from '@/components/ExportButton';
import { exportXlsx, fetchAllPages, warnIfTruncated } from '@/lib/exportXlsx';
import { Search, FileClock } from 'lucide-react';

const PAGE_SIZE = 25;

const ACTION_STYLE: Record<string, string> = {
  created: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  updated: 'bg-blue-50 text-blue-700 border-blue-200',
  deleted: 'bg-rose-50 text-rose-700 border-rose-200',
};

function ActionBadge({ action }: { action: string }) {
  const cls = ACTION_STYLE[action] || 'bg-slate-100 text-slate-600 border-slate-200';
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold border capitalize ${cls}`}>{action}</span>;
}

export default function AuditLogs() {
  const [page, setPage] = useState(1);
  const [searchQuery, setSearchQuery] = useState('');
  const [entityType, setEntityType] = useState('');

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['admin-audit-logs', searchQuery, entityType, page],
    queryFn: () => adminApi.getAuditLogs({
      q: searchQuery || undefined,
      entity_type: entityType || undefined,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    }),
  });

  const items = data?.items || [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="flex-1 overflow-y-auto bg-background relative">
      {isFetching && <div className="h-0.5 bg-gradient-to-r from-blue-400 via-indigo-500 to-blue-600 animate-pulse w-full sticky top-0 z-50" />}

      <div className="max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">

        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl sm:text-2xl font-black text-slate-900 tracking-tight">Audit Logs</h1>
            <p className="mt-1 text-xs sm:text-sm text-slate-500 font-medium">A record of administrative actions taken in Customer 360.</p>
          </div>
          <ExportButton
            disabled={total === 0}
            onExport={async () => {
              const { items: all, truncated } = await fetchAllPages((offset, limit) => adminApi.getAuditLogs({ q: searchQuery || undefined, entity_type: entityType || undefined, limit, offset }));
              exportXlsx('audit-logs', [{
                name: 'Audit Logs',
                rows: all.map((l) => ({ Time: l.created_at, Entity: l.entity_type, Action: l.action, Description: l.description, Source: l.source })),
              }]);
              warnIfTruncated(truncated, all.length);
            }}
          />
        </div>

        <div className="bg-white rounded-[16px] border border-[#E2E8F0] p-4 shadow-[0_2px_4px_rgba(15,23,42,0.04)] space-y-3">
          <div className="flex flex-col md:flex-row items-stretch md:items-center gap-3">
            <div className="relative flex-1">
              <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                value={searchQuery}
                onChange={e => { setSearchQuery(e.target.value); setPage(1); }}
                placeholder="Search descriptions..."
                className="w-full h-9 pl-9 pr-3 bg-slate-50 border border-slate-200 rounded-lg text-xs font-semibold text-slate-800 outline-none focus:border-primary focus:bg-white transition-all placeholder:text-slate-400 placeholder:font-medium"
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={entityType}
                onChange={e => { setEntityType(e.target.value); setPage(1); }}
                className="h-9 px-3 bg-white border border-slate-200 rounded-lg text-xs font-semibold text-slate-700 outline-none hover:bg-slate-50 cursor-pointer"
              >
                <option value="">All Entity Types</option>
                <option value="user">User</option>
              </select>
              {(searchQuery || entityType) && (
                <button
                  onClick={() => { setSearchQuery(''); setEntityType(''); setPage(1); }}
                  className="text-xs font-semibold text-rose-500 hover:text-rose-700 px-2 transition-colors"
                >
                  Clear Filters
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="bg-white rounded-[16px] border border-[#E2E8F0] shadow-[0_2px_4px_rgba(15,23,42,0.04),0_12px_30px_rgba(15,23,42,0.06)] overflow-hidden flex flex-col">
          <div className="overflow-x-auto min-h-[320px]">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50/90 border-b border-slate-200">
                <tr className="text-[10px] uppercase font-bold tracking-wider text-slate-500">
                  <th className="px-4 py-2.5">When</th>
                  <th className="px-4 py-2.5">Entity</th>
                  <th className="px-4 py-2.5">Action</th>
                  <th className="px-4 py-2.5">Description</th>
                  <th className="px-4 py-2.5">Source</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {isLoading ? (
                  [...Array(6)].map((_, i) => (
                    <tr key={i} className="animate-pulse">
                      <td className="px-4 py-3"><div className="h-4 bg-slate-100 rounded w-28" /></td>
                      <td className="px-4 py-3"><div className="h-4 bg-slate-100 rounded w-14" /></td>
                      <td className="px-4 py-3"><div className="h-4 bg-slate-100 rounded w-16" /></td>
                      <td className="px-4 py-3"><div className="h-4 bg-slate-100 rounded w-64" /></td>
                      <td className="px-4 py-3"><div className="h-4 bg-slate-100 rounded w-14" /></td>
                    </tr>
                  ))
                ) : items.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-5 py-24 text-center">
                      <div className="flex flex-col items-center justify-center text-slate-400">
                        <FileClock size={32} className="mb-3 text-slate-300" />
                        <p className="text-sm font-bold text-slate-600 mb-1">No activity recorded yet</p>
                        <p className="text-xs">Administrative actions (like creating or editing a user) will show up here.</p>
                      </div>
                    </td>
                  </tr>
                ) : (
                  items.map(log => (
                    <tr key={log.id} className="transition-colors">
                      <td className="px-4 py-3 text-slate-500 whitespace-nowrap">
                        {new Date(log.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}
                      </td>
                      <td className="px-4 py-3 font-semibold text-slate-700 capitalize">{log.entity_type}</td>
                      <td className="px-4 py-3"><ActionBadge action={log.action} /></td>
                      <td className="px-4 py-3 text-slate-800">{log.description}</td>
                      <td className="px-4 py-3 text-slate-500">{log.source}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="px-5 py-3 bg-slate-50/80 border-t border-slate-200 flex items-center justify-between text-xs font-medium text-slate-600">
              <span>Showing <strong>{(page - 1) * PAGE_SIZE + 1}</strong> to <strong>{Math.min(page * PAGE_SIZE, total)}</strong> of <strong>{total}</strong> entries</span>
              <div className="flex items-center gap-2">
                <button disabled={page === 1} onClick={() => setPage(p => Math.max(1, p - 1))} className="px-3 py-1 bg-white border border-slate-200 rounded-md font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40">Previous</button>
                <span className="text-xs font-bold text-slate-800 px-2">Page {page} of {totalPages}</span>
                <button disabled={page === totalPages} onClick={() => setPage(p => Math.min(totalPages, p + 1))} className="px-3 py-1 bg-white border border-slate-200 rounded-md font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40">Next</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
