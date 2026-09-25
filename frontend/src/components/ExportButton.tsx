import { useState } from 'react';
import { Download, Loader2 } from 'lucide-react';

interface ExportButtonProps {
  onExport: () => void | Promise<void>;
  disabled?: boolean;
  label?: string;
  // Pages use two header styles: slate (light/dark aware) and zinc (always-dark).
  variant?: 'slate' | 'zinc';
}

const VARIANT_CLASS = {
  slate: 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800',
  zinc: 'bg-zinc-800 border-zinc-700 text-zinc-300 hover:bg-zinc-700',
};

export function ExportButton({ onExport, disabled, label = 'Export Excel', variant = 'slate' }: ExportButtonProps) {
  const className = `flex items-center gap-1.5 h-9 px-3 border rounded-lg text-xs font-semibold transition-colors whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed ${VARIANT_CLASS[variant]}`;
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      await onExport();
    } catch (err) {
      window.alert(`Export failed: ${err instanceof Error ? err.message : 'unknown error'}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <button type="button" onClick={run} disabled={disabled || busy} className={className}>
      {busy ? <Loader2 size={14} className="shrink-0 animate-spin" /> : <Download size={14} className="shrink-0" />}
      <span>{busy ? 'Exporting…' : label}</span>
    </button>
  );
}
