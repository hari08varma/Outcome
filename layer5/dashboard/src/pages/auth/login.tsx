/**
 * Login Page — /login
 * Email + password login via Supabase Auth.
 */
import React, { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { supabase } from '../../supabaseClient';

export default function LoginPage() {
    const navigate = useNavigate();
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);

    // If already logged in, redirect to /
    useEffect(() => {
        supabase.auth.getSession().then(({ data: { session } }) => {
            if (session) navigate('/', { replace: true });
        });
    }, [navigate]);

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        setError('');
        setLoading(true);

        const { error } = await supabase.auth.signInWithPassword({ email, password });

        if (error) {
            setError(error.message);
            setLoading(false);
            return;
        }

        navigate('/', { replace: true });
    }

    return (
        <div style={container}>
            <div style={card}>
                <h1 style={{ margin: 0, fontSize: '1.5rem', color: '#1e293b' }}>Layer5</h1>
                <p style={{ color: '#64748b', margin: '0.25rem 0 1.5rem' }}>Sign in to your account</p>

                {error && <div style={errorBox}>{error}</div>}

                <form onSubmit={handleSubmit}>
                    <label style={label}>Email</label>
                    <input
                        type="email"
                        value={email}
                        onChange={e => setEmail(e.target.value)}
                        required
                        style={input}
                        placeholder="you@company.com"
                    />

                    <label style={label}>Password</label>
                    <input
                        type="password"
                        value={password}
                        onChange={e => setPassword(e.target.value)}
                        required
                        style={input}
                        placeholder="••••••••"
                        minLength={6}
                    />

                    <button type="submit" disabled={loading} style={button}>
                        {loading ? 'Signing in…' : 'Sign In'}
                    </button>
                </form>

                <p style={{ textAlign: 'center', marginTop: '1rem', fontSize: '0.875rem', color: '#64748b' }}>
                    Don't have an account? <Link to="/signup" style={link}>Sign up</Link>
                </p>
            </div>
        </div>
    );
}

// ── Styles ────────────────────────────────────────────────────
const container: React.CSSProperties = {
    display: 'flex', justifyContent: 'center', alignItems: 'center',
    minHeight: '100vh', background: '#f1f5f9', fontFamily: 'system-ui, sans-serif',
};
const card: React.CSSProperties = {
    background: '#fff', borderRadius: '0.75rem', padding: '2rem',
    width: '100%', maxWidth: '400px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
};
const label: React.CSSProperties = {
    display: 'block', fontSize: '0.875rem', fontWeight: 500,
    color: '#334155', marginBottom: '0.25rem', marginTop: '0.75rem',
};
const input: React.CSSProperties = {
    width: '100%', padding: '0.5rem 0.75rem', borderRadius: '0.375rem',
    border: '1px solid #cbd5e1', fontSize: '0.875rem', boxSizing: 'border-box',
};
const button: React.CSSProperties = {
    width: '100%', padding: '0.625rem', borderRadius: '0.375rem',
    background: '#2563eb', color: '#fff', border: 'none', cursor: 'pointer',
    fontSize: '0.875rem', fontWeight: 600, marginTop: '1.25rem',
};
const errorBox: React.CSSProperties = {
    background: '#fef2f2', border: '1px solid #fecaca', color: '#dc2626',
    borderRadius: '0.375rem', padding: '0.5rem 0.75rem', fontSize: '0.875rem',
    marginBottom: '0.5rem',
};
const link: React.CSSProperties = { color: '#2563eb', textDecoration: 'none', fontWeight: 500 };
