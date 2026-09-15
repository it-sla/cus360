import { useState, useEffect } from 'react';
import {
  Package, Search, Download, RefreshCw,
  Truck, CheckCircle2, Clock, Hash, MapPin, Globe,
  X, Building2,
  MoreVertical, Copy, Printer, AlertTriangle, FileText, Plus, Weight
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { DateRangeControl, resolveTimeframeDates } from '@/components/AnalyticsFilterBar';

function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value);
  useEffect(() => {
    const handler = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(handler);
  }, [value, delay]);
  return debouncedValue;
}

function StatusBadge({ status }: { status: string }) {
  const norm = (status || 'unmatched').toLowerCase();
  
  if (norm === 'matched' || norm === 'delivered') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800/50">
        <CheckCircle2 size={11} />
        Delivered / Matched
      </span>
    );
  }
  if (norm === 'suggested' || norm === 'in_transit') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400 border border-blue-200 dark:border-blue-800/50">
        <Truck size={11} />
        In Transit
      </span>
    );
  }
  if (norm === 'delayed') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-50 dark:bg-rose-900/20 text-rose-700 dark:text-rose-400 border border-rose-200 dark:border-rose-800/50">
        <AlertTriangle size={11} />
        Delayed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400 border border-amber-200 dark:border-amber-800/50">
      <Clock size={11} />
      Pending / Unmatched
    </span>
  );
}

function fmtDate(d: string | null) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// The CRM has never populated shipment_weight on any real shipment — every real weight
// value lives in actual_weight instead. Matches the backend filter's own
// coalesce(shipment_weight, actual_weight) so what's displayed agrees with what's filtered.
function shipmentWeight(s: { shipment_weight: number | null; actual_weight?: number | null }): number | null {
  return s.shipment_weight ?? s.actual_weight ?? null;
}
function fmtWeight(s: { shipment_weight: number | null; actual_weight?: number | null }): string {
  const w = shipmentWeight(s);
  return w != null ? `${w} kg` : '—';
}

function fmt$(v: number) {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 10_000) return `$${(v / 1_000).toFixed(1)}k`;
  return `$${v.toLocaleString()}`;
}

