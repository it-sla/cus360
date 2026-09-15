import { useEffect, useMemo, useRef, useState } from 'react';
import { ShieldCheck, Sparkles } from 'lucide-react';

export interface NeuralAccessLoginProps {
    onSubmit: (credentials: { email: string; password: string }) => Promise<void>;
    loading?: boolean;
    error?: string | null;
    defaultEmail?: string;
}

export function NeuralAccessLogin({ onSubmit, loading = false, error = null, defaultEmail = '' }: NeuralAccessLoginProps) {
    const [email, setEmail] = useState(defaultEmail);
    const [password, setPassword] = useState('');

    const blobsData = useMemo(() => {
        return Array.from({ length: 6 }).map(() => ({
            size: Math.random() * 180 + 140,
            left: Math.random() * 80 + 10,
            top: Math.random() * 80 + 10,
            animationDelay: Math.random() * -20,
            animationDuration: Math.random() * 15 + 15,
        }));
    }, []);

    const blobRefs = useRef<(HTMLDivElement | null)[]>([]);

    useEffect(() => {
        const handleMouseMove = (event: MouseEvent) => {
            const x = event.clientX / window.innerWidth;
            const y = event.clientY / window.innerHeight;

            blobRefs.current.forEach((blob, index) => {
                if (!blob) {
                    return;
                }

                const speed = (index + 1) * 20;
                blob.style.marginLeft = `${x * speed}px`;
                blob.style.marginTop = `${y * speed}px`;
            });
        };

        document.addEventListener('mousemove', handleMouseMove);
        return () => document.removeEventListener('mousemove', handleMouseMove);
    }, []);

    const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        await onSubmit({ email, password });
    };

    return (
        <div className="relative flex min-h-screen w-full items-center justify-center overflow-hidden bg-[radial-gradient(circle_at_top,rgba(148,163,184,0.18),transparent_38%),linear-gradient(180deg,#050505_0%,#09090b_100%)] text-white">
            <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;800&family=Space+Mono&display=swap');

        .neural-access-shell {
          font-family: 'Inter', sans-serif;
        }

        .neural-access-shell * {
          box-sizing: border-box;
          -webkit-font-smoothing: antialiased;
        }

        .stage {
          position: absolute;
          inset: 0;
          z-index: 0;
          filter: url('#gooey');
          opacity: 0.6;
        }

        .blob {
          position: absolute;
          border-radius: 9999px;
          background: linear-gradient(135deg, #e5e7eb, #71717a);
          filter: blur(20px);
          animation: float 20s infinite alternate ease-in-out;
          box-shadow: inset -10px -10px 20px rgba(0, 0, 0, 0.5), 10px 10px 30px rgba(255, 255, 255, 0.14);
          transition: margin 0.1s ease-out;
        }

        @keyframes float {
          0% { transform: translate(0, 0) scale(1); }
          33% { transform: translate(10vw, 20vh) scale(1.2); }
          66% { transform: translate(-5vw, 10vh) scale(0.8); }
          100% { transform: translate(5vw, -10vh) scale(1.1); }
        }

        .auth-container {
          position: relative;
          z-index: 10;
          width: 100%;
          max-width: 460px;
          padding: 40px;
        }

        .brand-id {
          font-family: 'Space Mono', monospace;
          font-size: 10px;
          letter-spacing: 4px;
          text-transform: uppercase;
          color: rgba(255, 255, 255, 0.5);
          margin-bottom: 8px;
          display: inline-flex;
          align-items: center;
          gap: 8px;
        }

        .title {
          font-weight: 800;
          font-size: clamp(2.75rem, 7vw, 4.5rem);
          line-height: 0.88;
          letter-spacing: -0.08em;
          margin: 0;
        }

        .subtitle {
          margin-top: 16px;
          max-width: 32rem;
          color: rgba(255, 255, 255, 0.62);
          font-size: 0.95rem;
          line-height: 1.6;
        }

        .form-group {
          position: relative;
          margin-bottom: 26px;
          transition: transform 0.4s cubic-bezier(0.2, 1, 0.3, 1);
        }

        .form-group:focus-within {
          transform: translateX(10px);
        }

        .form-group label {
          display: block;
          font-family: 'Space Mono', monospace;
          font-size: 11px;
          color: rgba(255, 255, 255, 0.5);
          margin-bottom: 12px;
          text-transform: uppercase;
        }

        .form-group input {
          width: 100%;
          background: transparent;
          border: none;
          border-bottom: 1px solid rgba(255, 255, 255, 0.12);
          color: #fff;
          padding: 12px 0;
          font-size: 18px;
          outline: none;
          transition: border-color 0.4s;
        }

        .input-glow {
          position: absolute;
          bottom: 0;
          left: 0;
          width: 0%;
          height: 2px;
          background: #e5e7eb;
          transition: width 0.6s cubic-bezier(0.2, 1, 0.3, 1);
          box-shadow: 0 0 15px #e5e7eb;
        }

        .form-group input:focus + .input-glow {
          width: 100%;
        }

        .submit-wrap {
          margin-top: 40px;
          position: relative;
          filter: url('#gooey');
        }

        .btn-base {
          background: #fff;
          color: #000;
          border: none;
          padding: 18px 40px;
          font-size: 14px;
          font-weight: 800;
          text-transform: uppercase;
          letter-spacing: 2px;
          cursor: pointer;
          width: 100%;
          position: relative;
          z-index: 2;
          transition: letter-spacing 0.3s;
        }

        .btn-base:hover {
          letter-spacing: 4px;
        }

        .btn-base:disabled {
          opacity: 0.65;
          cursor: not-allowed;
        }

        .mercury-drop {
          position: absolute;
          inset: 0;
          background: #e5e7eb;
          transform: scale(1);
          z-index: 1;
          border-radius: 50px;
          transition: all 0.5s cubic-bezier(0.175, 0.885, 0.32, 1.275);
        }

        .submit-wrap:hover .mercury-drop {
          transform: scale(1.05, 1.15);
          filter: brightness(1.15);
        }

        .footer-nav {
          margin-top: 30px;
          display: flex;
          justify-content: space-between;
          gap: 16px;
          font-family: 'Space Mono', monospace;
          font-size: 10px;
          color: rgba(255, 255, 255, 0.5);
        }

        .footer-nav a {
          color: inherit;
          text-decoration: none;
          transition: color 0.3s;
        }

        .footer-nav a:hover {
          color: #fff;
        }
      `}</style>

            <svg className="absolute h-0 w-0" aria-hidden="true">
                <defs>
                    <filter id="gooey">
                        <feGaussianBlur in="SourceGraphic" stdDeviation="12" result="blur" />
                        <feColorMatrix
                            in="blur"
                            mode="matrix"
                            values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 19 -9"
                            result="goo"
                        />
                        <feComposite in="SourceGraphic" in2="goo" operator="atop" />
                    </filter>
                </defs>
            </svg>

            <div className="stage" aria-hidden="true">
                {blobsData.map((data, index) => (
                    <div
                        key={index}
                        ref={(element) => {
                            blobRefs.current[index] = element;
                        }}
                        className="blob"
                        style={{
                            width: `${data.size}px`,
                            height: `${data.size}px`,
                            left: `${data.left}%`,
                            top: `${data.top}%`,
                            animationDelay: `${data.animationDelay}s`,
                            animationDuration: `${data.animationDuration}s`,
                        }}
                    />
                ))}
            </div>

            <main className="neural-access-shell auth-container">
                <header className="mb-14 text-left">
                    <span className="brand-id">
                        <ShieldCheck size={13} />
                        System Node: 0x992
                    </span>
                    <h1 className="title">
                        Shangrila
                        <br />
                        Intelligence
                    </h1>
                    <p className="subtitle">
                        Sign in to access the Customer 360 workspace. Administration and data integration routes remain hidden unless your account is marked as admin.
                    </p>
                </header>

                <form autoComplete="off" onSubmit={handleSubmit}>
                    <div className="form-group">
                        <label htmlFor="email">User Identity</label>
                        <input
                            id="email"
                            type="email"
                            placeholder="admin@company.com"
                            value={email}
                            onChange={(event) => setEmail(event.target.value)}
                            required
                        />
                        <div className="input-glow" />
                    </div>

                    <div className="form-group">
                        <label htmlFor="password">Sequence Key</label>
                        <input
                            id="password"
                            type="password"
                            placeholder="••••••••"
                            value={password}
                            onChange={(event) => setPassword(event.target.value)}
                            required
                        />
                        <div className="input-glow" />
                    </div>

                    {error ? (
                        <div className="mb-4 rounded-md border border-white/10 bg-white/5 px-4 py-3 text-sm text-red-200">
                            {error}
                        </div>
                    ) : null}

                    <div className="submit-wrap">
                        <div className="mercury-drop" />
                        <button type="submit" className="btn-base" disabled={loading}>
                            {loading ? 'Authenticating…' : 'Initialize Stream'}
                        </button>
                    </div>
                </form>

                <footer className="footer-nav">
                    <a href="#encrypted" onClick={(event) => event.preventDefault()}>
                        <span className="inline-flex items-center gap-1">
                            <Sparkles size={10} />
                            ENCRYPTED RECOVERY
                        </span>
                    </a>
                    <a href="#archive" onClick={(event) => event.preventDefault()}>
                        NEW ARCHIVE
                    </a>
                </footer>
            </main>
        </div>
    );
}

export default NeuralAccessLogin;