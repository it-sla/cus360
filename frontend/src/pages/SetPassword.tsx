import { useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { KeyRound, ShieldCheck, AlertTriangle } from 'lucide-react';
import { authApi } from '@/api';
import { useAuth } from '@/auth';

export default function SetPasswordPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get('token') || '';
  const { refresh } = useAuth();

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  if (!token) {
    return <Navigate to="/login" replace />;
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setLoading(true);
    try {
      await authApi.setPassword(token, password);
      await refresh();
      setDone(true);
      setTimeout(() => navigate('/app', { replace: true }), 900);
    } catch (err: any) {
      setError(err?.response?.data?.detail || 'This setup link is invalid or has expired — ask an admin to send you a new one.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-950 px-4">
      <div className="w-full max-w-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl p-7">
        <div className="w-11 h-11 rounded-full bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-200 dark:border-indigo-800/50 flex items-center justify-center mb-4">
          {done ? <ShieldCheck size={20} className="text-emerald-600 dark:text-emerald-400" /> : <KeyRound size={20} className="text-indigo-600 dark:text-indigo-400" />}
        </div>
        <h1 className="text-lg font-bold text-slate-900 dark:text-white">
          {done ? 'Password set' : 'Set your password'}
        </h1>
        <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 mb-5">
          {done ? 'Signing you in…' : 'Choose a password for your Customer 360 account. This link only works once.'}
        </p>

        {!done && (
          <form onSubmit={submit} className="space-y-4">
            <div>
              <label className="block text-xs font-bold text-slate-500 uppercase tracking-wide mb-1.5">New Password</label>
              <input
                type="password"
                autoFocus
                value={password}
                onChange={e => setPassword(e.target.value)}
                className="w-full h-10 px-3 bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-800 rounded-lg text-sm text-slate-800 dark:text-slate-200 outline-none focus:border-indigo-400"
                placeholder="At least 8 characters"
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-500 uppercase tracking-wide mb-1.5">Confirm Password</label>
              <input
                type="password"
                value={confirm}
                onChange={e => setConfirm(e.target.value)}
                className="w-full h-10 px-3 bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-800 rounded-lg text-sm text-slate-800 dark:text-slate-200 outline-none focus:border-indigo-400"
                placeholder="Re-enter password"
              />
            </div>
            {error && (
              <div className="flex items-start gap-2 text-xs font-semibold text-rose-600 dark:text-rose-400">
                <AlertTriangle size={14} className="shrink-0 mt-0.5" /> {error}
              </div>
            )}
            <button
              type="submit"
              disabled={loading}
              className="w-full h-10 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-bold rounded-lg transition-colors disabled:opacity-50"
            >
              {loading ? 'Setting password…' : 'Set Password & Sign In'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
