import { useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { NeuralAccessShell } from '@/components/ui/neural-access-login';
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

  if (done) {
    return (
      <NeuralAccessShell subtitle="Password set. Signing you in…" />
    );
  }

  return (
    <NeuralAccessShell subtitle="Choose a password for your Customer 360 account. This link only works once.">
      <form autoComplete="off" onSubmit={submit}>
        <div className="form-group">
          <label htmlFor="password">New Password</label>
          <input
            id="password"
            type="password"
            autoFocus
            placeholder="At least 8 characters"
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
          />
          <div className="input-glow" />
        </div>
        <div className="form-group">
          <label htmlFor="confirm">Confirm Password</label>
          <input
            id="confirm"
            type="password"
            placeholder="Re-enter password"
            value={confirm}
            onChange={e => setConfirm(e.target.value)}
            required
          />
          <div className="input-glow" />
        </div>

        {error && (
          <div className="mb-4 rounded-md border border-white/10 bg-white/5 px-4 py-3 text-sm text-red-200">{error}</div>
        )}

        <div className="submit-wrap">
          <div className="mercury-drop" />
          <button type="submit" className="btn-base" disabled={loading}>
            {loading ? 'Setting password…' : 'Set Password & Sign In'}
          </button>
        </div>
      </form>
    </NeuralAccessShell>
  );
}
