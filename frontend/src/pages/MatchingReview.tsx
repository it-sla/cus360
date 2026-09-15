import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type Shipment } from '../api';
import { Search, X, XCircle, AlertCircle, CheckCircle2 } from 'lucide-react';

export default function MatchingReview() {
  const queryClient = useQueryClient();
  const [selectedShipment, setSelectedShipment] = useState<any>(null);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [saveAsAlias, setSaveAsAlias] = useState(true);

  // Fetch shipments needing review
  const { data: shipments = [], isLoading } = useQuery({
    queryKey: ['matching-review'],
    queryFn: () => api.getMatchingReview()
  });

  // Fetch companies for search within drawer
  const { data: companiesResp } = useQuery({
    queryKey: ['companies', searchQuery],
    queryFn: () => api.getCompanies({ limit: 10, q: searchQuery }),
    enabled: isDrawerOpen
  });
  const companies = companiesResp?.items || [];

  const linkMutation = useMutation({
    mutationFn: ({ shipmentId, companyId }: { shipmentId: string, companyId: string }) => 
      api.linkMatching(shipmentId, companyId, saveAsAlias),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['matching-review'] });
      setIsDrawerOpen(false);
    }
  });

  const rejectMutation = useMutation({
    mutationFn: (shipmentId: string) => api.rejectMatching(shipmentId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['matching-review'] });
      setIsDrawerOpen(false);
    }
  });

  const handleRowClick = (shipment: Shipment) => {
    setSelectedShipment(shipment);
    setIsDrawerOpen(true);
    setSearchQuery(shipment.source_company_name || '');
  };

  return (
    <div className="flex-1 flex flex-col h-full bg-background">
      <div className="p-6 pb-4 border-b border-slate-200 bg-white">
        <h1 className="text-2xl font-bold text-slate-900 tracking-tight">Matching Review</h1>
        <p className="text-sm text-slate-500 font-medium mt-1">
          Review and resolve shipments with ambiguous or missing ICRIS identities.
        </p>
      </div>

      <div className="flex-1 overflow-auto p-6">
        <div className="bg-white border border-slate-200 rounded-lg shadow-sm">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
              <tr>
                <th className="px-4 py-3 font-semibold uppercase text-xs tracking-wider">Source Date</th>
                <th className="px-4 py-3 font-semibold uppercase text-xs tracking-wider">Tracking / AWB</th>
                <th className="px-4 py-3 font-semibold uppercase text-xs tracking-wider">Raw Shipper Name</th>
                <th className="px-4 py-3 font-semibold uppercase text-xs tracking-wider">Provided ICRIS</th>
                <th className="px-4 py-3 font-semibold uppercase text-xs tracking-wider">Match Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {isLoading ? (
                <tr><td colSpan={5} className="p-8 text-center text-slate-400">Loading queue...</td></tr>
              ) : shipments.length > 0 ? shipments.map((s) => (
                <tr 
                  key={s.id} 
                  onClick={() => handleRowClick(s)}
                  className="hover:bg-slate-50 cursor-pointer transition-colors"
                >
                  <td className="px-4 py-3 whitespace-nowrap text-slate-500">{s.shipment_date || '-'}</td>
                  <td className="px-4 py-3 whitespace-nowrap font-medium text-slate-900">{s.shipment_number || '-'}</td>
                  <td className="px-4 py-3 text-slate-700">{s.source_company_name || <span className="italic text-slate-400">Empty</span>}</td>
                  <td className="px-4 py-3 text-slate-700 font-mono text-xs">{s.source_icris_number || '-'}</td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    {s.match_status === 'suggested' && <span className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-bold bg-amber-50 text-amber-700 border border-amber-200"><AlertCircle size={12}/> SUGGESTED</span>}
                    {s.match_status === 'unmatched' && <span className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-bold bg-rose-50 text-rose-700 border border-rose-200"><XCircle size={12}/> UNMATCHED</span>}
                  </td>
                </tr>
              )) : (
                <tr>
                  <td colSpan={5} className="p-12 text-center text-slate-500">
                    <CheckCircle2 size={32} className="mx-auto mb-3 text-emerald-400" />
                    <div className="font-semibold text-slate-900">Inbox Zero</div>
                    <div className="text-sm mt-1">All shipments have been successfully matched.</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Slide-over Drawer */}
      {isDrawerOpen && (
        <>
          <div className="fixed inset-0 bg-black/20 z-40" onClick={() => setIsDrawerOpen(false)} />
          <div className="fixed top-0 right-0 h-full w-[450px] bg-white border-l border-slate-200 shadow-xl z-50 flex flex-col animate-in slide-in-from-right">
            {/* Drawer Header */}
            <div className="flex items-center justify-between p-4 border-b border-slate-200">
              <h2 className="text-sm font-bold text-slate-900 uppercase tracking-wider">Resolve Identity Match</h2>
              <button onClick={() => setIsDrawerOpen(false)} className="p-1 rounded hover:bg-slate-100 text-slate-400"><X size={18} /></button>
            </div>

            {selectedShipment && (
              <div className="flex flex-col flex-1 overflow-hidden">
                <div className="p-5 border-b border-slate-200 bg-slate-50">
                  <div className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">Source Record</div>
                  <div className="font-medium text-slate-900">{selectedShipment.source_company_name || 'No Name Provided'}</div>
                  <div className="text-sm text-slate-500 font-mono mt-1">ICRIS: {selectedShipment.source_icris_number || 'Missing'}</div>
                  <div className="text-xs text-slate-400 mt-2">AWB: {selectedShipment.shipment_number}</div>
                </div>

                <div className="p-5 flex-1 overflow-auto">
                  <div className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-3">Search & Link Company</div>
                  
                  <div className="relative mb-4">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
                    <input 
                      type="text" 
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Search by exact ICRIS or Name..."
                      className="w-full pl-9 pr-4 py-2 border border-slate-200 rounded-md text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
                    />
                  </div>

                  <div className="space-y-2">
                    {companies.length > 0 ? companies.map((company: any) => (
                      <div key={company.company_id} className="border border-slate-200 rounded-md p-3 bg-white hover:border-teal-300 transition-colors">
                        <div className="flex justify-between items-start">
                          <div>
                            <div className="font-bold text-slate-900 text-sm">{company.company_name}</div>
                            <div className="text-xs text-slate-500 font-mono mt-0.5">{company.icris_number}</div>
                          </div>
                          <button 
                            onClick={() => linkMutation.mutate({ shipmentId: selectedShipment.id, companyId: company.company_id })}
                            disabled={linkMutation.isPending}
                            className="bg-teal-50 hover:bg-teal-100 text-teal-700 border border-teal-200 px-3 py-1 rounded text-xs font-bold transition-colors"
                          >
                            Link
                          </button>
                        </div>
                      </div>
                    )) : (
                      <div className="text-center py-6 text-slate-500 text-sm">No companies found.</div>
                    )}
                  </div>
                </div>

                <div className="p-5 border-t border-slate-200 bg-white">
                  <label className="flex items-center gap-2 mb-4 text-sm text-slate-700 cursor-pointer">
                    <input 
                      type="checkbox" 
                      checked={saveAsAlias}
                      onChange={(e) => setSaveAsAlias(e.target.checked)}
                      className="rounded border-slate-300 text-teal-600 focus:ring-teal-500"
                    />
                    Save raw name as an alias for future auto-matching
                  </label>

                  {selectedShipment.match_status === 'suggested' && (
                    <button 
                      onClick={() => rejectMutation.mutate(selectedShipment.id)}
                      disabled={rejectMutation.isPending}
                      className="w-full py-2.5 border border-rose-200 bg-rose-50 hover:bg-rose-100 text-rose-700 rounded-md text-sm font-bold transition-colors"
                    >
                      Reject Suggestion (Keep Unmatched)
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
