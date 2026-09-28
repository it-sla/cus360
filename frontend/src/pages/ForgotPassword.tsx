import { useState } from 'react';
import { Link } from 'react-router-dom';
import { NeuralAccessShell } from '@/components/ui/neural-access-login';
import { authApi } from '@/api';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      await authApi.forgotPassword(email);
    } finally {
      // Always show the same result, whether or not the email exists — never reveal that.
      setLoading(false);
      setDone(true);
    }
  };

  if (done) {
    return (
      <NeuralAccessShell subtitle="If that email has an account, we've sent a link to reset the password. It may take a few minutes to arrive.">
        <div className="submit-wrap">
          <div className="mercury-drop" />
          <Link to="/login" className="btn-base block text-center">Back to Log In</Link>
        </div>
      </NeuralAccessShell>
    );
  }

  return (
    <NeuralAccessShell subtitle="Enter your email and we'll send you a link to reset your password.">
      <form autoComplete="off" onSubmit={submit}>
        <div className="form-group">
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            autoFocus
            placeholder="you@email.com"
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
          />
          <div className="input-glow" />
        </div>

        <div className="submit-wrap">
          <div className="mercury-drop" />
          <button type="submit" className="btn-base" disabled={loading}>
            {loading ? 'Sending…' : 'Send Reset Link'}
          </button>
        </div>
      </form>

      <footer className="footer-nav" style={{ justifyContent: 'center' }}>
        <Link to="/login">BACK TO LOG IN</Link>
      </footer>
    </NeuralAccessShell>
  );
}
