import { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import NeuralAccessLogin from '@/components/ui/neural-access-login';
import { formatAuthError, useAuth } from '@/auth';

export default function LoginPage() {
    const navigate = useNavigate();
    const location = useLocation();
    const { user, status, login } = useAuth();
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);

    const destination = (location.state as { from?: { pathname?: string } } | null)?.from?.pathname ?? '/app';

    if (status === 'loading') {
        return <div className="flex min-h-screen items-center justify-center bg-black text-white">Loading access profile…</div>;
    }

    if (user) {
        return <Navigate to={destination} replace />;
    }

    return (
        <NeuralAccessLogin
            loading={loading}
            error={error}
            onSubmit={async (credentials) => {
                setLoading(true);
                setError(null);

                try {
                    await login(credentials);
                    navigate(destination, { replace: true });
                } catch (exception) {
                    setError(formatAuthError(exception) || 'Unable to sign in');
                } finally {
                    setLoading(false);
                }
            }}
        />
    );
}