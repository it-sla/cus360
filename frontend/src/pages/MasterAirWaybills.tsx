import { useState, useEffect, useMemo } from 'react';
import {
  Search, RefreshCw, MapPin,
  Activity, X, ChevronLeft, ChevronRight, FileText, ArrowRight, Building2,
  PlaneTakeoff, Plane, Weight, AlertTriangle, Users, DollarSign, Hash, TrendingUp, TrendingDown
} from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ShipmentDetailDrawer } from './AirWaybills';
import { DateRangeControl, resolveTimeframeDates } from '@/components/AnalyticsFilterBar';

function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value);
  useEffect(() => {
    const handler = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(handler);
  }, [value, delay]);
  return debouncedValue;
}

function fmtDate(d: string | null) {
  if (!d) return '-';
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmt$(v: number) { return `$${(v || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
function fmtWeight(v: number) { return v >= 1000 ? `${(v / 1000).toFixed(1)} t` : `${(v || 0).toLocaleString()} kg`; }

// The handful of airlines actually flown — matched against flight_number by IATA
// designator prefix (e.g. "CX640" matches "CX"). Ordered by real usage volume.
const AIRLINES = [
  { code: 'G9', label: 'Air Arabia (G9)' },
  { code: 'KA', label: 'Cathay Dragon (KA)' },
  { code: 'RA', label: 'Nepal Airlines (RA)' },
  { code: 'FZ', label: 'flydubai (FZ)' },
  { code: 'TG', label: 'Thai Airways (TG)' },
  { code: 'CX', label: 'Cathay Pacific Cargo (CX)' },
];

const PAY_TERM_LABELS: Record<string, string> = {
  PP: 'Prepaid', FC: 'Freight Collect', FD: 'Free Domicile', NON_REV: 'Non-Revenue', RTS: 'Return to Shipper', OTHER: 'Unclassified',
};

const HAWB_STATUS: Record<string, { label: string; cls: string }> = {
  matched:       { label: 'Matched',       cls: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/20 dark:text-emerald-400 dark:border-emerald-800/50' },
  suggested:     { label: 'Suggested',     cls: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/20 dark:text-amber-400 dark:border-amber-800/50' },
  unmatched:     { label: 'Unmatched',     cls: 'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700' },
  invalid_icris: { label: 'Invalid ICRIS', cls: 'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-900/20 dark:text-rose-400 dark:border-rose-800/50' },
};

function HawbStatusBadge({ status }: { status: string | null }) {
  const conf = HAWB_STATUS[status || 'unmatched'] || HAWB_STATUS.unmatched;
  return <span className={`inline-block px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wide border ${conf.cls}`}>{conf.label}</span>;
}

/** Why a HAWB isn't linked to a customer, stated with the actual offending value from the
 *  manifest. "Invalid ICRIS" alone doesn't tell a reviewer what to go fix in the CRM. */
function linkageDetail(s: any): { text: string; tone: string } | null {
  if (s.company_id) return null;
  const raw = (s.source_icris_number || '').trim();
  // Operators fill the CRM's ICRIS column with placeholders ('.', '-', '/') far more often
  // than they leave it empty. Anything with no alphanumeric character is "not supplied" —
  // but keep showing the literal value, since that is what has to be corrected in the CRM.
  const placeholder = !raw || !/[a-z0-9]/i.test(raw);
  const tone = s.match_status === 'invalid_icris' ? 'text-rose-600 dark:text-rose-400' : 'text-amber-600 dark:text-amber-400';
  if (placeholder) {
    return { text: raw ? `No ICRIS — manifest has "${raw}"` : 'No ICRIS on manifest row', tone };
  }
  return { text: `ICRIS "${raw}" matches no customer`, tone };
}

export default function MasterAirWaybills() {
  const [urlParams] = useSearchParams();
  const [searchQuery, setSearchQuery] = useState(() => urlParams.get('search') || '');
  const [filters, setFilters] = useState({
    flight_number: '',
    manifest_date_from: '',
    manifest_date_to: ''
  });
  const [page, setPage] = useState(0);
  const [selectedMawbId, setSelectedMawbId] = useState<string | null>(() => urlParams.get('mawb') || null);
  // True when this manifest was opened via a deep link (e.g. from Data Quality) rather than by
  // clicking a row in this page's own list — closing the drawer should then return the user to
  // wherever they came from instead of stranding them on the MAWB list.
  const [openedViaDeepLink] = useState(() => !!urlParams.get('mawb'));
  const navigate = useNavigate();

  const debouncedSearch = useDebounce(searchQuery, 400);

  const [dateRange, setDateRange] = useState('all_time');
  const currentRange = resolveTimeframeDates(dateRange, filters.manifest_date_from, filters.manifest_date_to);

  const queryParams = {
    q: debouncedSearch || undefined,
    flight_number: filters.flight_number || undefined,
    manifest_date_from: currentRange.from,
    manifest_date_to: currentRange.to,
    limit: 50,
    offset: page * 50
  };

  useEffect(() => {
    setPage(0);
  }, [debouncedSearch, filters.flight_number, dateRange, filters.manifest_date_from, filters.manifest_date_to]);

  // Deep-link support: /app/mawb?mawb={id} opens the drawer directly, ?search={text} pre-fills the search box.
  useEffect(() => {
    const mawbId = urlParams.get('mawb');
    if (mawbId) setSelectedMawbId(mawbId);
    const q = urlParams.get('search');
    if (q) setSearchQuery(q);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlParams]);

  const { data: mawbsData, isLoading: isLoadingMawbs } = useQuery({
    queryKey: ['mawbs', queryParams],
    queryFn: () => api.getMawbs(queryParams)
  });

  const mawbs = mawbsData?.items || [];
  const totalCount = mawbsData?.total ?? mawbs.length;

  return (
    <div className="flex-1 overflow-hidden flex flex-col bg-background">
      
      {/* Header */}
      <div className="shrink-0 bg-white dark:bg-slate-900/50 border-b border-slate-200 dark:border-slate-800 px-6 py-4 flex items-center justify-between z-10">
        <div className="flex items-center gap-2.5">
          <Plane size={18} strokeWidth={2.5} className="text-slate-900 dark:text-slate-100" />
          <div>
            <h1 className="text-lg font-bold text-slate-900 dark:text-slate-100 leading-tight">Master AWBs</h1>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 font-medium">Consolidated air waybills and carrier manifests.</p>
          </div>
        </div>
      </div>

      {/* Filter Toolbar */}
      <div className="shrink-0 bg-white dark:bg-slate-900/50 border-b border-slate-200 dark:border-slate-800 px-6 py-2.5 flex items-center gap-3 z-10">
        <div className="relative w-64">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-400" size={14} />
          <input 
            type="text" 
            placeholder="Search MAWB Number..." 
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full h-8 pl-8 pr-3 bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-800 rounded text-xs font-medium text-slate-900 dark:text-slate-100 outline-none focus:border-blue-500 focus:bg-white dark:bg-slate-900/50 transition-colors placeholder:font-normal placeholder:text-slate-400 dark:text-slate-400"
          />
        </div>
        
        <div className="w-px h-4 bg-slate-200 dark:bg-slate-700 mx-1"></div>

        <div className="relative">
          <PlaneTakeoff size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none z-10" />
          <select
            value={filters.flight_number}
            onChange={e => setFilters(f => ({ ...f, flight_number: e.target.value }))}
            className="h-8 pl-7 pr-6 bg-white dark:bg-slate-900/50 border border-slate-200 dark:border-slate-800 rounded text-xs font-medium text-slate-800 dark:text-slate-200 outline-none hover:bg-slate-50 dark:hover:bg-slate-800/50 cursor-pointer appearance-none shadow-sm"
          >
            <option value="">All Airlines</option>
            {AIRLINES.map(a => <option key={a.code} value={a.code}>{a.label}</option>)}
          </select>
        </div>

        <div className="w-px h-4 bg-slate-200 dark:bg-slate-700 mx-1"></div>

        <DateRangeControl
          timeframe={dateRange}
          dateFrom={filters.manifest_date_from}
          dateTo={filters.manifest_date_to}
          bounds={currentRange.from && currentRange.to ? { c_start: currentRange.from, c_end: currentRange.to } : undefined}
          onPreset={v => setDateRange(v)}
          onCustom={(from, to) => { setDateRange('custom'); setFilters(f => ({ ...f, manifest_date_from: from, manifest_date_to: to })); }}
          defaultPreset="all_time"
        />

      </div>

      {/* Main Content Area */}
      <div className="flex-1 flex overflow-hidden relative">
        
        {/* Table View */}
        <div className="flex-1 flex flex-col overflow-hidden min-w-[600px]">
          <div className="flex-1 overflow-auto bg-white dark:bg-slate-900/50">
            <table className="w-full text-left border-collapse">
              <thead className="sticky top-0 bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-800 z-10">
                <tr>
                  <th className="px-4 py-2.5 text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider whitespace-nowrap">MAWB Number</th>
                  <th className="px-4 py-2.5 text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider whitespace-nowrap">Manifest Date</th>
                  <th className="px-4 py-2.5 text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider whitespace-nowrap">Flight</th>
                  <th className="px-4 py-2.5 text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider whitespace-nowrap">Route</th>
                  <th className="px-4 py-2.5 text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider whitespace-nowrap text-right">Shipments</th>
                  <th className="px-4 py-2.5 text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider whitespace-nowrap text-right">Packages</th>
                  <th className="px-4 py-2.5 text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider whitespace-nowrap text-right">Weight</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/50">
                {isLoadingMawbs ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-12 text-center text-sm text-slate-500 dark:text-slate-400">
                      <div className="flex items-center justify-center gap-2">
                        <RefreshCw className="animate-spin text-slate-400 dark:text-slate-400" size={16} /> Loading master waybills...
                      </div>
                    </td>
                  </tr>
                ) : mawbs.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-12 text-center text-sm text-slate-500 dark:text-slate-400">
                      No master waybills found matching your filters.
                    </td>
                  </tr>
                ) : (
                  mawbs.map((m: any) => (
                    <tr
                      key={m.id}
                      onClick={() => setSelectedMawbId(m.id)}
                      className={`group cursor-pointer transition-colors ${selectedMawbId === m.id ? 'bg-slate-100 dark:bg-slate-800' : ''}`}
                    >
                      <td className="px-4 py-2 whitespace-nowrap">
                        <div className="flex items-center gap-2">
                          <PlaneTakeoff size={13} className={selectedMawbId === m.id ? 'text-blue-500' : 'text-slate-300'} />
                          <span className="text-xs font-semibold text-slate-900 dark:text-slate-100">{m.mawb_number}</span>
                        </div>
                      </td>
                      <td className="px-4 py-2 whitespace-nowrap text-xs text-slate-600 dark:text-slate-300">{fmtDate(m.manifest_date)}</td>
                      <td className="px-4 py-2 whitespace-nowrap text-xs font-medium text-slate-700 dark:text-slate-200">{m.flight_number || '-'}</td>
                      <td className="px-4 py-2 whitespace-nowrap text-xs text-slate-600 dark:text-slate-300">
                        {m.origin || '?'} <ArrowRight size={10} className="inline mx-1 text-slate-400 dark:text-slate-400" /> {m.destination || '?'}
                      </td>
                      <td className="px-4 py-2 whitespace-nowrap text-xs font-medium text-slate-700 dark:text-slate-200 text-right">{m.shipment_count || 0}</td>
                      <td className="px-4 py-2 whitespace-nowrap text-xs text-slate-600 dark:text-slate-300 text-right">{m.row_pieces || 0}</td>
                      <td className="px-4 py-2 whitespace-nowrap text-xs font-medium text-slate-900 dark:text-slate-100 text-right">
                        {m.row_actual_weight ? Number(m.row_actual_weight).toLocaleString(undefined, {minimumFractionDigits: 1, maximumFractionDigits: 1}) : '-'} kg
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          <div className="shrink-0 bg-white dark:bg-slate-900/50 border-t border-slate-200 dark:border-slate-800 px-4 py-2.5 flex items-center justify-between">
            <div className="text-xs text-slate-500 dark:text-slate-400">
              Showing {mawbs.length > 0 ? page * 50 + 1 : 0} to {page * 50 + mawbs.length} of {totalCount}
            </div>
            <div className="flex gap-1">
              <button
                onClick={() => setPage(p => Math.max(0, p - 1))}
                disabled={page === 0}
                className="w-8 h-8 flex items-center justify-center rounded border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800/50 disabled:opacity-50 disabled:bg-slate-50 dark:disabled:bg-slate-800/50"
              >
                <ChevronLeft size={14} />
              </button>
              <button
                onClick={() => setPage(p => p + 1)}
                disabled={(page + 1) * 50 >= totalCount}
                className="w-8 h-8 flex items-center justify-center rounded border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800/50 disabled:opacity-50 disabled:bg-slate-50 dark:disabled:bg-slate-800/50"
              >
                <ChevronRight size={14} />
              </button>
            </div>
          </div>
        </div>

      </div>
      
      {/* Right Detail Drawer */}
      {selectedMawbId && (
        <>
          <div
            onClick={() => openedViaDeepLink ? navigate(-1) : setSelectedMawbId(null)}
            className="fixed inset-0 bg-slate-900/30 backdrop-blur-xs z-40 transition-opacity"
          />
          <div className="fixed inset-y-0 right-0 z-50 w-[540px] bg-white dark:bg-slate-900/50 border-l border-slate-200 dark:border-slate-800 flex flex-col shadow-2xl animate-in slide-in-from-right duration-200">
            <MawbDetailDrawer
              mawbId={selectedMawbId}
              onClose={() => openedViaDeepLink ? navigate(-1) : setSelectedMawbId(null)}
            />
          </div>
        </>
      )}

    </div>
  );
}

function MawbDetailDrawer({ mawbId, onClose }: { mawbId: string, onClose: () => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [selectedHawbId, setSelectedHawbId] = useState<string | null>(null);
  const [hawbSearch, setHawbSearch] = useState('');
  const [recheckStatus, setRecheckStatus] = useState<{ state: 'running' | 'done' | 'error'; message: string } | null>(null);

  const { data: mawb, isLoading } = useQuery({
    queryKey: ['mawb-detail', mawbId],
    queryFn: () => api.getMawbDetail(mawbId)
  });

  // Re-fetches this manifest live from the CRM — for rows the CRM has since corrected (e.g. an
  // ICRIS filled in after the fact). The scheduled sync only revisits manifests inside a 7-day
  // lookback window and skips unchanged pages by checksum, so a correction made to an old
  // manifest is otherwise never picked up automatically.
  const handleRecheck = async () => {
    const recordId = Number(mawb?.crm_manifest_id);
    if (!recordId) { setRecheckStatus({ state: 'error', message: 'This manifest has no CRM record ID on file — cannot re-check.' }); return; }
    setRecheckStatus({ state: 'running', message: 'Re-checking against the CRM…' });
    try {
      const run = await api.recheckManifest(recordId);
      for (let attempt = 0; attempt < 15; attempt++) {
        await new Promise((r) => setTimeout(r, 2000));
        const polled = await api.getSyncRun(run.id);
        const item = polled.items?.[0];
        if (!item) continue;
        if (item.status === 'succeeded' || item.status === 'succeeded_with_warnings') {
          queryClient.invalidateQueries({ queryKey: ['mawb-detail', mawbId] });
          queryClient.invalidateQueries({ queryKey: ['mawbs'] });
          const updated = item.updated_shipment_count || 0;
          const linked = item.linked_company_count || 0;
          const stillBlank = item.blank_icris_count || 0;
          // linked_company_count is every row matched in this pass, not just ones that changed —
          // most were likely already matched before. Phrase it as a snapshot, not a delta.
          setRecheckStatus({ state: 'done', message: `Done — refreshed ${updated} row${updated === 1 ? '' : 's'} from the CRM: ${linked} linked to a customer${stillBlank ? `, ${stillBlank} still missing ICRIS on the CRM` : ''}.` });
          return;
        }
        if (item.status === 'quarantined') {
          setRecheckStatus({ state: 'error', message: item.last_error_summary || 'Re-check failed.' });
          return;
        }
      }
      setRecheckStatus({ state: 'error', message: 'Still processing — check the CRM Sync page for status.' });
    } catch (err: any) {
      setRecheckStatus({ state: 'error', message: err?.response?.data?.detail || 'Re-check failed to start.' });
    }
  };

  const filteredShipments = useMemo(() => {
    const list = mawb?.shipments || [];
    if (!hawbSearch.trim()) return list;
    const q = hawbSearch.trim().toLowerCase();
    return list.filter((s: any) =>
      s.shipment_number?.toLowerCase().includes(q) ||
      s.shipper_name?.toLowerCase().includes(q) ||
      s.importer_name?.toLowerCase().includes(q) ||
      s.import_country?.toLowerCase().includes(q)
    );
  }, [mawb, hawbSearch]);

  const totalRevenue = useMemo(() => (mawb?.shipments || []).reduce((sum: number, s: any) => sum + (s.revenue || 0), 0), [mawb]);
  const missingIcris = mawb?.missing_icris_count || 0;

  if (isLoading) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-slate-400 dark:text-slate-400 space-y-3">
        <RefreshCw className="animate-spin" size={24} />
        <span className="text-xs font-medium">Loading details...</span>
      </div>
    );
  }

  if (!mawb) return null;

  return (
    <>
      <div className="shrink-0 px-6 py-5 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50 flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="px-1.5 py-0.5 rounded bg-blue-100 text-blue-800 text-[10px] font-bold tracking-widest uppercase">MAWB</span>
            <span className="text-xs font-medium text-slate-500 dark:text-slate-400">{fmtDate(mawb.manifest_date)}</span>
            {mawb.manifest_direction && (
              <span className="px-1.5 py-0.5 rounded bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300 text-[9px] font-bold uppercase tracking-wide">{mawb.manifest_direction}</span>
            )}
          </div>
          <h2 className="text-xl font-black text-slate-900 dark:text-slate-100 font-mono tracking-tight">{mawb.mawb_number}</h2>
          <p className="text-xs font-medium text-slate-600 dark:text-slate-300 mt-1">{mawb.carrier_name}</p>
        </div>
        <div className="flex items-center gap-2">
          {mawb.crm_manifest_id && (
            <button
              onClick={handleRecheck}
              disabled={recheckStatus?.state === 'running'}
              title="Re-fetch this manifest live from the CRM — picks up corrections made to the CRM after the original sync, like an ICRIS filled in later"
              className="h-8 px-2.5 flex items-center gap-1.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 rounded-md text-xs font-semibold hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50 transition-colors"
            >
              <RefreshCw size={13} className={recheckStatus?.state === 'running' ? 'animate-spin' : ''} />
              {recheckStatus?.state === 'running' ? 'Re-checking…' : 'Re-check CRM'}
            </button>
          )}
          <button onClick={onClose} className="p-1.5 text-slate-400 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700 hover:text-slate-700 dark:text-slate-200 rounded-md transition-colors">
            <X size={16} />
          </button>
        </div>
      </div>

      {recheckStatus && recheckStatus.state !== 'running' && (
        <div className={`shrink-0 px-6 py-2 text-xs font-semibold border-b ${
          recheckStatus.state === 'done'
            ? 'bg-emerald-50 dark:bg-emerald-900/20 border-emerald-200 dark:border-emerald-800/50 text-emerald-700 dark:text-emerald-400'
            : 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800/50 text-amber-700 dark:text-amber-400'
        }`}>
          {recheckStatus.message}
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        <div className="p-6 space-y-6">

          <div className="grid grid-cols-2 gap-4">
            <div className="p-3 bg-white dark:bg-slate-900/50 border border-slate-200 dark:border-slate-800 rounded shadow-sm">
              <div className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1 flex items-center gap-1"><MapPin size={11} /> Routing</div>
              <div className="text-sm font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
                {mawb.origin || '?'} <ArrowRight size={12} className="text-slate-400 dark:text-slate-400" /> {mawb.destination || '?'}
              </div>
              <div className="text-xs text-slate-500 dark:text-slate-400 mt-1 font-medium">Flight: {mawb.flight_number || 'N/A'}</div>
            </div>
            <div className="p-3 bg-white dark:bg-slate-900/50 border border-slate-200 dark:border-slate-800 rounded shadow-sm">
              <div className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1 flex items-center gap-1"><Weight size={11} /> Total Weight</div>
              <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">{fmtWeight(mawb.row_actual_weight || 0)}</div>
              <div className="text-xs text-slate-500 dark:text-slate-400 mt-1 font-medium">{mawb.shipment_count} HAWBs • {mawb.row_pieces} Pkgs</div>
            </div>
            <div className="p-3 bg-white dark:bg-slate-900/50 border border-slate-200 dark:border-slate-800 rounded shadow-sm">
              <div className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1 flex items-center gap-1"><DollarSign size={11} /> Billable Revenue</div>
              <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">{fmt$(totalRevenue)}</div>
              <div className="text-xs text-slate-500 dark:text-slate-400 mt-1 font-medium">Prepaid + Freight Collect + Free Domicile</div>
            </div>
            <div className="p-3 bg-white dark:bg-slate-900/50 border border-slate-200 dark:border-slate-800 rounded shadow-sm">
              <div className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1 flex items-center gap-1"><Users size={11} /> Customers</div>
              <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">{mawb.customer_count ?? '—'} linked</div>
              {missingIcris > 0 && (
                <div className="text-xs text-amber-600 dark:text-amber-400 mt-1 font-semibold flex items-center gap-1">
                  <AlertTriangle size={11} /> {missingIcris} missing ICRIS
                </div>
              )}
            </div>
          </div>

          <div>
            <h3 className="text-xs font-bold text-slate-900 dark:text-slate-100 uppercase tracking-wider mb-3 flex items-center gap-2">
              <Activity size={14} className="text-blue-500" /> Billing Breakdown
            </h3>
            <div className="border border-slate-200 dark:border-slate-800 rounded overflow-hidden">
              <table className="w-full text-left">
                <thead className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-800">
                  <tr>
                    <th className="px-3 py-2 text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase">Pay Term</th>
                    <th className="px-3 py-2 text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase text-right">Shipments</th>
                    <th className="px-3 py-2 text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase text-right">Weight</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800/50 text-xs">
                  {Object.entries(mawb.billing_breakdown || {}).map(([type, data]: [string, any]) => (
                    data.count > 0 && (
                      <tr key={type}>
                        <td className="px-3 py-2 font-semibold text-slate-700 dark:text-slate-200">{PAY_TERM_LABELS[type] || type}</td>
                        <td className="px-3 py-2 text-slate-600 dark:text-slate-300 text-right">{data.count}</td>
                        <td className="px-3 py-2 text-slate-900 dark:text-slate-100 font-medium text-right">{fmtWeight(data.weight)}</td>
                      </tr>
                    )
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {mawb.pnl_synced_at && (
            <div>
              <h3 className="text-xs font-bold text-slate-900 dark:text-slate-100 uppercase tracking-wider mb-3 flex items-center gap-2">
                {(mawb.pnl_profit_loss ?? 0) >= 0 ? <TrendingUp size={14} className="text-emerald-500" /> : <TrendingDown size={14} className="text-red-500" />} UPS Profit / Loss
              </h3>
              <div className="grid grid-cols-3 gap-4">
                <div className="p-3 bg-white dark:bg-slate-900/50 border border-slate-200 dark:border-slate-800 rounded shadow-sm">
                  <div className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1">Bill Amount</div>
                  <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">{fmt$(mawb.pnl_bill_amount || 0)}</div>
                </div>
                <div className="p-3 bg-white dark:bg-slate-900/50 border border-slate-200 dark:border-slate-800 rounded shadow-sm">
                  <div className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1">UPS Bill Amount</div>
                  <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">{fmt$(mawb.pnl_ups_bill_amount || 0)}</div>
                </div>
                <div className="p-3 bg-white dark:bg-slate-900/50 border border-slate-200 dark:border-slate-800 rounded shadow-sm">
                  <div className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1">Profit / Loss</div>
                  <div className={`text-sm font-semibold ${(mawb.pnl_profit_loss ?? 0) >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>{fmt$(mawb.pnl_profit_loss || 0)}</div>
                </div>
              </div>
              <div className="text-[10px] text-slate-400 dark:text-slate-500 mt-2 font-medium">Synced {fmtDate(mawb.pnl_synced_at)}</div>
            </div>
          )}

          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-xs font-bold text-slate-900 dark:text-slate-100 uppercase tracking-wider flex items-center gap-2">
                <FileText size={14} className="text-blue-500" /> House Air Waybills
                <span className="text-slate-400 dark:text-slate-500 font-medium normal-case tracking-normal">({filteredShipments.length} of {mawb.shipments?.length || 0})</span>
              </h3>
            </div>
            <div className="relative mb-3">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                value={hawbSearch}
                onChange={e => setHawbSearch(e.target.value)}
                placeholder="Search HAWB, shipper, consignee, destination..."
                className="w-full h-8 pl-8 pr-3 bg-white dark:bg-slate-900/50 border border-slate-200 dark:border-slate-800 rounded-lg text-xs text-slate-800 dark:text-slate-200 outline-none focus:border-primary"
              />
            </div>
            <div className="border border-slate-200 dark:border-slate-800 rounded overflow-hidden shadow-sm">
              <table className="w-full text-left">
                <thead className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-800">
                  <tr>
                    <th className="px-3 py-2 text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase">HAWB</th>
                    <th className="px-3 py-2 text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase">Shipper / Consignee</th>
                    <th className="px-3 py-2 text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase">Dest</th>
                    <th className="px-3 py-2 text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase text-right">Pcs</th>
                    <th className="px-3 py-2 text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase text-right">Weight</th>
                    <th className="px-3 py-2 text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase text-right">Revenue</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800/50 text-xs">
                  {filteredShipments.map((s: any) => (
                    <tr key={s.id} className="group">
                      <td className="px-3 py-2">
                        <div className="font-semibold text-blue-600 dark:text-blue-400 cursor-pointer hover:underline flex items-center gap-1" onClick={() => setSelectedHawbId(s.id)}>
                          <Hash size={10} className="shrink-0" />{s.shipment_number}
                        </div>
                        <div className="mt-1 flex items-center gap-1.5">
                          <HawbStatusBadge status={s.match_status} />
                          <span className="text-[9px] text-slate-400 dark:text-slate-500 uppercase">{s.bill_type || 'Unknown'}</span>
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <div className="text-slate-800 dark:text-slate-200 font-medium truncate max-w-[140px]" title={s.shipper_name}>{s.shipper_name || '—'}</div>
                        <div className="text-[10px] text-slate-400 dark:text-slate-500 truncate max-w-[140px]" title={s.importer_name}>→ {s.importer_name || '—'}</div>
                        {s.company_id ? (
                          <div
                            className="text-[10px] text-teal-600 font-semibold cursor-pointer hover:underline mt-0.5 flex items-center gap-1"
                            onClick={() => navigate(`/app/customers/${s.company_id}`)}
                          >
                            <Building2 size={10} /> {s.company?.icris_number} · {s.company?.company_name}
                          </div>
                        ) : (() => {
                          const d = linkageDetail(s);
                          return d ? (
                            <div className={`text-[10px] font-semibold mt-0.5 flex items-center gap-1 ${d.tone}`} title={`Manifest name: ${s.source_customer_name || '—'}`}>
                              <AlertTriangle size={10} className="shrink-0" /> {d.text}
                            </div>
                          ) : null;
                        })()}
                      </td>
                      <td className="px-3 py-2 text-slate-600 dark:text-slate-300 font-medium whitespace-nowrap">{s.import_country || '—'}</td>
                      <td className="px-3 py-2 text-right text-slate-700 dark:text-slate-300">{s.pieces || 1}</td>
                      <td className="px-3 py-2 text-right text-slate-900 dark:text-slate-100 font-medium whitespace-nowrap">
                        {s.weight ? fmtWeight(s.weight) : '—'}
                      </td>
                      <td className="px-3 py-2 text-right font-medium whitespace-nowrap">
                        {s.revenue > 0 ? <span className="text-emerald-600 dark:text-emerald-400">{fmt$(s.revenue)}</span> : <span className="text-slate-400 dark:text-slate-500">—</span>}
                      </td>
                    </tr>
                  ))}
                  {filteredShipments.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-3 py-6 text-center text-slate-400 dark:text-slate-400 italic">
                        {hawbSearch ? 'No HAWBs match your search' : 'No shipments attached'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

        </div>
      </div>

      {selectedHawbId && (
        <ShipmentDetailDrawer
          shipmentId={selectedHawbId}
          onClose={() => setSelectedHawbId(null)}
          navigate={navigate}
        />
      )}
    </>
  );
}
