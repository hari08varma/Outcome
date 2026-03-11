import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route, Link, Navigate, useNavigate } from 'react-router-dom';
import ScoreLeaderboard from './pages/index';
import OutcomeHistory from './pages/outcomes';
import AuditTrail from './pages/audit';
import TrustStatus from './pages/trust';
import LoginPage from './pages/auth/login';
import SignupPage from './pages/auth/signup';
import LogoutPage from './pages/auth/logout';
import ApiKeysPage from './pages/settings/api-keys';
import NotificationSettings from './pages/settings/notifications';
import AlertsPage from './pages/alerts';
import SimulatePage from './pages/simulate';
import AuthPage from './pages/Auth';
import ProtectedRoute from './components/ProtectedRoute';
import { supabase } from './supabaseClient';
import { useToast } from './hooks/useToast';
import { ToastContext, ToastContainer } from './components/Toast';

function Nav() {
    const navigate = useNavigate();
    const [userEmail, setUserEmail] = useState<string | null>(null);

    useEffect(() => {
        supabase.auth.getSession().then(({ data: { session } }) => {
            setUserEmail(session?.user?.email ?? null);
        });
        const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
            setUserEmail(session?.user?.email ?? null);
        });
        return () => subscription.unsubscribe();
    }, []);

    const handleSignOut = async () => {
        await supabase.auth.signOut();
        navigate('/auth?mode=login');
    };

    return (
        <nav style={{
            display: 'flex', gap: '1.5rem', padding: '1rem 2rem',
            borderBottom: '1px solid #1A1A1A', background: '#050505',
            fontFamily: "'Inter', system-ui, sans-serif", alignItems: 'center',
        }}>
            <strong style={{ fontSize: '1.1rem', color: '#FFFFFF', fontFamily: "'JetBrains Mono', monospace" }}>
                Layer<span style={{ color: '#00FF85' }}>5</span>
            </strong>
            <Link to="/dashboard" style={navLink}>Scores</Link>
            <Link to="/outcomes" style={navLink}>Outcomes</Link>
            <Link to="/audit" style={navLink}>Audit</Link>
            <Link to="/trust" style={navLink}>Trust</Link>
            <Link to="/alerts" style={navLink}>⚠ Alerts</Link>
            <Link to="/simulate" style={{ ...navLink, display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>Simulate <span style={{ fontSize: '9px', background: 'rgba(251,191,36,0.2)', color: '#fbbf24', padding: '1px 5px', borderRadius: '9999px', fontWeight: 700, letterSpacing: '0.05em' }}>✦ NEW</span></Link>
            <Link to="/settings/api-keys" style={navLink}>API Keys</Link>
            <Link to="/settings/notifications" style={navLink}>Notifications</Link>
            <div style={{ flex: 1 }} />
            {userEmail && (
                <span style={{
                    fontSize: '11px', fontFamily: "'JetBrains Mono', monospace",
                    color: '#888888',
                }}>
                    {userEmail}
                </span>
            )}
            <button
                onClick={handleSignOut}
                style={{
                    background: 'none', border: 'none', cursor: 'pointer',
                    fontSize: '11px', fontFamily: "'JetBrains Mono', monospace",
                    color: '#888888', textTransform: 'uppercase', letterSpacing: '0.15em',
                    padding: 0, transition: 'color 150ms',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.color = '#00FF85')}
                onMouseLeave={(e) => (e.currentTarget.style.color = '#888888')}
            >
                Sign out
            </button>
        </nav>
    );
}

const navLink: React.CSSProperties = {
    textDecoration: 'none', color: '#888888', fontWeight: 500, fontSize: '0.9rem',
};

function App() {
    const { toasts, showToast, dismissToast } = useToast();

    return (
        <ToastContext.Provider value={{ toasts, showToast, dismissToast }}>
        <BrowserRouter>
            <Routes>
                {/* Public routes — no auth required */}
                <Route path="/auth" element={<AuthPage />} />
                <Route path="/login" element={<LoginPage />} />
                <Route path="/signup" element={<SignupPage />} />
                <Route path="/logout" element={<LogoutPage />} />

                {/* Root redirects to auth */}
                <Route path="/" element={<Navigate to="/auth" replace />} />

                {/* Protected routes — require Supabase session */}
                <Route path="/*" element={
                    <ProtectedRoute>
                        <Nav />
                        <main style={{ padding: '2rem', fontFamily: "'Inter', system-ui, sans-serif", maxWidth: '1200px', margin: '0 auto', background: '#000000', minHeight: 'calc(100vh - 60px)', color: '#FFFFFF' }}>
                            <Routes>
                                <Route path="/dashboard" element={<ScoreLeaderboard />} />
                                <Route path="/outcomes" element={<OutcomeHistory />} />
                                <Route path="/audit" element={<AuditTrail />} />
                                <Route path="/trust" element={<TrustStatus />} />
                                <Route path="/alerts" element={<AlertsPage />} />
                                <Route path="/simulate" element={<SimulatePage />} />
                                <Route path="/settings/api-keys" element={<ApiKeysPage />} />
                                <Route path="/settings/notifications" element={<NotificationSettings />} />
                                <Route path="*" element={<Navigate to="/dashboard" replace />} />
                            </Routes>
                        </main>
                    </ProtectedRoute>
                } />
            </Routes>
        </BrowserRouter>
        <ToastContainer toasts={toasts} onDismiss={dismissToast} />
        </ToastContext.Provider>
    );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
        <App />
    </React.StrictMode>
);
