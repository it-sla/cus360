import React, { useState, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type AeImportPreview } from '../api';
import {
  UploadCloud, FileSpreadsheet, CheckCircle2, AlertTriangle, XCircle, Users,
  ArrowRight, X, Loader2, Edit2, Check, Trash2, Plus, Search, UserCog
} from 'lucide-react';

const fmtNum = (n: number | null | undefined) => (n ?? 0).toLocaleString();
const fmtDateTime = (d: string | null) =>
  d ? new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';

function StatCard({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-3.5 shadow-sm">
      <div className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1">{label}</div>
      <div className={`text-xl font-black tracking-tight ${tone}`}>{fmtNum(value)}</div>
    </div>
  );
}

// ── Roster tab ──────────────────────────────────────────────────────────

function RosterTab() {
  const queryClient = useQueryClient();
  const { data: aes = [], isLoading } = useQuery({ queryKey: ['account-executives'], queryFn: () => api.getAccountExecutives() });
  const [editing, setEditing] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [adding, setAdding] = useState(false);
  const [newCode, setNewCode] = useState('');
  const [newName, setNewName] = useState('');
  const [addError, setAddError] = useState<string | null>(null);

  const update = useMutation({
    mutationFn: ({ code, data }: { code: string; data: { display_name?: string; is_active?: boolean } }) => api.updateAccountExecutive(code, data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['account-executives'] }); setEditing(null); },
  });

  const create = useMutation({
    mutationFn: (data: { ae_code: string; display_name?: string }) => api.createAccountExecutive(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['account-executives'] });
      setAdding(false); setNewCode(''); setNewName(''); setAddError(null);
    },
    onError: (err: any) => setAddError(err?.response?.data?.detail || 'Failed to create AE.'),
  });

  const remove = useMutation({
    mutationFn: ({ code, force }: { code: string; force: boolean }) => api.deleteAccountExecutive(code, force),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['account-executives'] }),
  });

  const handleDelete = (code: string, name: string) => {
    if (!window.confirm(`Delete AE ${code}${name ? ` (${name})` : ''}? This cannot be undone.`)) return;
    remove.mutate({ code, force: false }, {
      onError: (err: any) => {
        const detail = err?.response?.data?.detail;
        if (err?.response?.status === 409 && detail) {
          const msg = typeof detail === 'string' ? detail : detail.detail;
          if (window.confirm(`${msg}. Delete anyway? This will orphan those references.`)) {
            remove.mutate({ code, force: true });
          }
        }
      },
    });
  };

  if (isLoading) return <div className="text-center p-12 text-slate-400 text-sm">Loading roster…</div>;

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-sm overflow-hidden">
      <div className="px-4 py-2.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
        {adding ? (
          <div className="flex items-center gap-2 flex-1">
            <input autoFocus value={newCode} onChange={e => setNewCode(e.target.value)} placeholder="Code"
              className="h-7 px-2 border border-slate-300 dark:border-slate-700 rounded text-xs bg-white dark:bg-slate-900 outline-none focus:border-indigo-400 w-20 font-mono uppercase" />
            <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Name (optional)"
              onKeyDown={e => { if (e.key === 'Enter' && newCode.trim()) create.mutate({ ae_code: newCode, display_name: newName || undefined }); if (e.key === 'Escape') setAdding(false); }}
              className="h-7 px-2 border border-slate-300 dark:border-slate-700 rounded text-xs bg-white dark:bg-slate-900 outline-none focus:border-indigo-400 w-40" />
            <button disabled={!newCode.trim() || create.isPending} onClick={() => create.mutate({ ae_code: newCode, display_name: newName || undefined })}
              className="p-1 text-emerald-600 disabled:opacity-40"><Check size={14} /></button>
            <button onClick={() => { setAdding(false); setAddError(null); }} className="p-1 text-slate-400"><X size={14} /></button>
            {addError && <span className="text-[11px] text-rose-600 dark:text-rose-400">{addError}</span>}
          </div>
        ) : (
          <button onClick={() => setAdding(true)} className="flex items-center gap-1.5 text-xs font-bold text-indigo-600 dark:text-indigo-400">
            <Plus size={14} /> Add AE
          </button>
        )}
      </div>
      <table className="w-full text-left text-xs">
        <thead className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-800">
          <tr className="text-[10px] uppercase font-bold tracking-wider text-slate-500 dark:text-slate-400">
            <th className="px-4 py-2">Code</th>
            <th className="px-4 py-2">Name</th>
            <th className="px-4 py-2 text-right">Assigned Customers</th>
            <th className="px-4 py-2">Status</th>
            <th className="px-4 py-2 text-right">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800/50">
          {aes.map(ae => (
            <tr key={ae.ae_code}>
              <td className="px-4 py-3 font-mono font-bold text-slate-800 dark:text-slate-200">{ae.ae_code}</td>
              <td className="px-4 py-3">
                {editing === ae.ae_code ? (
                  <input
                    autoFocus
                    value={draftName}
                    onChange={e => setDraftName(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') update.mutate({ code: ae.ae_code, data: { display_name: draftName } }); if (e.key === 'Escape') setEditing(null); }}
                    className="h-7 px-2 border border-slate-300 dark:border-slate-700 rounded text-xs bg-white dark:bg-slate-900 outline-none focus:border-indigo-400 w-40"
                  />
                ) : (
                  <span className={ae.display_name ? 'text-slate-800 dark:text-slate-200 font-medium' : 'text-slate-400 italic'}>
                    {ae.display_name || 'No name set'}
                  </span>
                )}
              </td>
              <td className="px-4 py-3 text-right font-semibold text-slate-700 dark:text-slate-300">{fmtNum(ae.assigned_customer_count)}</td>
              <td className="px-4 py-3">
                <button
                  onClick={() => update.mutate({ code: ae.ae_code, data: { is_active: !ae.is_active } })}
                  className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase border ${
                    ae.is_active
                      ? 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/20 dark:text-emerald-400 dark:border-emerald-800/50'
                      : 'bg-slate-100 text-slate-500 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700'
                  }`}
                >
                  {ae.is_active ? 'Active' : 'Inactive'}
                </button>
              </td>
              <td className="px-4 py-3 text-right">
                {editing === ae.ae_code ? (
                  <div className="flex items-center justify-end gap-1.5">
                    <button onClick={() => update.mutate({ code: ae.ae_code, data: { display_name: draftName } })} className="p-1 text-emerald-600"><Check size={14} /></button>
                    <button onClick={() => setEditing(null)} className="p-1 text-slate-400"><X size={14} /></button>
                  </div>
                ) : (
                  <div className="flex items-center justify-end gap-1.5">
                    <button onClick={() => { setEditing(ae.ae_code); setDraftName(ae.display_name || ''); }} className="p-1 text-slate-400">
                      <Edit2 size={13} />
                    </button>
                    <button onClick={() => handleDelete(ae.ae_code, ae.display_name || '')} className="p-1 text-slate-400 hover:text-rose-600">
                      <Trash2 size={13} />
                    </button>
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Manual assignment tab ───────────────────────────────────────────────

function ManualAssignTab() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [targetAe, setTargetAe] = useState('');
  const [result, setResult] = useState<{ reassigned_count: number; unchanged_count: number } | null>(null);

  const debouncedSearch = search.trim();
  const { data: companyPage, isFetching } = useQuery({
    queryKey: ['companies-for-bulk-assign', debouncedSearch],
    queryFn: () => api.getCompanies({ q: debouncedSearch || undefined, limit: 50 }),
  });
  const companies = companyPage?.items ?? [];

  const { data: aes = [] } = useQuery({ queryKey: ['account-executives'], queryFn: () => api.getAccountExecutives() });

  const bulkAssign = useMutation({
    mutationFn: () => api.bulkAssignAE(Array.from(selected), targetAe),
    onSuccess: (data) => {
      setResult(data);
      setSelected(new Set());
      queryClient.invalidateQueries({ queryKey: ['companies-for-bulk-assign'] });
      queryClient.invalidateQueries({ queryKey: ['account-executives'] });
    },
  });

  const toggle = (id: string) => setSelected(s => {
    const next = new Set(s);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return (
    <div className="space-y-4">
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-sm">
        <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100 mb-1">Manual Reassignment</h3>
        <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">
          Search and select companies, choose an AE, then reassign them all at once.
        </p>

        <div className="flex items-center gap-2 mb-3">
          <div className="relative flex-1">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search companies by name or ICRIS..."
              className="w-full h-9 pl-8 pr-3 border border-slate-300 dark:border-slate-700 rounded-lg text-sm bg-white dark:bg-slate-900 outline-none focus:border-indigo-400"
            />
          </div>
          <select
            value={targetAe}
            onChange={e => setTargetAe(e.target.value)}
            className="h-9 px-3 border border-slate-300 dark:border-slate-700 rounded-lg text-sm bg-white dark:bg-slate-900 outline-none focus:border-indigo-400"
          >
            <option value="">Assign to AE...</option>
            {aes.map(ae => (
              <option key={ae.ae_code} value={ae.ae_code}>{ae.ae_code}{ae.display_name ? ` — ${ae.display_name}` : ''}</option>
            ))}
          </select>
          <button
            disabled={!targetAe || selected.size === 0 || bulkAssign.isPending}
            onClick={() => bulkAssign.mutate()}
            className="h-9 px-4 bg-indigo-600 text-white rounded-lg text-sm font-bold flex items-center gap-1.5 disabled:opacity-40 hover:bg-indigo-500"
          >
            {bulkAssign.isPending ? <Loader2 size={14} className="animate-spin" /> : <UserCog size={14} />}
            Reassign ({selected.size})
          </button>
        </div>

        {result && (
          <div className="mb-3 px-3 py-2 bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800/50 rounded-lg text-xs text-emerald-700 dark:text-emerald-400 font-semibold">
            Reassigned {result.reassigned_count}, {result.unchanged_count} already on that AE.
          </div>
        )}

        <div className="border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-800">
              <tr className="text-[10px] uppercase font-bold tracking-wider text-slate-500 dark:text-slate-400">
                <th className="px-4 py-2 w-8"></th>
                <th className="px-4 py-2">Company</th>
                <th className="px-4 py-2">ICRIS</th>
                <th className="px-4 py-2">Current AE</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/50">
              {isFetching && (
                <tr><td colSpan={4} className="px-4 py-6 text-center text-slate-400">Loading…</td></tr>
              )}
              {!isFetching && companies.length === 0 && (
                <tr><td colSpan={4} className="px-4 py-6 text-center text-slate-400">No companies found.</td></tr>
              )}
              {companies.map(c => (
                <tr key={c.company_id} className="hover:bg-slate-50 dark:hover:bg-slate-800/30 cursor-pointer" onClick={() => toggle(c.company_id)}>
                  <td className="px-4 py-2.5">
                    <input type="checkbox" checked={selected.has(c.company_id)} onChange={() => toggle(c.company_id)} onClick={e => e.stopPropagation()} />
                  </td>
                  <td className="px-4 py-2.5 font-medium text-slate-800 dark:text-slate-200">{c.company_name}</td>
                  <td className="px-4 py-2.5 font-mono text-slate-500">{c.icris_number || '—'}</td>
                  <td className="px-4 py-2.5 text-slate-500">{c.ae_code || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ── Import tab ──────────────────────────────────────────────────────────

function ImportTab() {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<AeImportPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [committed, setCommitted] = useState<any>(null);

  const { data: batches = [] } = useQuery({ queryKey: ['ae-import-batches'], queryFn: () => api.getAeImportBatches() });

  const previewMutation = useMutation({
    mutationFn: (file: File) => api.previewAeImport(file),
    onSuccess: (data) => { setPreview(data); setPreviewError(null); },
    onError: (err: any) => { setPreview(null); setPreviewError(err?.response?.data?.detail || 'Failed to read the workbook.'); },
  });

  const commitMutation = useMutation({
    mutationFn: (file: File) => api.commitAeImport(file),
    onSuccess: (batch) => {
      setCommitted(batch);
      setPreview(null);
      setSelectedFile(null);
      queryClient.invalidateQueries({ queryKey: ['ae-import-batches'] });
      queryClient.invalidateQueries({ queryKey: ['account-executives'] });
    },
  });

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setSelectedFile(file);
    setCommitted(null);
    previewMutation.mutate(file);
  };

  const reset = () => {
    setSelectedFile(null); setPreview(null); setPreviewError(null); setCommitted(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  return (
    <div className="space-y-5">
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-sm">
        <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100 mb-1">Upload AE Territory Assignment</h3>
        <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">
          Expects columns: <span className="font-mono">Account Executive</span>, <span className="font-mono">Customer Name</span>, <span className="font-mono">Location</span>, <span className="font-mono">Customer/ICRIS Code</span>.
          Nothing is written until you confirm the preview below.
        </p>
        <input type="file" ref={fileInputRef} accept=".xlsx,.xlsm" onChange={handleFileChange} className="hidden" />
        {!selectedFile ? (
          <button onClick={() => fileInputRef.current?.click()} className="w-full py-8 border-2 border-dashed border-slate-200 dark:border-slate-800 hover:border-indigo-400 hover:bg-indigo-50/30 dark:hover:bg-indigo-900/10 rounded-xl flex flex-col items-center gap-2 text-slate-400 hover:text-indigo-600 transition-colors">
            <UploadCloud size={28} />
            <span className="text-sm font-semibold">Click to select .xlsx file</span>
          </button>
        ) : (
          <div className="flex items-center justify-between p-3 bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-800 rounded-lg">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200">
              <FileSpreadsheet size={16} className="text-emerald-600" /> {selectedFile.name}
            </div>
            <button onClick={reset} className="text-slate-400 hover:text-rose-600"><X size={16} /></button>
          </div>
        )}
      </div>

      {previewMutation.isPending && (
        <div className="flex items-center justify-center gap-2 py-8 text-slate-400 text-sm">
          <Loader2 size={16} className="animate-spin" /> Reading workbook…
        </div>
      )}

      {previewError && (
        <div className="bg-rose-50 dark:bg-rose-900/10 border border-rose-200 dark:border-rose-800/40 rounded-xl p-4 flex gap-3">
          <XCircle size={18} className="text-rose-600 dark:text-rose-400 shrink-0 mt-0.5" />
          <div className="text-sm text-rose-700 dark:text-rose-400">{previewError}</div>
        </div>
      )}

      {committed && (
        <div className="bg-emerald-50 dark:bg-emerald-900/10 border border-emerald-200 dark:border-emerald-800/40 rounded-xl p-4 flex gap-3">
          <CheckCircle2 size={18} className="text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
          <div className="text-sm text-emerald-800 dark:text-emerald-300">
            <strong>Import complete.</strong> {fmtNum(committed.reassigned_count)} customers reassigned, {fmtNum(committed.unchanged_count)} already correct,
            {' '}{fmtNum(committed.unmatched_icris_count)} unmatched ICRIS, {fmtNum(committed.unknown_ae_count)} unrecognized AE values skipped.
          </div>
        </div>
      )}

      {preview && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <StatCard label="Rows in File" value={preview.total_rows} tone="text-slate-900 dark:text-slate-100" />
            <StatCard label="Will Reassign" value={preview.to_reassign_count} tone="text-indigo-600 dark:text-indigo-400" />
            <StatCard label="Already Correct" value={preview.unchanged_count} tone="text-slate-500 dark:text-slate-400" />
            <StatCard label="Need Review" value={preview.unmatched_icris_count + preview.unknown_ae_count + preview.duplicate_icris_count} tone="text-amber-600 dark:text-amber-400" />
          </div>

          {preview.unknown_ae_count > 0 && (
            <div className="bg-amber-50 dark:bg-amber-900/10 border border-amber-200 dark:border-amber-800/40 rounded-xl p-4">
              <div className="flex items-center gap-2 mb-2 text-amber-800 dark:text-amber-300 font-bold text-xs uppercase tracking-wide">
                <AlertTriangle size={14} /> {preview.unknown_ae_count} rows with an unrecognized AE value — will be skipped
              </div>
              <div className="flex flex-wrap gap-1.5">
                {preview.unknown_ae_values.map(v => (
                  <span key={v} className="px-2 py-0.5 bg-white dark:bg-slate-900 border border-amber-200 dark:border-amber-800/50 rounded text-[11px] font-mono text-amber-700 dark:text-amber-400">{v}</span>
                ))}
              </div>
            </div>
          )}

          {preview.unmatched_icris_count > 0 && (
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
              <div className="px-4 py-2.5 border-b border-slate-200 dark:border-slate-800 flex items-center gap-2 text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wide">
                <AlertTriangle size={13} className="text-rose-500" /> {preview.unmatched_icris_count} unmatched ICRIS — will be skipped, not created
              </div>
              <table className="w-full text-left text-xs">
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800/50">
                  {preview.unmatched_icris_preview.map(r => (
                    <tr key={r.row_number}>
                      <td className="px-4 py-2 text-slate-400">Row {r.row_number}</td>
                      <td className="px-4 py-2 font-mono text-slate-700 dark:text-slate-300">{r.icris}</td>
                      <td className="px-4 py-2 text-slate-600 dark:text-slate-400">{r.customer_name}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {preview.unmatched_icris_count > preview.unmatched_icris_preview.length && (
                <div className="px-4 py-2 text-[11px] text-slate-400 border-t border-slate-100 dark:border-slate-800">
                  + {preview.unmatched_icris_count - preview.unmatched_icris_preview.length} more
                </div>
              )}
            </div>
          )}

          {preview.duplicate_icris_count > 0 && (
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
              <div className="flex items-center gap-2 mb-1 text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wide">
                <AlertTriangle size={13} className="text-amber-500" /> {preview.duplicate_icris_count} ICRIS codes appear more than once in this file
              </div>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">The first row for each wins; later duplicates are recorded but not applied.</p>
            </div>
          )}

          <div className="flex items-center gap-3 pt-2">
            <button
              onClick={() => selectedFile && commitMutation.mutate(selectedFile)}
              disabled={commitMutation.isPending || preview.to_reassign_count === 0}
              className="px-5 py-2.5 bg-indigo-600 text-white rounded-lg font-bold text-xs uppercase tracking-wider flex items-center gap-2 disabled:opacity-40 shadow-sm"
            >
              {commitMutation.isPending ? <Loader2 size={14} className="animate-spin" /> : <ArrowRight size={14} />}
              {commitMutation.isPending ? 'Applying…' : `Apply ${fmtNum(preview.to_reassign_count)} Reassignments`}
            </button>
            <button onClick={reset} className="px-4 py-2.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300 rounded-lg font-bold text-xs uppercase tracking-wider">
              Cancel
            </button>
          </div>
        </div>
      )}

      {batches.length > 0 && (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
          <div className="px-4 py-2.5 border-b border-slate-200 dark:border-slate-800 text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wide">
            Import History
          </div>
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-800">
              <tr className="text-[10px] uppercase font-bold tracking-wider text-slate-500 dark:text-slate-400">
                <th className="px-4 py-2">File</th>
                <th className="px-4 py-2">When</th>
                <th className="px-4 py-2 text-right">Reassigned</th>
                <th className="px-4 py-2 text-right">Unmatched</th>
                <th className="px-4 py-2 text-right">Unknown AE</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/50">
              {batches.map(b => (
                <tr key={b.id}>
                  <td className="px-4 py-2.5 font-medium text-slate-800 dark:text-slate-200">{b.file_name}</td>
                  <td className="px-4 py-2.5 text-slate-500 dark:text-slate-400">{fmtDateTime(b.completed_at || b.created_at)}</td>
                  <td className="px-4 py-2.5 text-right text-indigo-600 dark:text-indigo-400 font-semibold">{fmtNum(b.reassigned_count)}</td>
                  <td className="px-4 py-2.5 text-right text-rose-600 dark:text-rose-400">{fmtNum(b.unmatched_icris_count)}</td>
                  <td className="px-4 py-2.5 text-right text-amber-600 dark:text-amber-400">{fmtNum(b.unknown_ae_count)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────

export default function AeAssignment() {
  const [tab, setTab] = useState<'import' | 'roster' | 'manual'>('import');

  return (
    <div className="flex-1 flex flex-col h-full bg-background overflow-hidden">
      <div className="shrink-0 px-6 pt-6 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
        <h1 className="text-2xl font-bold text-slate-900 dark:text-white tracking-tight">AE Territory Assignment</h1>
        <p className="text-sm text-slate-500 font-medium mt-1">
          Import territory assignments and manage the Account Executive roster.
        </p>
        <div className="flex gap-0 -mb-px mt-4">
          {[{ id: 'import' as const, label: 'Import', icon: UploadCloud }, { id: 'roster' as const, label: 'AE Roster', icon: Users }, { id: 'manual' as const, label: 'Manual Assignment', icon: UserCog }].map(t => {
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`relative px-4 py-2.5 text-sm font-medium flex items-center gap-2 transition-colors ${
                  active ? 'text-indigo-600 dark:text-indigo-400 font-semibold' : 'text-slate-400 dark:text-slate-400'
                }`}
              >
                <t.icon size={14} />
                {t.label}
                {active && <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-indigo-600" />}
              </button>
            );
          })}
        </div>
      </div>
      <div className="flex-1 overflow-auto p-4 sm:p-6">
        <div className="max-w-[1000px] mx-auto">
          {tab === 'import' ? <ImportTab /> : tab === 'roster' ? <RosterTab /> : <ManualAssignTab />}
        </div>
      </div>
    </div>
  );
}
