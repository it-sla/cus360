import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import { X, Eye, EyeOff, Loader2, CheckCircle2 } from 'lucide-react';
import { authApi } from '@/api';

/** Self-service "Change my password" — available to every role from the header user
 * menu. Requires the current password; on success the server re-issues this session's
 * own cookie (see auth_change_password) so the user isn't logged out by their own
 * action, even though every OTHER session of theirs is revoked. */
export function ChangePasswordDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);

  const reset = () => { setCurrent(''); setNext(''); setConfirm(''); setShow(false); mutation.reset(); };

  const mutation = useMutation({
    mutationFn: () => authApi.changePassword(current, next),
  });

  const mismatch = next.length > 0 && confirm.length > 0 && next !== confirm;
  const tooShort = next.length > 0 && next.length < 8;
  const canSubmit = current.length > 0 && next.length >= 8 && next === confirm && !mutation.isPending;

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) reset(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-2xl p-6">
          <div className="flex items-center justify-between mb-4">
            <Dialog.Title className="text-lg font-bold text-slate-800 dark:text-slate-100">Change Password</Dialog.Title>
            <Dialog.Close className="text-slate-400 hover:text-slate-600 transition-colors"><X size={20} /></Dialog.Close>
          </div>

          {mutation.isSuccess ? (
            <div className="flex flex-col items-center gap-3 py-6 text-center">
              <CheckCircle2 size={32} className="text-emerald-500" />
              <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">Password changed. You're still signed in here — every other session was signed out.</p>
              <button onClick={() => onOpenChange(false)} className="mt-2 h-9 px-4 bg-slate-900 dark:bg-white dark:text-slate-900 text-white rounded-lg text-xs font-bold">Done</button>
            </div>
          ) : (
            <form onSubmit={(e) => { e.preventDefault(); if (canSubmit) mutation.mutate(); }} className="space-y-3">
              <div>
                <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1 block">Current Password</label>
                <input type={show ? 'text' : 'password'} value={current} onChange={(e) => setCurrent(e.target.value)} autoFocus
                  className="w-full h-9 px-3 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-xs outline-none focus:border-teal-400" />
              </div>
              <div>
                <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1 block">New Password</label>
                <div className="relative">
                  <input type={show ? 'text' : 'password'} value={next} onChange={(e) => setNext(e.target.value)}
                    className="w-full h-9 px-3 pr-9 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-xs outline-none focus:border-teal-400" />
                  <button type="button" onClick={() => setShow((s) => !s)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                    {show ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
                {tooShort && <p className="text-[10px] text-rose-500 mt-1">At least 8 characters.</p>}
              </div>
              <div>
                <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1 block">Confirm New Password</label>
                <input type={show ? 'text' : 'password'} value={confirm} onChange={(e) => setConfirm(e.target.value)}
                  className="w-full h-9 px-3 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-xs outline-none focus:border-teal-400" />
                {mismatch && <p className="text-[10px] text-rose-500 mt-1">Passwords don't match.</p>}
              </div>

              {mutation.isError && (
                <p className="text-xs font-semibold text-rose-600 bg-rose-50 dark:bg-rose-900/20 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
                  {(mutation.error as any)?.response?.data?.detail || 'Current password is incorrect'}
                </p>
              )}

              <p className="text-[10px] text-slate-400">This signs you out of every other device — this session stays signed in.</p>

              <button type="submit" disabled={!canSubmit}
                className="w-full h-9 bg-teal-700 hover:bg-teal-800 disabled:opacity-50 text-white rounded-lg text-xs font-bold flex items-center justify-center gap-1.5 transition-colors">
                {mutation.isPending ? <Loader2 size={13} className="animate-spin" /> : null}
                {mutation.isPending ? 'Changing…' : 'Change Password'}
              </button>
            </form>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