export default function AirWaybills() {
  const navigate = useNavigate();
  const [urlParams] = useSearchParams();

  const [searchQuery, setSearchQuery] = useState(() => urlParams.get('search') || '');
  const [filters, setFilters] = useState({
    destination: '',
    weightRange: '',
    dateRange: 'all_time',
    dateFrom: '',
    dateTo: ''
  });

  const [page, setPage] = useState(0);
  const [selectedShipmentId, setSelectedShipmentId] = useState<string | null>(() => urlParams.get('shipment') || null);
  const [showRowMenuId, setShowRowMenuId] = useState<string | null>(null);
  // True when this shipment was opened via a deep link (e.g. from Data Quality) rather than by
  // clicking a row in this page's own list — closing the drawer should then return the user to
  // wherever they came from instead of stranding them on the AWB list.
  const [openedViaDeepLink] = useState(() => !!urlParams.get('shipment'));

  const debouncedSearch = useDebounce(searchQuery, 300);

  const WEIGHT_RANGES: Record<string, { min_weight?: number; max_weight?: number }> = {
    under_10: { max_weight: 10 },
    '10_50': { min_weight: 10, max_weight: 50 },
    '50_100': { min_weight: 50, max_weight: 100 },
    over_100: { min_weight: 100 },
  };

  const resolvedDateRange = resolveTimeframeDates(filters.dateRange, filters.dateFrom, filters.dateTo);

  const queryParams = {
    q: debouncedSearch || undefined,
    import_country: filters.destination || undefined,
    date_from: resolvedDateRange.from,
    date_to: resolvedDateRange.to,
    ...(WEIGHT_RANGES[filters.weightRange] || {}),
    limit: 50,
    offset: page * 50
  };

  useEffect(() => {
    setPage(0);
  }, [debouncedSearch, filters.destination, filters.weightRange, filters.dateRange, filters.dateFrom, filters.dateTo]);

  // Deep-link support: /app/awb?shipment={id} opens the drawer directly, ?search={text} pre-fills the search box.
  useEffect(() => {
    const shipmentId = urlParams.get('shipment');
    if (shipmentId) setSelectedShipmentId(shipmentId);
    const q = urlParams.get('search');
    if (q) setSearchQuery(q);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlParams]);

  const { data: shipmentsData, isLoading: isLoadingShipments, refetch } = useQuery({
    queryKey: ['awb-shipments', queryParams],
    queryFn: () => api.getShipments(queryParams)
  });

  const shipments = shipmentsData?.items || [];
  const totalCount = shipmentsData?.total ?? shipments.length;
  const filteredShipments = shipments;

  return (
    <div className="flex-1 overflow-y-auto bg-background relative">
      <div className="max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
        
        {/* 1. PAGE HEADER */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h1 className="text-xl sm:text-2xl font-black text-slate-900 dark:text-slate-100 tracking-tight">Air Waybills (AWBs)</h1>
            <p className="mt-1 text-xs sm:text-sm text-slate-500 dark:text-slate-400 font-medium">
              Manage and monitor operational air waybills across all customer accounts.
            </p>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button 
              onClick={() => refetch()}
              className="flex items-center gap-1.5 px-3 py-2 bg-white dark:bg-slate-900/50 border border-[#DCE3EC] text-xs font-bold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800/50 rounded-lg shadow-xs transition-colors"
            >
              <RefreshCw size={14} className="text-slate-500 dark:text-slate-400" />
              <span>Refresh</span>
            </button>
            <button className="h-9 px-4 rounded-lg border border-zinc-700 bg-zinc-800 text-zinc-300 hover:bg-zinc-700 hover:text-white transition-colors text-xs font-semibold flex items-center gap-2">
              <Download size={14} />
              Export CSV
            </button>
            <button className="h-9 px-4 rounded-lg bg-teal-600 text-white hover:bg-teal-500 transition-colors text-xs font-semibold flex items-center gap-2">
              <Plus size={14} />
              Create AWB
            </button>
          </div>
        </div>

        {/* 4. TOOLBAR & MULTI-FILTERS */}
        <div className="bg-white dark:bg-slate-900/50 rounded-[16px] border border-[#E2E8F0] p-4 shadow-[0_2px_4px_rgba(15,23,42,0.04)] space-y-3">
          <div className="flex flex-col md:flex-row items-stretch md:items-center gap-3">
            
            {/* Search Input */}
            <div className="relative flex-1">
              <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-400" />
              <input 
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="Search AWB Number, Customer, Destination, Airline..."
                className="w-full h-9 pl-9 pr-3 bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-800 rounded-lg text-xs font-semibold text-slate-800 dark:text-slate-200 outline-none focus:border-primary focus:bg-white dark:bg-slate-900/50 transition-all placeholder:text-slate-400 dark:text-slate-400 placeholder:font-medium"
              />
              {searchQuery && (
                <button onClick={() => setSearchQuery('')} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-400 hover:text-slate-600 dark:text-slate-300">
                  <X size={14} />
                </button>
              )}
            </div>

            {/* Filter Dropdowns */}
            <div className="flex flex-wrap items-center gap-2">
              <DateRangeControl
                timeframe={filters.dateRange}
                dateFrom={filters.dateFrom}
                dateTo={filters.dateTo}
                bounds={resolvedDateRange.from && resolvedDateRange.to ? { c_start: resolvedDateRange.from, c_end: resolvedDateRange.to } : undefined}
                onPreset={v => setFilters(f => ({ ...f, dateRange: v }))}
                onCustom={(from, to) => setFilters(f => ({ ...f, dateRange: 'custom', dateFrom: from, dateTo: to }))}
                defaultPreset="all_time"
              />

              <div className="relative">
                <MapPin size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
                <input
                  type="text"
                  value={filters.destination}
                  onChange={e => setFilters(f => ({ ...f, destination: e.target.value }))}
                  placeholder="Destination country"
                  className="h-9 pl-8 pr-3 w-40 bg-white dark:bg-slate-900/50 border border-slate-200 dark:border-slate-800 rounded-lg text-xs font-semibold text-slate-800 dark:text-slate-200 outline-none hover:bg-slate-50 dark:hover:bg-slate-800/50 shadow-sm placeholder:font-normal placeholder:text-slate-400"
                />
              </div>

              <div className="relative">
                <Weight size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
                <select 
                  value={filters.weightRange} 
                  onChange={e => setFilters(f => ({ ...f, weightRange: e.target.value }))}
                  className="h-9 pl-8 pr-7 py-0 bg-white dark:bg-slate-900/50 border border-slate-200 dark:border-slate-800 rounded-lg text-xs font-semibold text-slate-800 dark:text-slate-200 outline-none hover:bg-slate-50 dark:hover:bg-slate-800/50 cursor-pointer appearance-none shadow-sm"
                >
                  <option value="">All Weights</option>
                  <option value="under_10">&lt; 10 kg</option>
                  <option value="10_50">10 – 50 kg</option>
                  <option value="50_100">50 – 100 kg</option>
                  <option value="over_100">&gt; 100 kg</option>
                </select>
                <div className="absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none text-slate-400 text-[10px]">▼</div>
              </div>

              {(filters.destination || filters.weightRange || filters.dateRange !== 'all_time' || searchQuery) && (
                <button
                  onClick={() => { setSearchQuery(''); setFilters({ destination: '', weightRange: '', dateRange: 'all_time', dateFrom: '', dateTo: '' }); }}
                  className="text-xs font-semibold text-rose-500 hover:text-rose-700 px-2 transition-colors"
                >
                  Clear Filters
                </button>
              )}

            </div>
          </div>

        </div>

        {/* 5. AWB DATA TABLE */}
        <div className="bg-white dark:bg-slate-900/50 rounded-[16px] border border-[#E2E8F0] shadow-[0_2px_4px_rgba(15,23,42,0.04),0_12px_30px_rgba(15,23,42,0.06)] overflow-hidden flex flex-col">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50/90 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-800">
                <tr className="text-[10px] uppercase font-bold tracking-wider text-slate-500 dark:text-slate-400">
                  <th className="px-2.5 py-2.5 text-left">AWB #</th>
                  <th className="px-2.5 py-2.5 text-left">Customer / Shipper</th>
                  <th className="px-2.5 py-2.5 text-left">Route</th>
                  <th className="px-2.5 py-2.5 text-right">Pcs</th>
                  <th className="px-2.5 py-2.5 text-right">Weight</th>
                  <th className="px-2.5 py-2.5 text-right">Revenue</th>
                  <th className="px-2.5 py-2.5 text-left">Status</th>
                  <th className="px-2.5 py-2.5 text-left">Date</th>
                  <th className="px-2.5 py-2.5 text-right w-10">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/50">
                {isLoadingShipments ? (
                  [...Array(8)].map((_, i) => (
                    <tr key={i} className="animate-pulse">
                      <td className="px-2 py-2.5 text-center"><div className="w-4 h-4 bg-slate-100 dark:bg-slate-800 rounded mx-auto" /></td>
                      <td className="px-2.5 py-2.5"><div className="h-4 bg-slate-100 dark:bg-slate-800 rounded w-24" /></td>
                      <td className="px-2.5 py-2.5"><div className="h-4 bg-slate-100 dark:bg-slate-800 rounded w-36" /></td>
                      <td className="px-2.5 py-2.5"><div className="h-4 bg-slate-100 dark:bg-slate-800 rounded w-16" /></td>
                      <td className="px-2.5 py-2.5"><div className="h-4 bg-slate-100 dark:bg-slate-800 rounded w-6 ml-auto" /></td>
                      <td className="px-2.5 py-2.5"><div className="h-4 bg-slate-100 dark:bg-slate-800 rounded w-12 ml-auto" /></td>
                      <td className="px-2.5 py-2.5"><div className="h-4 bg-slate-100 dark:bg-slate-800 rounded w-14 ml-auto" /></td>
                      <td className="px-2.5 py-2.5"><div className="h-4 bg-slate-100 dark:bg-slate-800 rounded w-20" /></td>
                      <td className="px-2.5 py-2.5"><div className="h-4 bg-slate-100 dark:bg-slate-800 rounded w-16" /></td>
                      <td className="px-2.5 py-2.5"></td>
                    </tr>
                  ))
                ) : filteredShipments.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="px-5 py-20 text-center">
                      <div className="flex flex-col items-center justify-center text-slate-400 dark:text-slate-400">
                        <Package size={36} className="mb-3 text-slate-300" />
                        <p className="text-sm font-bold text-slate-600 dark:text-slate-300 mb-1">No Air Waybills found</p>
                        <p className="text-xs">Adjust your search or status filters to see results.</p>
                      </div>
                    </td>
                  </tr>
                ) : (
                  filteredShipments.map((s: any) => {
                    const isDrawerActive = selectedShipmentId === s.id;

                    return (
                      <tr
                        key={s.id}
                        onClick={() => setSelectedShipmentId(s.id)}
                        className={`transition-colors cursor-pointer group ${
                          isDrawerActive ? 'bg-slate-100 dark:bg-slate-800' : ''
                        }`}
                      >
                        <td className="px-2.5 py-2.5 font-bold text-slate-900 dark:text-slate-100 truncate max-w-[130px]">
                          <div className="flex items-center gap-1">
                            <Hash size={12} className="text-slate-400 dark:text-slate-400 shrink-0" />
                            <span className="truncate">{s.shipment_number}</span>
                          </div>
                        </td>

                        <td className="px-2.5 py-2.5 max-w-[150px] lg:max-w-[200px] truncate">
                          {s.company ? (
                            <span 
                              className="font-bold text-primary hover:underline truncate block"
                              onClick={(e) => { e.stopPropagation(); navigate(`/app/customers/${s.company.id}`); }}
                            >
                              {s.company.company_name}
                            </span>
                          ) : (
                            <span className="text-slate-600 dark:text-slate-300 font-medium truncate block">{s.shipper_name || 'Unlinked Shipper'}</span>
                          )}
                        </td>

                        <td className="px-2.5 py-2.5 font-semibold text-slate-700 dark:text-slate-200 whitespace-nowrap">
                          {s.export_country || 'NP'} → {s.import_country || 'US'}
                        </td>

                        <td className="px-2.5 py-2.5 text-right font-medium text-slate-900 dark:text-slate-100 whitespace-nowrap">
                          {s.pieces || 1}
                        </td>

                        <td className="px-2.5 py-2.5 text-right font-bold text-slate-900 dark:text-slate-100 whitespace-nowrap">
                          {fmtWeight(s)}
                        </td>

                        <td className="px-2.5 py-2.5 text-right font-black text-slate-900 dark:text-slate-100 whitespace-nowrap">
                          {fmt$(s.revenue || 0)}
                        </td>

                        <td className="px-2.5 py-2.5">
                          <StatusBadge status={s.match_status} />
                        </td>

                        <td className="px-2.5 py-2.5 text-slate-500 dark:text-slate-400 font-medium whitespace-nowrap">
                          {fmtDate(s.created_at)}
                        </td>

                        <td className="px-2.5 py-2.5 text-right relative" onClick={(e) => e.stopPropagation()}>
                          <button 
                            onClick={() => setShowRowMenuId(showRowMenuId === s.id ? null : s.id)}
                            className="p-1 text-slate-400 dark:text-slate-400 hover:text-slate-800 dark:text-slate-200 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                          >
                            <MoreVertical size={16} />
                          </button>

                          {showRowMenuId === s.id && (
                            <div className="absolute right-4 top-10 w-44 bg-white dark:bg-slate-900/50 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xl z-30 py-1 text-left animate-in fade-in">
                              <button 
                                onClick={() => { setSelectedShipmentId(s.id); setShowRowMenuId(null); }}
                                className="w-full px-3 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800/50 flex items-center gap-2"
                              >
                                <FileText size={13} /> View Details
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* PAGINATION FOOTER */}
          <div className="px-5 py-3 bg-slate-50 dark:bg-slate-800/50 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between text-xs font-medium text-slate-600 dark:text-slate-300">
            <span>Showing <strong>{filteredShipments.length}</strong> of <strong>{totalCount}</strong> Air Waybills</span>

            <div className="flex items-center gap-2">
              <button 
                disabled={page === 0}
                onClick={() => setPage(p => Math.max(0, p - 1))}
                className="px-3 py-1 bg-white dark:bg-slate-900/50 border border-slate-200 dark:border-slate-800 rounded-md font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800/50 disabled:opacity-40"
              >
                Previous
              </button>
              <button 
                disabled={(page + 1) * 50 >= totalCount}
                onClick={() => setPage(p => p + 1)}
                className="px-3 py-1 bg-white dark:bg-slate-900/50 border border-slate-200 dark:border-slate-800 rounded-md font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800/50 disabled:opacity-40"
              >
                Next
              </button>
            </div>
          </div>
        </div>

      </div>

      {/* 6. DETAIL DRAWER WITH SHIPMENT TIMELINE */}
      {selectedShipmentId && (
        <ShipmentDetailDrawer
          shipmentId={selectedShipmentId}
          onClose={() => openedViaDeepLink ? navigate(-1) : setSelectedShipmentId(null)}
          navigate={navigate}
        />
      )}
    </div>
  );
}

// ── DETAIL DRAWER COMPONENT ──────────────────────────────────────────────

export function ShipmentDetailDrawer({ 
  shipmentId, 
  onClose, 
  navigate 
}: { 
  shipmentId: string; 
  onClose: () => void; 
  navigate: any;
}) {
  const { data: shipment, isLoading: isSLoading } = useQuery({
    queryKey: ['shipment', shipmentId],
    queryFn: () => api.getShipment(shipmentId)
  });

  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [onClose]);

  return (
    <>
      {/* Backdrop */}
      <div 
        onClick={onClose} 
        className="fixed inset-0 bg-slate-900/30 backdrop-blur-xs z-40 transition-opacity" 
      />

      {/* Drawer */}
      <div className="fixed inset-y-0 right-0 z-50 w-[540px] bg-white dark:bg-slate-900/50 border-l border-[#E2E8F0] shadow-2xl flex flex-col animate-in slide-in-from-right duration-200">
        
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-800/50 flex items-center justify-between bg-slate-50 dark:bg-slate-800/50 shrink-0">
          <div className="flex items-center gap-3">
            <button
              onClick={onClose}
              className="p-1 text-slate-400 dark:text-slate-400 hover:text-slate-800 dark:text-slate-200 rounded-md hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
            >
              <X size={18} />
            </button>
            <div>
              <span className="text-[10px] font-bold text-slate-400 dark:text-slate-400 uppercase tracking-widest">Air Waybill Record</span>
              <h2 className="text-base font-bold text-slate-900 dark:text-slate-100">
                {isSLoading ? 'Loading...' : shipment?.shipment_number}
              </h2>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button className="p-2 text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors" title="Copy AWB">
              <Copy size={15} />
            </button>
            <button className="p-2 text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors" title="Print AWB">
              <Printer size={15} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          
          {isSLoading ? (
            <div className="space-y-4 animate-pulse">
              <div className="h-20 bg-slate-100 dark:bg-slate-800 rounded-xl" />
              <div className="h-40 bg-slate-100 dark:bg-slate-800 rounded-xl" />
            </div>
          ) : !shipment ? (
            <p className="text-sm text-slate-500 text-center py-12">Shipment not found.</p>
          ) : (
            <>
              {/* ROUTING & CARRIER */}
              <div className="bg-white dark:bg-slate-900/50 border border-slate-200 dark:border-slate-800 rounded-[14px] p-4 space-y-3">
                <h3 className="text-xs font-bold text-slate-900 dark:text-slate-100 tracking-tight flex items-center gap-2">
                  <Globe size={14} className="text-primary" /> Routing & Carrier Information
                </h3>
                
                <div className="grid grid-cols-2 gap-3 text-xs">
                  <div className="p-2.5 bg-slate-50 dark:bg-slate-800/50 rounded-lg">
                    <span className="text-[10px] font-bold text-slate-400 dark:text-slate-400 uppercase">Origin</span>
                    <p className="font-bold text-slate-900 dark:text-slate-100 mt-0.5">{shipment.export_country || 'Nepal (KTM)'}</p>
                  </div>

                  <div className="p-2.5 bg-slate-50 dark:bg-slate-800/50 rounded-lg">
                    <span className="text-[10px] font-bold text-slate-400 dark:text-slate-400 uppercase">Destination</span>
                    <p className="font-bold text-slate-900 dark:text-slate-100 mt-0.5">{shipment.import_country || 'United States (JFK)'}</p>
                  </div>

                  <div className="p-2.5 bg-slate-50 dark:bg-slate-800/50 rounded-lg">
                    <span className="text-[10px] font-bold text-slate-400 dark:text-slate-400 uppercase">Date</span>
                    <p className="font-bold text-slate-900 dark:text-slate-100 mt-0.5">{shipment.shipment_date || '—'}</p>
                  </div>

                  <div className="p-2.5 bg-slate-50 dark:bg-slate-800/50 rounded-lg">
                    <span className="text-[10px] font-bold text-slate-400 dark:text-slate-400 uppercase">Weight</span>
                    <p className="font-bold text-slate-900 dark:text-slate-100 mt-0.5">{fmtWeight(shipment)}</p>
                  </div>

                  <div className="p-2.5 bg-slate-50 dark:bg-slate-800/50 rounded-lg">
                    <span className="text-[10px] font-bold text-slate-400 dark:text-slate-400 uppercase">Pieces</span>
                    <p className="font-bold text-slate-900 dark:text-slate-100 mt-0.5">{shipment.pieces ?? '—'}</p>
                  </div>

                  <div className="p-2.5 bg-slate-50 dark:bg-slate-800/50 rounded-lg">
                    <span className="text-[10px] font-bold text-slate-400 dark:text-slate-400 uppercase">Bill Type</span>
                    <p className="font-bold text-slate-900 dark:text-slate-100 mt-0.5">{shipment.bill_type || '—'}</p>
                  </div>
                </div>
              </div>

              {/* CUSTOMER LINKAGE */}
              <div className="bg-white dark:bg-slate-900/50 border border-slate-200 dark:border-slate-800 rounded-[14px] p-4 space-y-3">
                <h3 className="text-xs font-bold text-slate-900 dark:text-slate-100 tracking-tight flex items-center gap-2">
                  <Building2 size={14} className="text-primary" /> Customer Account Linkage
                </h3>

                {shipment.company ? (
                  <div className="flex items-center justify-between p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-100 rounded-xl">
                    <div>
                      <p className="font-bold text-slate-900 dark:text-slate-100 text-xs">{shipment.company.company_name}</p>
                      <p className="text-[11px] font-mono text-slate-500 dark:text-slate-400 mt-0.5">ICRIS: {shipment.company.icris_number}</p>
                    </div>
                    <button
                      onClick={() => navigate(`/app/customers/${shipment.company!.id}`)}
                      className="px-3 py-1.5 bg-white dark:bg-slate-900/50 border border-blue-200 dark:border-blue-800/50 text-primary font-bold text-xs rounded-lg hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors shadow-xs"
                    >
                      View Profile
                    </button>
                  </div>
                ) : (
                  <div className="p-3 bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-800 rounded-xl text-xs text-slate-600 dark:text-slate-300">
                    <p className="font-semibold text-slate-900 dark:text-slate-100">Unlinked Shipper</p>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">Shipper Name: {shipment.shipper_name || 'N/A'}</p>
                  </div>
                )}
              </div>

            </>
          )}

        </div>
      </div>
    </>
  );
}
