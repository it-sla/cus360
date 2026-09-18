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
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
        <CheckCircle2 size={11} />
        Delivered / Matched
      </span>
    );
  }
  if (norm === 'suggested' || norm === 'in_transit') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-blue-500/10 text-blue-400 border border-blue-500/30">
        <Truck size={11} />
        In Transit
      </span>
    );
  }
  if (norm === 'delayed') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-500/10 text-rose-400 border border-rose-500/30">
        <AlertTriangle size={11} />
        Delayed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/10 text-amber-400 border border-amber-500/30">
      <Clock size={11} />
      Pending / Unmatched
    </span>
  );
}

function fmtDate(d: string | null) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

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
  const [urlParams, setUrlParams] = useSearchParams();
  const updateParams = (updates: Record<string, string>) => {
    setUrlParams(prev => {
      const next = new URLSearchParams(prev);
      Object.entries(updates).forEach(([k, v]) => (v ? next.set(k, v) : next.delete(k)));
      return next;
    }, { replace: true });
  };

  const filters = {
    destination: urlParams.get('destination') || '',
    weightRange: urlParams.get('weightRange') || '',
    dateRange: urlParams.get('dateRange') || 'all_time',
    dateFrom: urlParams.get('dateFrom') || '',
    dateTo: urlParams.get('dateTo') || ''
  };
  const setFilters = (updater: (f: typeof filters) => typeof filters) => {
    updateParams({ ...updater(filters), page: '' });
  };

  const page = Number(urlParams.get('page')) || 0;
  const setPage = (updater: number | ((p: number) => number)) => {
    const next = typeof updater === 'function' ? updater(page) : updater;
    updateParams({ page: next ? String(next) : '' });
  };

  const [searchInput, setSearchInput] = useState(() => urlParams.get('search') || '');
  const debouncedSearch = useDebounce(searchInput, 300);
  useEffect(() => { updateParams({ search: debouncedSearch, page: '' }); }, [debouncedSearch]);
  const setSearchQuery = setSearchInput;
  const searchQuery = searchInput;

  const [selectedShipmentId, setSelectedShipmentId] = useState<string | null>(() => urlParams.get('shipment') || null);
  const [showRowMenuId, setShowRowMenuId] = useState<string | null>(null);
  const [openedViaDeepLink] = useState(() => !!urlParams.get('shipment'));

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
    const shipmentId = urlParams.get('shipment');
    if (shipmentId) setSelectedShipmentId(shipmentId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

        {/* PAGE HEADER */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h1 className="text-xl sm:text-2xl font-black text-zinc-50 tracking-tight">Air Waybills (AWBs)</h1>
            <p className="mt-1 text-xs sm:text-sm text-zinc-500 font-medium">
              Manage and monitor operational air waybills across all customer accounts.
            </p>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => refetch()}
              className="flex items-center gap-1.5 px-3 py-2 bg-zinc-800 border border-zinc-700 text-xs font-bold text-zinc-300 hover:bg-zinc-700 rounded-lg transition-colors"
            >
              <RefreshCw size={14} className="text-zinc-500" />
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

        {/* TOOLBAR & FILTERS */}
        <div className="bg-zinc-900 rounded-[16px] border border-zinc-800 p-4 space-y-3">
          <div className="flex flex-col md:flex-row items-stretch md:items-center gap-3">

            {/* Search Input */}
            <div className="relative flex-1">
              <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
              <input
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="Search AWB Number, Customer, Destination, Airline..."
                className="w-full h-9 pl-9 pr-3 bg-zinc-800 border border-zinc-700 rounded-lg text-xs font-semibold text-zinc-300 outline-none focus:border-primary transition-all placeholder:text-zinc-500 placeholder:font-medium"
              />
              {searchQuery && (
                <button onClick={() => setSearchQuery('')} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300">
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
                <MapPin size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500 pointer-events-none" />
                <input
                  type="text"
                  value={filters.destination}
                  onChange={e => setFilters(f => ({ ...f, destination: e.target.value }))}
                  placeholder="Destination country"
                  className="h-9 pl-8 pr-3 w-40 bg-zinc-800 border border-zinc-700 rounded-lg text-xs font-semibold text-zinc-300 outline-none hover:bg-zinc-700 placeholder:font-normal placeholder:text-zinc-500"
                />
              </div>

              <div className="relative">
                <Weight size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500 pointer-events-none" />
                <select
                  value={filters.weightRange}
                  onChange={e => setFilters(f => ({ ...f, weightRange: e.target.value }))}
                  className="h-9 pl-8 pr-7 py-0 bg-zinc-800 border border-zinc-700 rounded-lg text-xs font-semibold text-zinc-300 outline-none hover:bg-zinc-700 cursor-pointer appearance-none"
                >
                  <option value="">All Weights</option>
                  <option value="under_10">&lt; 10 kg</option>
                  <option value="10_50">10 – 50 kg</option>
                  <option value="50_100">50 – 100 kg</option>
                  <option value="over_100">&gt; 100 kg</option>
                </select>
                <div className="absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none text-zinc-500 text-[10px]">▼</div>
              </div>

              {(filters.destination || filters.weightRange || filters.dateRange !== 'all_time' || searchQuery) && (
                <button
                  onClick={() => { setSearchQuery(''); setFilters(() => ({ destination: '', weightRange: '', dateRange: 'all_time', dateFrom: '', dateTo: '' })); }}
                  className="text-xs font-semibold text-rose-500 hover:text-rose-400 px-2 transition-colors"
                >
                  Clear Filters
                </button>
              )}
            </div>
          </div>
        </div>

        {/* AWB DATA TABLE */}
        <div className="bg-zinc-900 rounded-[16px] border border-zinc-800 overflow-hidden flex flex-col">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-zinc-800/50 border-b border-zinc-800">
                <tr className="text-[10px] uppercase font-bold tracking-wider text-zinc-500">
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
              <tbody className="divide-y divide-zinc-800">
                {isLoadingShipments ? (
                  [...Array(8)].map((_, i) => (
                    <tr key={i} className="animate-pulse">
                      <td className="px-2 py-2.5 text-center"><div className="w-4 h-4 bg-zinc-800 rounded mx-auto" /></td>
                      <td className="px-2.5 py-2.5"><div className="h-4 bg-zinc-800 rounded w-24" /></td>
                      <td className="px-2.5 py-2.5"><div className="h-4 bg-zinc-800 rounded w-36" /></td>
                      <td className="px-2.5 py-2.5"><div className="h-4 bg-zinc-800 rounded w-16" /></td>
                      <td className="px-2.5 py-2.5"><div className="h-4 bg-zinc-800 rounded w-6 ml-auto" /></td>
                      <td className="px-2.5 py-2.5"><div className="h-4 bg-zinc-800 rounded w-12 ml-auto" /></td>
                      <td className="px-2.5 py-2.5"><div className="h-4 bg-zinc-800 rounded w-14 ml-auto" /></td>
                      <td className="px-2.5 py-2.5"><div className="h-4 bg-zinc-800 rounded w-20" /></td>
                      <td className="px-2.5 py-2.5"><div className="h-4 bg-zinc-800 rounded w-16" /></td>
                      <td className="px-2.5 py-2.5"></td>
                    </tr>
                  ))
                ) : filteredShipments.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="px-5 py-20 text-center">
                      <div className="flex flex-col items-center justify-center text-zinc-500">
                        <Package size={36} className="mb-3 text-zinc-600" />
                        <p className="text-sm font-bold text-zinc-400 mb-1">No Air Waybills found</p>
                        <p className="text-xs">Adjust your search or status filters to see results.</p>
                      </div>
                    </td>
                  </tr>
                ) : (
                  filteredShipments.map((s: any) => {
                    const isDrawerActive = selectedShipmentId === s.id;
                    const revenue = s.revenue || 0;

                    return (
                      <tr
                        key={s.id}
                        onClick={() => setSelectedShipmentId(s.id)}
                        className={`transition-colors cursor-pointer group hover:bg-zinc-800/50 ${
                          isDrawerActive ? 'bg-zinc-800' : ''
                        }`}
                      >
                        <td className="px-2.5 py-2.5 font-bold text-zinc-50 truncate max-w-[130px]">
                          <div className="flex items-center gap-1">
                            <Hash size={12} className="text-zinc-500 shrink-0" />
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
                            <span className="text-zinc-400 font-medium truncate block">{s.shipper_name || 'Unlinked Shipper'}</span>
                          )}
                        </td>

                        <td className="px-2.5 py-2.5 font-semibold text-zinc-300 whitespace-nowrap">
                          {s.export_country || 'NP'} → {s.import_country || 'US'}
                        </td>

                        <td className="px-2.5 py-2.5 text-right font-medium text-zinc-50 whitespace-nowrap">
                          {s.pieces || 1}
                        </td>

                        <td className="px-2.5 py-2.5 text-right font-bold text-zinc-50 whitespace-nowrap">
                          {fmtWeight(s)}
                        </td>

                        <td className={`px-2.5 py-2.5 text-right font-black whitespace-nowrap ${revenue === 0 ? 'text-zinc-600' : 'text-zinc-50'}`}>
                          {fmt$(revenue)}
                        </td>

                        <td className="px-2.5 py-2.5">
                          <StatusBadge status={s.match_status} />
                        </td>

                        <td className="px-2.5 py-2.5 text-zinc-500 font-medium whitespace-nowrap">
                          {fmtDate(s.created_at)}
                        </td>

                        <td className="px-2.5 py-2.5 text-right relative" onClick={(e) => e.stopPropagation()}>
                          <button
                            onClick={() => setShowRowMenuId(showRowMenuId === s.id ? null : s.id)}
                            className="p-1 text-zinc-500 hover:text-zinc-200 rounded-md hover:bg-zinc-800 transition-colors"
                          >
                            <MoreVertical size={16} />
                          </button>

                          {showRowMenuId === s.id && (
                            <div className="absolute right-4 top-10 w-44 bg-zinc-800 border border-zinc-700 rounded-xl shadow-xl z-30 py-1 text-left animate-in fade-in">
                              <button
                                onClick={() => { setSelectedShipmentId(s.id); setShowRowMenuId(null); }}
                                className="w-full px-3 py-1.5 text-xs font-semibold text-zinc-300 hover:bg-zinc-700 flex items-center gap-2"
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
          <div className="px-5 py-3 bg-zinc-800/50 border-t border-zinc-800 flex items-center justify-between text-xs font-medium text-zinc-400">
            <span>Showing <strong className="text-zinc-300">{filteredShipments.length}</strong> of <strong className="text-zinc-300">{totalCount}</strong> Air Waybills</span>

            <div className="flex items-center gap-2">
              <button
                disabled={page === 0}
                onClick={() => setPage(p => Math.max(0, p - 1))}
                className="px-3 py-1 bg-zinc-800 border border-zinc-700 rounded-md font-semibold text-zinc-300 hover:bg-zinc-700 disabled:opacity-40"
              >
                Previous
              </button>
              <button
                disabled={(page + 1) * 50 >= totalCount}
                onClick={() => setPage(p => p + 1)}
                className="px-3 py-1 bg-zinc-800 border border-zinc-700 rounded-md font-semibold text-zinc-300 hover:bg-zinc-700 disabled:opacity-40"
              >
                Next
              </button>
            </div>
          </div>
        </div>

      </div>

      {/* DETAIL DRAWER */}
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
        className="fixed inset-0 bg-zinc-950/60 backdrop-blur-xs z-40 transition-opacity"
      />

      {/* Drawer */}
      <div className="fixed inset-y-0 right-0 z-50 w-[540px] bg-zinc-900 border-l border-zinc-800 shadow-2xl flex flex-col animate-in slide-in-from-right duration-200">

        {/* Header */}
        <div className="px-6 py-4 border-b border-zinc-800 flex items-center justify-between bg-zinc-800/50 shrink-0">
          <div className="flex items-center gap-3">
            <button
              onClick={onClose}
              className="p-1 text-zinc-500 hover:text-zinc-200 rounded-md hover:bg-zinc-700 transition-colors"
            >
              <X size={18} />
            </button>
            <div>
              <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Air Waybill Record</span>
              <h2 className="text-base font-bold text-zinc-50">
                {isSLoading ? 'Loading...' : shipment?.shipment_number}
              </h2>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button className="p-2 text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 rounded-lg transition-colors" title="Copy AWB">
              <Copy size={15} />
            </button>
            <button className="p-2 text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 rounded-lg transition-colors" title="Print AWB">
              <Printer size={15} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">

          {isSLoading ? (
            <div className="space-y-4 animate-pulse">
              <div className="h-20 bg-zinc-800 rounded-xl" />
              <div className="h-40 bg-zinc-800 rounded-xl" />
            </div>
          ) : !shipment ? (
            <p className="text-sm text-zinc-500 text-center py-12">Shipment not found.</p>
          ) : (
            <>
              {/* ROUTING & CARRIER */}
              <div className="bg-zinc-800/50 border border-zinc-700 rounded-[14px] p-4 space-y-3">
                <h3 className="text-xs font-bold text-zinc-50 tracking-tight flex items-center gap-2">
                  <Globe size={14} className="text-primary" /> Routing & Carrier Information
                </h3>

                <div className="grid grid-cols-2 gap-3 text-xs">
                  {[
                    { label: 'Origin', value: shipment.export_country || 'Nepal (KTM)' },
                    { label: 'Destination', value: shipment.import_country || 'United States (JFK)' },
                    { label: 'Date', value: shipment.shipment_date || '—' },
                    { label: 'Weight', value: fmtWeight(shipment) },
                    { label: 'Pieces', value: shipment.pieces ?? '—' },
                    { label: 'Bill Type', value: shipment.bill_type || '—' },
                    { label: 'Pay Term', value: shipment.pay_term || '—' },
                  ].map(({ label, value }) => (
                    <div key={label} className="p-2.5 bg-zinc-800 rounded-lg">
                      <span className="text-[10px] font-bold text-zinc-500 uppercase">{label}</span>
                      <p className="font-bold text-zinc-50 mt-0.5">{value}</p>
                    </div>
                  ))}
                </div>
              </div>

              {/* CUSTOMER LINKAGE */}
              <div className="bg-zinc-800/50 border border-zinc-700 rounded-[14px] p-4 space-y-3">
                <h3 className="text-xs font-bold text-zinc-50 tracking-tight flex items-center gap-2">
                  <Building2 size={14} className="text-primary" /> Customer Account Linkage
                </h3>

                {shipment.company ? (
                  <div className="flex items-center justify-between p-3 bg-blue-500/10 border border-blue-500/20 rounded-xl">
                    <div>
                      <p className="font-bold text-zinc-50 text-xs">{shipment.company.company_name}</p>
                      <p className="text-[11px] font-mono text-zinc-400 mt-0.5">ICRIS: {shipment.company.icris_number}</p>
                    </div>
                    <button
                      onClick={() => navigate(`/app/customers/${shipment.company!.id}`)}
                      className="px-3 py-1.5 bg-zinc-800 border border-blue-500/30 text-primary font-bold text-xs rounded-lg hover:bg-primary/10 transition-colors"
                    >
                      View Profile
                    </button>
                  </div>
                ) : (
                  <div className="p-3 bg-zinc-800 border border-zinc-700 rounded-xl text-xs text-zinc-400">
                    <p className="font-semibold text-zinc-50">Unlinked Shipper</p>
                    <p className="text-[11px] text-zinc-500 mt-0.5">Shipper Name: {shipment.shipper_name || 'N/A'}</p>
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
