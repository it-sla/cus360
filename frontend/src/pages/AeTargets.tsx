import { useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api';
import type { AeTarget } from '@/api';
import { Target, Upload, X, CheckCircle2, AlertTriangle, Pencil } from 'lucide-react';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function fmt$(v: number | null | undefined) {
  if (v === null || v === undefined) return '—';
  return `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

interface EditState {
  ae_code: string;
  ae_label: string;
  year: number;
  month: number; // 1-12
  existing: AeTarget | null;
}

export default function AeTargets() {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [year, setYear] = useState(new Date().getFullYear());
  const [edit, setEdit] = useState<EditState | null>(null);
  const [importResult, setImportResult] = useState<{ ok: boolean; message: string } | null>(null);

  const aeQuery = useQuery({ queryKey: ['accountExecutives'], queryFn: () => api.getAccountExecutives(true) });
  const targetsQuery = useQuery({
    queryKey: ['aeTargets', year],
    queryFn: () => api.getAeTargets({ year }),
  });

  const aes = aeQuery.data ?? [];
  const targets = targetsQuery.data ?? [];

  // Only AEs that either have an active roster entry or already carry a target for this
  // year, so a code retired mid-year doesn't just vanish from the grid.
  const aeRows = useMemo(() => {
    const fromRoster = aes.map((a: any) => ({ code: a.ae_code, label: a.display_name ? `${a.display_name} (${a.ae_code})` : a.ae_code }));
    const rosterCodes = new Set(fromRoster.map((r) => r.code));
    const extra = Array.from(new Set(targets.map((t) => t.ae_code).filter((c) => !rosterCodes.has(c)))).map((code) => ({ code, label: code }));
    return [...fromRoster, ...extra].sort((a, b) => a.code.localeCompare(b.code));
  }, [aes, targets]);

  const byAeMonth = useMemo(() => {
    const grid: Record<string, Record<number, AeTarget>> = {};
    for (const t of targets) {
      grid[t.ae_code] = grid[t.ae_code] || {};
      grid[t.ae_code][t.month] = t;
    }
    return grid;
  }, [targets]);

  const monthTotals = useMemo(() => MONTHS.map((_, i) => targets.filter((t) => t.month === i + 1).reduce((s, t) => s + (t.revenue_target || 0), 0)), [targets]);
  const yearTotal = monthTotals.reduce((s, v) => s + v, 0);

  const importMutation = useMutation({
    mutationFn: (file: File) => api.importAeTargets(file),
    onSuccess: (res) => {
      setImportResult({
        ok: true,
        message: `Imported "${res.file_name}" (${res.worksheet_name}): ${res.created} created, ${res.updated} updated${res.unknown_ae_count ? `, ${res.unknown_ae_count} unrecognized AE (${res.unknown_ae_values.join(', ')})` : ''}${res.invalid_row_count ? `, ${res.invalid_row_count} invalid rows skipped` : ''}.`,
      });
      queryClient.invalidateQueries({ queryKey: ['aeTargets'] });
    },
    onError: (err: any) => setImportResult({ ok: false, message: err?.response?.data?.detail || 'Import failed.' }),
  });

  const saveMutation = useMutation({
    mutationFn: api.upsertAeTarget,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['aeTargets'] });
      setEdit(null);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: api.deleteAeTarget,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['aeTargets'] });
      setEdit(null);
    },
  });

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) importMutation.mutate(file);
    e.target.value = '';
  };

  const openCell = (ae: { code: string; label: string }, month: number) => {
    setEdit({ ae_code: ae.code, ae_label: ae.label, year, month, existing: byAeMonth[ae.code]?.[month] ?? null });
  };

  return (
    <div className="flex-1 overflow-y-auto bg-background p-4 sm:p-6 lg:p-8">
      <div className="max-w-[1800px] mx-auto space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-black text-slate-900 dark:text-white tracking-tight flex items-center gap-2">
              <Target size={22} className="text-primary" /> AE Revenue Targets
            </h1>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
              Monthly weight / piece / revenue targets per Account Executive. Import from Excel, or click any cell to set targets manually.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={year}
              onChange={(e) => setYear(Number(e.target.value))}
              className="h-9 px-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg text-xs font-semibold text-slate-700 dark:text-slate-300 outline-none"
            >
              {[year - 1, year, year + 1].map((y) => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
            <input ref={fileInputRef} type="file" accept=".xlsx,.xlsm" className="hidden" onChange={handleFile} />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={importMutation.isPending}
              className="h-9 px-3 flex items-center gap-1.5 bg-slate-900 text-white dark:bg-white dark:text-slate-900 rounded-lg text-xs font-semibold hover:opacity-90 disabled:opacity-50"
            >
              <Upload size={14} className={importMutation.isPending ? 'animate-pulse' : ''} />
              {importMutation.isPending ? 'Importing…' : 'Import from Excel'}
            </button>
          </div>
        </div>

        {importResult && (
          <div className={`flex items-start gap-2 px-3 py-2 rounded-lg border text-xs font-semibold ${
            importResult.ok
              ? 'bg-emerald-50 dark:bg-emerald-900/20 border-emerald-200 dark:border-emerald-800/50 text-emerald-700 dark:text-emerald-400'
              : 'bg-rose-50 dark:bg-rose-900/20 border-rose-200 dark:border-rose-800/50 text-rose-700 dark:text-rose-400'
          }`}>
            {importResult.ok ? <CheckCircle2 size={14} className="mt-0.5 shrink-0" /> : <AlertTriangle size={14} className="mt-0.5 shrink-0" />}
            <span>{importResult.message}</span>
            <button onClick={() => setImportResult(null)} className="ml-auto"><X size={14} /></button>
          </div>
        )}

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-slate-50 dark:bg-slate-900 text-left font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                  <th className="px-3 py-2.5 sticky left-0 bg-slate-50 dark:bg-slate-900 z-10">AE</th>
                  {MONTHS.map((m) => (
                    <th key={m} className="px-3 py-2.5 text-right">{m}</th>
                  ))}
                  <th className="px-3 py-2.5 text-right font-bold">Total</th>
                </tr>
              </thead>
              <tbody>
                {targetsQuery.isLoading && (
                  <tr><td colSpan={14} className="px-4 py-8 text-center text-slate-400">Loading…</td></tr>
                )}
                {!targetsQuery.isLoading && aeRows.length === 0 && (
                  <tr><td colSpan={14} className="px-4 py-8 text-center text-slate-400">No AEs found. Import a targets file or check the AE roster.</td></tr>
                )}
                {aeRows.map((ae) => {
                  const rowTotal = MONTHS.reduce((s, _, i) => s + (byAeMonth[ae.code]?.[i + 1]?.revenue_target || 0), 0);
                  return (
                    <tr key={ae.code} className="border-t border-slate-100 dark:border-slate-800">
                      <td className="px-3 py-2 font-semibold text-slate-900 dark:text-white sticky left-0 bg-white dark:bg-slate-950 z-10">{ae.label}</td>
                      {MONTHS.map((_, i) => {
                        const t = byAeMonth[ae.code]?.[i + 1];
                        return (
                          <td
                            key={i}
                            onClick={() => openCell(ae, i + 1)}
                            className="px-3 py-2 text-right font-mono cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/60 group relative"
                          >
                            <span className={t ? 'text-slate-700 dark:text-slate-300' : 'text-slate-300 dark:text-slate-700'}>{fmt$(t?.revenue_target)}</span>
                            <Pencil size={10} className="hidden group-hover:inline ml-1 text-slate-400" />
                          </td>
                        );
                      })}
                      <td className="px-3 py-2 text-right font-mono font-bold text-slate-900 dark:text-white">{fmt$(rowTotal)}</td>
                    </tr>
                  );
                })}
              </tbody>
              {aeRows.length > 0 && (
                <tfoot>
                  <tr className="border-t-2 border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 font-bold">
                    <td className="px-3 py-2.5 text-slate-900 dark:text-white sticky left-0 bg-slate-50 dark:bg-slate-900">All AEs</td>
                    {monthTotals.map((v, i) => (
                      <td key={i} className="px-3 py-2.5 text-right font-mono text-slate-900 dark:text-white">{fmt$(v)}</td>
                    ))}
                    <td className="px-3 py-2.5 text-right font-mono text-slate-900 dark:text-white">{fmt$(yearTotal)}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </div>
        <p className="text-[11px] text-slate-400">Showing Revenue target per month. Click a cell to view or edit Weight / Piece / Revenue targets (export &amp; import) for that AE and month.</p>
      </div>

      {edit && (
        <TargetEditModal
          edit={edit}
          onClose={() => setEdit(null)}
          onSave={(payload) => saveMutation.mutate(payload)}
          onDelete={edit.existing ? () => deleteMutation.mutate(edit.existing!.id) : undefined}
          saving={saveMutation.isPending}
          deleting={deleteMutation.isPending}
        />
      )}
    </div>
  );
}

function TargetEditModal({
  edit, onClose, onSave, onDelete, saving, deleting,
}: {
  edit: EditState;
  onClose: () => void;
  onSave: (payload: any) => void;
  onDelete?: () => void;
  saving: boolean;
  deleting: boolean;
}) {
  const e = edit.existing;
  const [weight, setWeight] = useState(e?.weight_target?.toString() ?? '');
  const [piece, setPiece] = useState(e?.piece_target?.toString() ?? '');
  const [revenue, setRevenue] = useState(e?.revenue_target?.toString() ?? '');
  const [weightImp, setWeightImp] = useState(e?.weight_target_import?.toString() ?? '');
  const [pieceImp, setPieceImp] = useState(e?.piece_target_import?.toString() ?? '');
  const [revenueImp, setRevenueImp] = useState(e?.revenue_target_import?.toString() ?? '');
  const [notes, setNotes] = useState(e?.notes ?? '');

  const num = (v: string) => (v.trim() === '' ? null : Number(v));

  const submit = () => {
    onSave({
      ae_code: edit.ae_code, year: edit.year, month: edit.month,
      weight_target: num(weight), piece_target: num(piece) !== null ? Math.round(num(piece)!) : null, revenue_target: num(revenue),
      weight_target_import: num(weightImp), piece_target_import: num(pieceImp) !== null ? Math.round(num(pieceImp)!) : null, revenue_target_import: num(revenueImp),
      notes: notes.trim() || null,
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-xl p-5 space-y-4"
        onClick={(ev) => ev.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-sm font-bold text-slate-900 dark:text-white">{edit.ae_label}</h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">{MONTHS[edit.month - 1]} {edit.year} target</p>
          </div>
          <button onClick={onClose}><X size={16} className="text-slate-400" /></button>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="text-[10px] font-bold uppercase text-slate-400">Weight (kg)</label>
            <input value={weight} onChange={(ev) => setWeight(ev.target.value)} type="number" className="w-full h-9 mt-1 px-2 border border-slate-200 dark:border-slate-800 rounded-lg bg-transparent text-sm" />
          </div>
          <div>
            <label className="text-[10px] font-bold uppercase text-slate-400">Pieces</label>
            <input value={piece} onChange={(ev) => setPiece(ev.target.value)} type="number" className="w-full h-9 mt-1 px-2 border border-slate-200 dark:border-slate-800 rounded-lg bg-transparent text-sm" />
          </div>
          <div>
            <label className="text-[10px] font-bold uppercase text-slate-400">Revenue ($)</label>
            <input value={revenue} onChange={(ev) => setRevenue(ev.target.value)} type="number" className="w-full h-9 mt-1 px-2 border border-slate-200 dark:border-slate-800 rounded-lg bg-transparent text-sm" />
          </div>
        </div>

        <details className="text-xs">
          <summary className="cursor-pointer font-semibold text-slate-500 dark:text-slate-400">Import targets (optional)</summary>
          <div className="grid grid-cols-3 gap-3 mt-2">
            <div>
              <label className="text-[10px] font-bold uppercase text-slate-400">Weight (kg)</label>
              <input value={weightImp} onChange={(ev) => setWeightImp(ev.target.value)} type="number" className="w-full h-9 mt-1 px-2 border border-slate-200 dark:border-slate-800 rounded-lg bg-transparent text-sm" />
            </div>
            <div>
              <label className="text-[10px] font-bold uppercase text-slate-400">Pieces</label>
              <input value={pieceImp} onChange={(ev) => setPieceImp(ev.target.value)} type="number" className="w-full h-9 mt-1 px-2 border border-slate-200 dark:border-slate-800 rounded-lg bg-transparent text-sm" />
            </div>
            <div>
              <label className="text-[10px] font-bold uppercase text-slate-400">Revenue ($)</label>
              <input value={revenueImp} onChange={(ev) => setRevenueImp(ev.target.value)} type="number" className="w-full h-9 mt-1 px-2 border border-slate-200 dark:border-slate-800 rounded-lg bg-transparent text-sm" />
            </div>
          </div>
        </details>

        <div>
          <label className="text-[10px] font-bold uppercase text-slate-400">Notes</label>
          <textarea value={notes} onChange={(ev) => setNotes(ev.target.value)} rows={2} className="w-full mt-1 px-2 py-1.5 border border-slate-200 dark:border-slate-800 rounded-lg bg-transparent text-sm" />
        </div>

        <div className="flex items-center justify-between pt-2">
          {onDelete ? (
            <button onClick={onDelete} disabled={deleting} className="text-xs font-semibold text-rose-600 hover:underline disabled:opacity-50">
              {deleting ? 'Removing…' : 'Remove target'}
            </button>
          ) : <span />}
          <div className="flex gap-2">
            <button onClick={onClose} className="h-9 px-3 text-xs font-semibold rounded-lg border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300">Cancel</button>
            <button onClick={submit} disabled={saving} className="h-9 px-4 text-xs font-bold rounded-lg bg-primary text-white disabled:opacity-50">
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
