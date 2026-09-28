import { useState } from 'react';
import { Link } from 'react-router-dom';
import { NeuralAccessShell } from '@/components/ui/neural-access-login';
import { authApi } from '@/api';

const FIELDS = [
  { id: 'name', label: 'Full Name', type: 'text', placeholder: 'Jane Doe', autoComplete: 'name' },
  { id: 'email', label: 'Email', type: 'email', placeholder: 'you@email.com', autoComplete: 'email' },
  { id: 'password', label: 'Password', type: 'password', placeholder: 'At least 8 characters', autoComplete: 'new-password' },
  { id: 'confirm', label: 'Confirm Password', type: 'password', placeholder: '••••••••', autoComplete: 'new-password' },
] as const;

export default function RegisterPage() {
  const [form, setForm] = useState({ name: '', email: '', password: '', confirm: '' });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (form.password.length < 8) return setError('Password must be at least 8 characters.');
    if (form.password !== form.confirm) return setError('Passwords do not match.');
    setLoading(true);
    try {
      await authApi.register({ email: form.email, display_name: form.name, password: form.password });
      setDone(true);
    } catch (err: any) {
      const detail = err?.response?.data?.detail;
      setError(typeof detail === 'string' ? detail : 'Could not submit your request — check the form and try again.');
    } finally {
      setLoading(false);
    }
  };

  if (done) {
    return (
      <NeuralAccessShell subtitle="You're signed up! An admin needs to approve your account before you can log in.">
        <div className="submit-wrap">
          <div className="mercury-drop" />
          <Link to="/login" className="btn-base block text-center">Back to Log In</Link>
        </div>
      </NeuralAccessShell>
    );
  }

  return (
    <NeuralAccessShell subtitle="Create your Customer 360 account. An admin will need to approve it before you can log in.">
      <form autoComplete="off" onSubmit={submit}>
        {FIELDS.map(f => (
          <div className="form-group" key={f.id}>
            <label htmlFor={f.id}>{f.label}</label>
            <input
              id={f.id}
              type={f.type}
              placeholder={f.placeholder}
              autoComplete={f.autoComplete}
              value={form[f.id]}
              onChange={e => setForm(s => ({ ...s, [f.id]: e.target.value }))}
              required
            />
            <div className="input-glow" />
          </div>
        ))}

        {error && (
          <div className="mb-4 rounded-md border border-white/10 bg-white/5 px-4 py-3 text-sm text-red-200">{error}</div>
        )}

        <div className="submit-wrap">
          <div className="mercury-drop" />
          <button type="submit" className="btn-base" disabled={loading}>
            {loading ? 'Signing up…' : 'Sign Up'}
          </button>
        </div>
      </form>

      <footer className="footer-nav" style={{ justifyContent: 'center' }}>
        <Link to="/login">BACK TO LOG IN</Link>
      </footer>
    </NeuralAccessShell>
  );
}
