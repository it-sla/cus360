import { useState, useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Search, RefreshCw, X, ArrowUpDown, ArrowUp, ArrowDown,
  Building2
} from 'lucide-react';
import { api } from '../api';
function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value);
  useEffect(() => {
    const handler = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(handler);
  }, [value, delay]);
  return debouncedValue;
}

const PAGE_SIZE = 25;

const STATUS_BADGES: Record<string, { bg: string; text: string; label: string }> = {
  active:   { bg: 'bg-emerald-50 border-emerald-200', text: 'text-emerald-700', label: 'Active' },
  prospect: { bg: 'bg-blue-50 border-blue-200', text: 'text-blue-700', label: 'Prospect' },
  vip:      { bg: 'bg-purple-50 border-purple-200', text: 'text-purple-700', label: 'VIP' },
  inactive: { bg: 'bg-amber-50 border-amber-200', text: 'text-amber-700', label: 'Inactive' },
  blocked:  { bg: 'bg-rose-50 border-rose-200', text: 'text-rose-700', label: 'Blocked' },
};

function StatusBadge({ status, isProvisional }: { status: string; isProvisional?: boolean }) {
  if (isProvisional) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-50 text-amber-700 border border-amber-200">
        Provisional
      </span>
    );
  }

  const norm = (status || 'active').toLowerCase();
  const conf = STATUS_BADGES[norm] || STATUS_BADGES.active;

  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold border ${conf.bg} ${conf.text}`}>
      {conf.label}
    </span>
  );
}

function fmt$(v: number) { return `$${v >= 1000 ? (v/1000).toFixed(1) + 'k' : v.toLocaleString()}`; }
function fmtWeight(v: number) { return v >= 1000 ? `${(v / 1000).toFixed(1)} t` : `${v.toLocaleString()} kg`; }

export default function CustomerDirectory() {
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchParams] = useSearchParams();
  const [filters, setFilters] = useState({
    inactivityStatus: searchParams.get('inactivityStatus') || '',
    segment: searchParams.get('segment') || '',
    payTerm: searchParams.get('payTerm') || '',
  });

  const [sortField, setSortField] = useState<string | null>('company_name');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');


  const debouncedSearch = useDebounce(searchQuery, 300);

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['companies', debouncedSearch, filters.inactivityStatus, filters.segment, filters.payTerm],
    queryFn: () => api.getCompanies({
      q: debouncedSearch || undefined,
      inactivity_status: filters.inactivityStatus || undefined,
      customer_type: filters.segment || undefined,
      pay_term: filters.payTerm || undefined,
      limit: 200,   // backend hard cap is le=200
      offset: 0
    }),
  });

  const rawItems = data?.items || [];
  // `data.total` is the true count of companies matching the current filters; `rawItems` is
  // capped at the `limit: 200` sent in the request below, so the two can diverge for a broad
  // (or unfiltered) search — the pagination footer surfaces that gap rather than silently
  // implying only `rawItems.length` accounts exist.
  const backendTotal = data?.total ?? rawItems.length;

  // Filter & Sort locally for instant BI responsiveness
  const { paginatedItems, totalItems, totalPages } = useMemo(() => {
    let items = [...rawItems];

    if (sortField) {
      items.sort((a: any, b: any) => {
        let valA = a[sortField];
        let valB = b[sortField];
        if (typeof valA === 'string') valA = valA.toLowerCase();
        if (typeof valB === 'string') valB = valB.toLowerCase();
        if (valA === null || valA === undefined) return sortDirection === 'asc' ? 1 : -1;
        if (valB === null || valB === undefined) return sortDirection === 'asc' ? -1 : 1;
        if (valA < valB) return sortDirection === 'asc' ? -1 : 1;
        if (valA > valB) return sortDirection === 'asc' ? 1 : -1;
        return 0;
      });
    }

    const t = items.length;
    const tp = Math.ceil(t / PAGE_SIZE) || 1;
    const safePage = Math.min(Math.max(1, page), tp);
    const start = (safePage - 1) * PAGE_SIZE;
    const paginated = items.slice(start, start + PAGE_SIZE);

    return {
      paginatedItems: paginated,
      totalItems: t,
      totalPages: tp
    };
  }, [rawItems, sortField, sortDirection, page]);

  const handleSort = (field: string) => {
    if (sortField === field) {
      setSortDirection(prev => prev === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  };

  const SortIcon = ({ field }: { field: string }) => {
    if (sortField !== field) return <ArrowUpDown size={12} className="text-slate-300 opacity-0 group-hover:opacity-100 transition-opacity" />;
    return sortDirection === 'asc' ? <ArrowUp size={12} className="text-primary" /> : <ArrowDown size={12} className="text-primary" />;
  };

  return (
    <div className="flex-1 overflow-y-auto bg-background relative">
      {isFetching && <div className="h-0.5 bg-gradient-to-r from-blue-400 via-indigo-500 to-blue-600 animate-pulse w-full sticky top-0 z-50" />}

      <div className="max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
        
        {/* 1. PAGE HEADER */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h1 className="text-xl sm:text-2xl font-black text-slate-900 tracking-tight">Customer Directory</h1>
            <p className="mt-1 text-xs sm:text-sm text-slate-500 font-medium">
              Manage and analyze all master customer accounts across the organization.
            </p>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button 
              onClick={() => refetch()} 
              className="flex items-center gap-1.5 px-3 py-2 bg-white border border-[#DCE3EC] text-xs font-bold text-slate-700 hover:bg-slate-50 rounded-lg shadow-xs transition-colors"
            >
              <RefreshCw size={14} className={`text-slate-500 ${isFetching ? 'animate-spin' : ''}`} />
              <span>Refresh</span>
            </button>
          </div>
        </div>

        {/* 4. TOOLBAR & MULTI-FILTERS */}
        <div className="bg-white rounded-[16px] border border-[#E2E8F0] p-4 shadow-[0_2px_4px_rgba(15,23,42,0.04)] space-y-3">
          <div className="flex flex-col md:flex-row items-stretch md:items-center gap-3">
            
            {/* Search Input */}
            <div className="relative flex-1">
              <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input 
                type="text"
                value={searchQuery}
                onChange={e => { setSearchQuery(e.target.value); setPage(1); }}
                placeholder="Search Company Name, ICRIS ID, Contact Name, Email, Country..."
                className="w-full h-9 pl-9 pr-3 bg-slate-50 border border-slate-200 rounded-lg text-xs font-semibold text-slate-800 outline-none focus:border-primary focus:bg-white transition-all placeholder:text-slate-400 placeholder:font-medium"
              />
              {searchQuery && (
                <button onClick={() => setSearchQuery('')} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                  <X size={14} />
                </button>
              )}
            </div>

            {/* Filter Dropdowns */}
            <div className="flex flex-wrap items-center gap-2">
              
              <select 
                value={filters.inactivityStatus} 
                onChange={e => { setFilters(prev => ({ ...prev, inactivityStatus: e.target.value })); setPage(1); }}
                className="h-9 px-3 bg-white border border-slate-200 rounded-lg text-xs font-semibold text-slate-700 outline-none hover:bg-slate-50 cursor-pointer"
              >
                <option value="">All Activity Statuses</option>
                <option value="active">Active (&lt; 30 days)</option>
                <option value="quiet">Quiet (30 - 60 days)</option>
                <option value="inactive">Inactive (60 - 90 days)</option>
                <option value="dormant">Dormant (&gt; 90 days)</option>
                <option value="reactivated">Reactivated (This Month)</option>
              </select>

              <select 
                value={filters.segment} 
                onChange={e => { setFilters(prev => ({ ...prev, segment: e.target.value })); setPage(1); }}
                className="h-9 px-3 bg-white border border-slate-200 rounded-lg text-xs font-semibold text-slate-700 outline-none hover:bg-slate-50 cursor-pointer"
              >
                <option value="">All Segments</option>
                <option value="Key Account">Key Account</option>
                <option value="Reseller">Reseller</option>
                <option value="Large Account">Large Account</option>
                <option value="SME">SME</option>
                <option value="Small Customer">Small Customer</option>
              </select>

              <select 
                value={filters.payTerm} 
                onChange={e => { setFilters(prev => ({ ...prev, payTerm: e.target.value })); setPage(1); }}
                className="h-9 px-3 bg-white border border-slate-200 rounded-lg text-xs font-semibold text-slate-700 outline-none hover:bg-slate-50 cursor-pointer"
              >
                <option value="">All Pay Terms</option>
                <option value="PP">Prepaid (PP)</option>
                <option value="FC">Freight Collect (FC)</option>
                <option value="FD">Free Domicile (FD)</option>
              </select>

              {(filters.inactivityStatus || filters.segment || filters.payTerm || searchQuery) && (
                <button
                  onClick={() => {
                    setSearchQuery('');
                    setFilters({ inactivityStatus: '', segment: '', payTerm: '' });
                    setPage(1);
                  }}
                  className="text-xs font-semibold text-rose-500 hover:text-rose-700 px-2 transition-colors"
                >
                  Clear Filters
                </button>
              )}

            </div>
          </div>
        </div>

        {/* 5. HIGH-DENSITY CUSTOMER TABLE */}
        <div className="bg-white dark:bg-slate-900/50 rounded-[16px] border border-[#E2E8F0] dark:border-slate-800 shadow-[0_2px_4px_rgba(15,23,42,0.04),0_12px_30px_rgba(15,23,42,0.06)] overflow-hidden flex flex-col">
          <div className="overflow-x-auto min-h-[480px]">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50/90 dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800">
                <tr className="text-[10px] uppercase font-bold tracking-wider text-slate-500 dark:text-slate-400">
                  <th className="px-2.5 py-2.5 text-left cursor-pointer group hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors" onClick={() => handleSort('company_name')}>
                    <div className="flex items-center gap-1">Company <SortIcon field="company_name" /></div>
                  </th>
                  <th className="px-2.5 py-2.5 text-left cursor-pointer group hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors" onClick={() => handleSort('icris_number')}>
                    <div className="flex items-center gap-1">ICRIS <SortIcon field="icris_number" /></div>
                  </th>
                  <th className="px-2.5 py-2.5 text-left">Country</th>
                  <th className="px-2.5 py-2.5 text-right cursor-pointer group hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors" onClick={() => handleSort('revenue')}>
                    <div className="flex items-center justify-end gap-1"><SortIcon field="revenue" /> Revenue</div>
                  </th>
                  <th className="px-2.5 py-2.5 text-right cursor-pointer group hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors" onClick={() => handleSort('shipment_count')}>
                    <div className="flex items-center justify-end gap-1"><SortIcon field="shipment_count" /> AWBs</div>
                  </th>
                  <th className="px-2.5 py-2.5 text-right cursor-pointer group hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors" onClick={() => handleSort('total_weight')}>
                    <div className="flex items-center justify-end gap-1"><SortIcon field="total_weight" /> Weight</div>
                  </th>
                  <th className="px-2.5 py-2.5 text-right">Repeat</th>
                  <th className="px-2.5 py-2.5 text-left">AE</th>
                  <th className="px-2.5 py-2.5 text-left">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/50">
                {isLoading ? (
                  [...Array(10)].map((_, i) => (
                    <tr key={i} className="animate-pulse">
                      <td className="px-2.5 py-3"><div className="h-4 bg-slate-100 rounded w-36" /></td>
                      <td className="px-2.5 py-3"><div className="h-4 bg-slate-100 rounded w-20" /></td>
                      <td className="px-2.5 py-3"><div className="h-4 bg-slate-100 rounded w-12" /></td>
                      <td className="px-2.5 py-3"><div className="h-4 bg-slate-100 rounded w-14 ml-auto" /></td>
                      <td className="px-2.5 py-3"><div className="h-4 bg-slate-100 rounded w-8 ml-auto" /></td>
                      <td className="px-2.5 py-3"><div className="h-4 bg-slate-100 rounded w-14 ml-auto" /></td>
                      <td className="px-2.5 py-3"><div className="h-4 bg-slate-100 rounded w-10 ml-auto" /></td>
                      <td className="px-2.5 py-3"><div className="h-4 bg-slate-100 rounded w-16" /></td>
                      <td className="px-2.5 py-3"><div className="h-4 bg-slate-100 rounded w-16" /></td>
                    </tr>
                  ))
                ) : paginatedItems.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="px-5 py-24 text-center">
                      <div className="flex flex-col items-center justify-center text-slate-400">
                        <Building2 size={36} className="mb-3 text-slate-300" />
                        <p className="text-sm font-bold text-slate-600 mb-1">No Customers Found</p>
                        <p className="text-xs">Try adjusting your search or status filters.</p>
                      </div>
                    </td>
                  </tr>
                ) : (
                  paginatedItems.map((c: any) => {
                    return (
                      <tr 
                        key={c.company_id}
                        onClick={() => navigate(`/app/customers/${c.company_id}`)}
                        className="transition-colors cursor-pointer group"
                      >
                        <td className="px-2.5 py-3 font-bold text-slate-900 dark:text-slate-100 max-w-[180px] lg:max-w-[240px] truncate">
                          <span 
                            className="hover:text-primary transition-colors"
                            onClick={(e) => { e.stopPropagation(); navigate(`/app/customers/${c.company_id}`); }}
                          >
                            {c.company_name ? c.company_name : <span className="text-amber-500 italic font-bold">Unlinked Shipments</span>}
                          </span>
                        </td>

                        <td className="px-2.5 py-3 font-mono text-slate-600 dark:text-slate-400 truncate max-w-[100px]">
                          {c.icris_number || <span className="text-slate-300 dark:text-slate-600">—</span>}
                        </td>

                        <td className="px-2.5 py-3 font-medium text-slate-700 dark:text-slate-300 truncate max-w-[90px]">
                          {c.country || 'Unknown'}
                        </td>

                        <td className="px-2.5 py-3 text-right font-black text-slate-900 dark:text-slate-100 whitespace-nowrap">
                          {fmt$(c.revenue || 0)}
                        </td>

                        <td className="px-2.5 py-3 text-right font-bold text-slate-700 dark:text-slate-300 whitespace-nowrap">
                          {c.shipment_count > 0 ? c.shipment_count.toLocaleString() : '0'}
                        </td>

                        <td className="px-2.5 py-3 text-right font-semibold text-slate-600 dark:text-slate-400 whitespace-nowrap">
                          {fmtWeight(c.total_weight || 0)}
                        </td>

                        <td className="px-2.5 py-3 text-right font-semibold text-slate-600 dark:text-slate-400 whitespace-nowrap">
                          {(c.repeat_rate ?? 0).toFixed(1)}%
                        </td>

                        <td className="px-2.5 py-3 text-slate-600 dark:text-slate-400 font-medium truncate max-w-[100px]">
                          {c.ae_code || 'UNASSIGNED'}
                        </td>

                        <td className="px-2.5 py-3">
                          <StatusBadge status={c.inactivity_status} isProvisional={c.is_provisional} />
                        </td>

                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* PAGINATION FOOTER */}
          {totalPages > 1 && (
            <div className="px-5 py-3 bg-slate-50/80 border-t border-slate-200 flex items-center justify-between text-xs font-medium text-slate-600">
              <span>
                Showing <strong>{(page - 1) * PAGE_SIZE + 1}</strong> to <strong>{Math.min(page * PAGE_SIZE, totalItems)}</strong> of <strong>{totalItems}</strong> loaded
                {backendTotal > rawItems.length && (
                  <span className="text-amber-600"> · {backendTotal.toLocaleString()} accounts match these filters — narrow your search or filters to see beyond the first {rawItems.length}</span>
                )}
              </span>

              <div className="flex items-center gap-2">
                <button 
                  disabled={page === 1}
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  className="px-3 py-1 bg-white border border-slate-200 rounded-md font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40"
                >
                  Previous
                </button>
                <span className="text-xs font-bold text-slate-800 px-2">Page {page} of {totalPages}</span>
                <button 
                  disabled={page === totalPages}
                  onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                  className="px-3 py-1 bg-white border border-slate-200 rounded-md font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </div>

      </div>

    </div>
  );
}

