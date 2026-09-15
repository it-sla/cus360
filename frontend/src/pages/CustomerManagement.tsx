import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api';
import type { CompanySummary } from '@/api';
import { Building2, Plus, Pencil, Trash2, X, Search, ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react';

const PAGE_SIZE = 25;

const STATUS_OPTIONS = ['active', 'prospect', 'vip', 'inactive', 'blocked', 'archived'];
// Rule-driven now — see docs/customer-segmentation-rules.md. Manual edits here are
// legitimate (e.g. a one-off pin) but will be overwritten the next time an admin runs
// "Recompute Segments", since that recompute has no manual-override exemption.
const CUSTOMER_TYPE_OPTIONS = ['Key Account', 'Reseller', 'Large Account', 'SME', 'Small Customer'];

interface FormState {
  icris_number: string;
  company_name: string;
  legal_name: string;
  phone: string;
  email: string;
  address: string;
  pan_vat_number: string;
  customer_type: string;
  status: string;
  notes: string;
}

const EMPTY_FORM: FormState = {
  icris_number: '', company_name: '', legal_name: '', phone: '', email: '',
  address: '', pan_vat_number: '', customer_type: '', status: 'active', notes: '',
};

export default function CustomerManagement() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [modal, setModal] = useState<{ mode: 'add' | 'edit'; id?: string } | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [deleteTarget, setDeleteTarget] = useState<CompanySummary | null>(null);
  const [formError, setFormError] = useState('');

  const listQuery = useQuery({
    queryKey: ['companies', 'management', search, page],
    queryFn: () => api.getCompanies({ q: search || undefined, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
  });

  const items = listQuery.data?.items ?? [];
  const total = listQuery.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const openAdd = () => { setForm(EMPTY_FORM); setFormError(''); setModal({ mode: 'add' }); };

  const openEdit = async (row: CompanySummary) => {
    setFormError('');
    setModal({ mode: 'edit', id: row.company_id });
    const detail = await api.getCompany(row.company_id);
    setForm({
      icris_number: detail.icris_number ?? '', company_name: detail.company_name, legal_name: detail.legal_name ?? '',
      phone: detail.phone ?? '', email: detail.email ?? '', address: detail.address ?? '', pan_vat_number: detail.pan_vat_number ?? '',
      customer_type: detail.customer_type ?? '', status: detail.status, notes: detail.notes ?? '',
    });
  };

  const createMutation = useMutation({
    mutationFn: () => api.createCompany({
      icris_number: form.icris_number.trim(), company_name: form.company_name.trim(),
      legal_name: form.legal_name || undefined, phone: form.phone || undefined, email: form.email || undefined,
      address: form.address || undefined, pan_vat_number: form.pan_vat_number || undefined,
      customer_type: form.customer_type || undefined, status: form.status || undefined, notes: form.notes || undefined,
    }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['companies'] }); setModal(null); },
    onError: (err: any) => setFormError(err?.response?.data?.detail || err?.response?.data?.error?.message || 'Could not create customer.'),
  });

  const updateMutation = useMutation({
    mutationFn: () => api.updateCompany(modal!.id!, {
      company_name: form.company_name.trim(), legal_name: form.legal_name || null, phone: form.phone || null, email: form.email || null,
      address: form.address || null, pan_vat_number: form.pan_vat_number || null, customer_type: form.customer_type || null,
      status: form.status || null, notes: form.notes || null,
    }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['companies'] }); setModal(null); },
    onError: (err: any) => setFormError(err?.response?.data?.detail || err?.response?.data?.error?.message || 'Could not save changes.'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteCompany(id),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['companies'] }); setDeleteTarget(null); },
  });

  const recomputeMutation = useMutation({
    mutationFn: () => api.recomputeCustomerSegments(),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['companies'] }); },
  });

  const submit = () => {
    if (!form.company_name.trim()) { setFormError('Company name is required.'); return; }
    if (modal?.mode === 'add') {
      if (!form.icris_number.trim()) { setFormError('ICRIS number is required.'); return; }
      createMutation.mutate();
    } else {
      updateMutation.mutate();
    }
  };

  const saving = createMutation.isPending || updateMutation.isPending;

  return (
    <div className="flex-1 overflow-y-auto bg-background p-4 sm:p-6 lg:p-8">
      <div className="max-w-[1400px] mx-auto space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-black text-slate-900 dark:text-white tracking-tight flex items-center gap-2">
              <Building2 size={22} className="text-primary" /> Customer Management
            </h1>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
              Create, edit, and archive master customer records. For analytics and activity, use Customer Directory.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => recomputeMutation.mutate()}
              disabled={recomputeMutation.isPending}
              title="Re-applies docs/customer-segmentation-rules.md to every company"
              className="h-9 px-4 flex items-center gap-1.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-200 rounded-lg text-xs font-semibold hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50"
            >
              <RefreshCw size={14} className={recomputeMutation.isPending ? 'animate-spin' : ''} /> Recompute Segments
            </button>
            <button
              onClick={openAdd}
              className="h-9 px-4 flex items-center gap-1.5 bg-slate-900 text-white dark:bg-white dark:text-slate-900 rounded-lg text-xs font-semibold hover:opacity-90"
            >
              <Plus size={14} /> Add Customer
            </button>
          </div>
        </div>

        {recomputeMutation.isSuccess && (
          <div className="text-xs font-medium text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-900 rounded-lg px-3 py-2">
            Segments recomputed: {Object.entries(recomputeMutation.data.tier_counts).map(([tier, count]) => `${tier} ${count}`).join(' · ')}
          </div>
        )}
        {recomputeMutation.isError && (
          <div className="text-xs font-medium text-rose-700 dark:text-rose-400 bg-rose-50 dark:bg-rose-900/20 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
            Could not recompute segments.
          </div>
        )}

        <div className="relative max-w-sm">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            placeholder="Search by name or ICRIS…"
            className="w-full h-9 pl-8 pr-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg text-xs outline-none focus:ring-2 focus:ring-primary/40"
          />
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 dark:bg-slate-900 text-left text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                  <th className="px-4 py-2.5">ICRIS</th>
                  <th className="px-4 py-2.5">Company Name</th>
                  <th className="px-4 py-2.5">Phone</th>
                  <th className="px-4 py-2.5">Email</th>
                  <th className="px-4 py-2.5">Status</th>
                  <th className="px-4 py-2.5 w-24 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {listQuery.isLoading && (
                  <tr><td colSpan={6} className="px-4 py-10 text-center text-slate-400">Loading…</td></tr>
                )}
                {!listQuery.isLoading && items.length === 0 && (
                  <tr><td colSpan={6} className="px-4 py-10 text-center text-slate-400">No customers found.</td></tr>
                )}
                {items.map((row) => (
                  <tr key={row.company_id} className="border-t border-slate-100 dark:border-slate-800">
                    <td className="px-4 py-2 text-slate-500 dark:text-slate-400 font-mono text-xs">{row.icris_number ?? '—'}</td>
                    <td className="px-4 py-2 text-slate-900 dark:text-white font-medium">
                      {row.company_name}
                      {row.is_provisional && <span className="ml-2 text-[10px] font-bold text-amber-700 bg-amber-50 dark:bg-amber-900/20 dark:text-amber-400 px-1.5 py-0.5 rounded border border-amber-200 dark:border-amber-800">PROVISIONAL</span>}
                    </td>
                    <td className="px-4 py-2 text-slate-500 dark:text-slate-400">{row.phone || '—'}</td>
                    <td className="px-4 py-2 text-slate-500 dark:text-slate-400">{row.email || '—'}</td>
                    <td className="px-4 py-2">
                      <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${row.company_status === 'archived' ? 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400' : 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400'}`}>
                        {row.company_status}
                      </span>
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex items-center justify-end gap-1">
                        <button onClick={() => openEdit(row)} className="p-1.5 rounded-md text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="Edit">
                          <Pencil size={14} />
                        </button>
                        <button onClick={() => setDeleteTarget(row)} className="p-1.5 rounded-md text-slate-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-900/20" aria-label="Archive">
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {total > PAGE_SIZE && (
            <div className="flex items-center justify-between px-4 py-2.5 border-t border-slate-200 dark:border-slate-800 text-xs text-slate-500 dark:text-slate-400">
              <span>{total} customers · page {page} of {totalPages}</span>
              <div className="flex items-center gap-1.5">
                <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1} className="p-1.5 rounded-md border border-slate-200 dark:border-slate-800 disabled:opacity-40 hover:bg-slate-50 dark:hover:bg-slate-800">
                  <ChevronLeft size={14} />
                </button>
                <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages} className="p-1.5 rounded-md border border-slate-200 dark:border-slate-800 disabled:opacity-40 hover:bg-slate-50 dark:hover:bg-slate-800">
                  <ChevronRight size={14} />
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {modal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setModal(null)}>
          <div className="w-full max-w-lg rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-xl p-5 space-y-4 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between">
              <h2 className="text-sm font-bold text-slate-900 dark:text-white">{modal.mode === 'add' ? 'Add Customer' : 'Edit Customer'}</h2>
              <button onClick={() => setModal(null)}><X size={16} className="text-slate-400" /></button>
            </div>

            {formError && <div className="text-xs font-semibold text-rose-600 bg-rose-50 dark:bg-rose-900/20 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">{formError}</div>}

            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <label className="text-[10px] font-bold uppercase text-slate-400">ICRIS Number {modal.mode === 'add' && '*'}</label>
                <input value={form.icris_number} disabled={modal.mode === 'edit'} onChange={(e) => setForm({ ...form, icris_number: e.target.value })}
                  className="w-full h-9 mt-1 px-2 border border-slate-200 dark:border-slate-800 rounded-lg bg-transparent text-sm disabled:opacity-50" />
              </div>
              <div className="col-span-2">
                <label className="text-[10px] font-bold uppercase text-slate-400">Company Name *</label>
                <input value={form.company_name} onChange={(e) => setForm({ ...form, company_name: e.target.value })}
                  className="w-full h-9 mt-1 px-2 border border-slate-200 dark:border-slate-800 rounded-lg bg-transparent text-sm" />
              </div>
              <div className="col-span-2">
                <label className="text-[10px] font-bold uppercase text-slate-400">Legal Name</label>
                <input value={form.legal_name} onChange={(e) => setForm({ ...form, legal_name: e.target.value })}
                  className="w-full h-9 mt-1 px-2 border border-slate-200 dark:border-slate-800 rounded-lg bg-transparent text-sm" />
              </div>
              <div>
                <label className="text-[10px] font-bold uppercase text-slate-400">Phone</label>
                <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })}
                  className="w-full h-9 mt-1 px-2 border border-slate-200 dark:border-slate-800 rounded-lg bg-transparent text-sm" />
              </div>
              <div>
                <label className="text-[10px] font-bold uppercase text-slate-400">Email</label>
                <input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })}
                  className="w-full h-9 mt-1 px-2 border border-slate-200 dark:border-slate-800 rounded-lg bg-transparent text-sm" />
              </div>
              <div className="col-span-2">
                <label className="text-[10px] font-bold uppercase text-slate-400">Address</label>
                <input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })}
                  className="w-full h-9 mt-1 px-2 border border-slate-200 dark:border-slate-800 rounded-lg bg-transparent text-sm" />
              </div>
              <div>
                <label className="text-[10px] font-bold uppercase text-slate-400">PAN/VAT Number</label>
                <input value={form.pan_vat_number} onChange={(e) => setForm({ ...form, pan_vat_number: e.target.value })}
                  className="w-full h-9 mt-1 px-2 border border-slate-200 dark:border-slate-800 rounded-lg bg-transparent text-sm" />
              </div>
              <div>
                <label className="text-[10px] font-bold uppercase text-slate-400">Customer Type</label>
                <select value={form.customer_type} onChange={(e) => setForm({ ...form, customer_type: e.target.value })}
                  className="w-full h-9 mt-1 px-2 border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 text-slate-900 dark:text-white text-sm">
                  <option value="">—</option>
                  {CUSTOMER_TYPE_OPTIONS.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div className="col-span-2">
                <label className="text-[10px] font-bold uppercase text-slate-400">Status</label>
                <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}
                  className="w-full h-9 mt-1 px-2 border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 text-slate-900 dark:text-white text-sm">
                  {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div className="col-span-2">
                <label className="text-[10px] font-bold uppercase text-slate-400">Notes</label>
                <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2}
                  className="w-full mt-1 px-2 py-1.5 border border-slate-200 dark:border-slate-800 rounded-lg bg-transparent text-sm" />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button onClick={() => setModal(null)} className="h-9 px-3 text-xs font-semibold rounded-lg border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300">Cancel</button>
              <button onClick={submit} disabled={saving} className="h-9 px-4 text-xs font-bold rounded-lg bg-primary text-white disabled:opacity-50">
                {saving ? 'Saving…' : modal.mode === 'add' ? 'Create' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setDeleteTarget(null)}>
          <div className="w-full max-w-sm rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-xl p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-sm font-bold text-slate-900 dark:text-white">Archive customer?</h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              "{deleteTarget.company_name}" will be archived (status set to archived) — this doesn't delete their shipment or document history.
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setDeleteTarget(null)} className="h-9 px-3 text-xs font-semibold rounded-lg border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300">Cancel</button>
              <button onClick={() => deleteMutation.mutate(deleteTarget.company_id)} disabled={deleteMutation.isPending}
                className="h-9 px-4 text-xs font-bold rounded-lg bg-rose-600 text-white disabled:opacity-50">
                {deleteMutation.isPending ? 'Archiving…' : 'Archive'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
