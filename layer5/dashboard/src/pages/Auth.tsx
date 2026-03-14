/**
 * Auth.tsx — Split-screen auth page
 * Supports login/signup via URL param, Google OAuth + email/password.
 */
import React, { useEffect, useState, useRef } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { supabase } from '../supabaseClient';

// ─── Design tokens ───────────────────────────────────
const C = {
    bg: '#000000',
    surface: '#111111',
    border: '#1A1A1A',
    accent: '#00FF85',
    muted: '#888888',
    error: '#FF4444',
    white: '#FFFFFF',
    placeholder: '#444444',
    brandPanel: '#050505',
};

const FONT_SANS = "'Inter', system-ui, -apple-system, sans-serif";
const FONT_MONO = "'JetBrains Mono', 'Fira Code', monospace";

// ─── Terminal animation data ─────────────────────────
const TERMINAL_STEPS = [
    { type: 'cmd', text: "> layer5.getScores({ agent_id: 'bot-1' })" },
    {
        type: 'response', lines: [
            { icon: '✓', text: 'update_app', score: '0.85', note: '← recommended', color: C.accent },
            { icon: '○', text: 'clear_cache', score: '0.61', note: '', color: C.muted },
            { icon: '✗', text: 'restart', score: '0.07', note: '← avoid', color: C.error },
        ]
    },
    { type: 'cmd', text: '> layer5.logOutcome({ success: true })' },
    { type: 'result', text: '✓ Score updated. Model learning...' },
];

// ─── Typing animation hook ──────────────────────────
function useTerminalAnimation() {
    const [visibleLines, setVisibleLines] = useState<Array<{ text: string; style: React.CSSProperties }>>([]);
    const [typingText, setTypingText] = useState('');
    const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

    useEffect(() => {
        let step = 0;
        let charIdx = 0;
        let lineBuffer: Array<{ text: string; style: React.CSSProperties }> = [];
        let paused = false;

        const tick = () => {
            if (paused) return;

            if (step === 0) {
                // Typing first command
                const cmd = TERMINAL_STEPS[0].text as string;
                if (charIdx <= cmd.length) {
                    setTypingText(cmd.slice(0, charIdx));
                    charIdx++;
                } else {
                    lineBuffer = [{ text: cmd, style: { color: C.accent, fontFamily: FONT_MONO, fontSize: 12 } }];
                    setVisibleLines([...lineBuffer]);
                    setTypingText('');
                    step = 1;
                    charIdx = 0;
                }
            } else if (step === 1) {
                // Show response lines one by one
                const resp = TERMINAL_STEPS[1];
                if (charIdx < resp.lines!.length) {
                    const l = resp.lines![charIdx];
                    lineBuffer.push({
                        text: `  ${l.icon} ${l.text.padEnd(16)} score: ${l.score}  ${l.note}`,
                        style: { color: l.color, fontFamily: FONT_MONO, fontSize: 12 },
                    });
                    setVisibleLines([...lineBuffer]);
                    charIdx++;
                } else {
                    step = 2;
                    charIdx = 0;
                }
            } else if (step === 2) {
                // Typing second command
                const cmd = TERMINAL_STEPS[2].text as string;
                if (charIdx <= cmd.length) {
                    setTypingText(cmd.slice(0, charIdx));
                    charIdx++;
                } else {
                    lineBuffer.push({ text: cmd, style: { color: C.accent, fontFamily: FONT_MONO, fontSize: 12 } });
                    setVisibleLines([...lineBuffer]);
                    setTypingText('');
                    step = 3;
                    charIdx = 0;
                }
            } else if (step === 3) {
                // Show result
                if (charIdx === 0) {
                    lineBuffer.push({
                        text: TERMINAL_STEPS[3].text!,
                        style: { color: C.accent, fontFamily: FONT_MONO, fontSize: 12 },
                    });
                    setVisibleLines([...lineBuffer]);
                    charIdx = 1;
                } else if (charIdx < 20) {
                    charIdx++;
                } else {
                    // Reset
                    paused = true;
                    setTimeout(() => {
                        lineBuffer = [];
                        setVisibleLines([]);
                        setTypingText('');
                        step = 0;
                        charIdx = 0;
                        paused = false;
                    }, 1200);
                }
            }
        };

        intervalRef.current = setInterval(tick, 80);
        return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
    }, []);

    return { visibleLines, typingText };
}

// ─── Google logo SVG ─────────────────────────────────
function GoogleLogo() {
    return (
        <svg width="18" height="18" viewBox="0 0 48 48">
            <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
            <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
            <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
            <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
        </svg>
    );
}

// ─── Checkmark SVG ───────────────────────────────────
function CheckmarkIcon() {
    return (
        <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
            <circle cx="24" cy="24" r="24" fill={C.accent} opacity={0.15} />
            <path d="M14 24l7 7 13-13" stroke={C.accent} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    );
}

// ─── Spinner ─────────────────────────────────────────
function Spinner() {
    return (
        <span style={{
            display: 'inline-block', width: 16, height: 16,
            border: `2px solid ${C.bg}`, borderTop: '2px solid transparent',
            borderRadius: '50%', animation: 'auth-spin 1s linear infinite',
            marginRight: 8, verticalAlign: 'middle',
        }} />
    );
}

// ═══════════════════════════════════════════════════════
// AUTH PAGE COMPONENT
// ═══════════════════════════════════════════════════════
export default function Auth() {
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const mode = searchParams.get('mode') === 'login' ? 'login' : 'signup';

    // Form state
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [fullName, setFullName] = useState('');
    const [companyName, setCompanyName] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [fieldError, setFieldError] = useState<string | null>(null);
    const [showVerification, setShowVerification] = useState(false);
    const [forgotPassword, setForgotPassword] = useState(false);
    const [resetSent, setResetSent] = useState(false);
    const [success, setSuccess] = useState(false);

    // Session check — redirect if already logged in
    useEffect(() => {
        supabase.auth.getSession().then(({ data: { session } }) => {
            if (session) navigate('/dashboard');
        });

        const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
            if (event === 'SIGNED_IN' && session) {
                navigate('/dashboard');
            }
        });

        return () => subscription.unsubscribe();
    }, [navigate]);

    // Clear errors when mode changes
    useEffect(() => {
        setError(null);
        setFieldError(null);
        setForgotPassword(false);
        setResetSent(false);
        setShowVerification(false);
        setSuccess(false);
    }, [mode]);

    // ── Handlers ──────────────────────────────────────
    const handleGoogleAuth = async () => {
        setLoading(true);
        setError(null);
        const { error } = await supabase.auth.signInWithOAuth({
            provider: 'google',
            options: {
                redirectTo: `${window.location.origin}/dashboard`,
                queryParams: { access_type: 'offline', prompt: 'consent' },
            },
        });
        if (error) setError(error.message);
        setLoading(false);
    };

    const handleSignup = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        setFieldError(null);

        const { data, error } = await supabase.auth.signUp({
            email,
            password,
            options: {
                data: { full_name: fullName, company_name: companyName },
                emailRedirectTo: `${window.location.origin}/dashboard`,
            },
        });

        if (error) {
            mapError(error.message);
        } else if (data.user && !data.session) {
            setShowVerification(true);
        } else {
            setSuccess(true);
            setTimeout(() => navigate('/dashboard'), 800);
        }
        setLoading(false);
    };

    const handleLogin = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        setFieldError(null);

        const { error } = await supabase.auth.signInWithPassword({ email, password });

        if (error) {
            mapError(error.message);
        } else {
            setSuccess(true);
            setTimeout(() => navigate('/dashboard'), 800);
        }
        setLoading(false);
    };

    const handlePasswordReset = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        const { error } = await supabase.auth.resetPasswordForEmail(email, {
            redirectTo: `${window.location.origin}/auth/reset`,
        });
        if (!error) setResetSent(true);
        else setError(error.message);
        setLoading(false);
    };

    const handleResendVerification = async () => {
        setLoading(true);
        const { error } = await supabase.auth.resend({ type: 'signup', email });
        if (error) setError(error.message);
        setLoading(false);
    };

    function mapError(msg: string) {
        if (msg.includes('Invalid login credentials')) {
            setFieldError('Wrong email or password. Try again.');
        } else if (msg.includes('User already registered')) {
            setFieldError('Account exists.');
        } else if (msg.includes('Email not confirmed')) {
            setError('Check your email to verify your account.');
        } else if (msg.includes('rate limit') || msg.includes('Rate limit')) {
            setError('Too many attempts. Wait 60 seconds.');
        } else if (msg.includes('fetch') || msg.includes('network') || msg.includes('Failed')) {
            setError('Connection failed. Check your internet.');
        } else {
            setError(msg);
        }
    }

    // ── Render ────────────────────────────────────────
    return (
        <div style={{ display: 'flex', minHeight: '100vh', background: C.bg }}>
            <style>{`
                @keyframes auth-spin { to { transform: rotate(360deg); } }
                @keyframes auth-fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
                @keyframes auth-blink { 0%,100% { opacity: 1; } 50% { opacity: 0; } }
                @media (max-width: 768px) { .auth-brand-panel { display: none !important; } }
            `}</style>

            {/* ─── LEFT BRAND PANEL (hidden on mobile) ──── */}
            <div className="auth-brand-panel" style={{
                flex: '0 0 60%',
                background: C.brandPanel,
                backgroundImage:
                    'linear-gradient(rgba(0,255,133,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(0,255,133,0.03) 1px, transparent 1px)',
                backgroundSize: '32px 32px',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'center',
                alignItems: 'center',
                padding: '48px',
                position: 'relative',
            }}>
                {/* Wordmark */}
                <div style={{ position: 'absolute', top: 32, left: 40 }}>
                    <span style={{ fontFamily: FONT_MONO, fontSize: 18, fontWeight: 700, color: C.white, letterSpacing: '-0.02em' }}>
                        Layer<span style={{ color: C.accent }}>5</span>
                    </span>
                </div>

                {/* Terminal window */}
                <TerminalWindow />

                {/* Micro-stats */}
                <div style={{ display: 'flex', gap: 32, marginTop: 32 }}>
                    {['105 tests passing', '<5ms p99', 'append-only'].map((s) => (
                        <span key={s} style={{ fontFamily: FONT_MONO, fontSize: 10, color: C.muted, letterSpacing: '0.05em' }}>{s}</span>
                    ))}
                </div>

                {/* Bottom attribution */}
                <div style={{ position: 'absolute', bottom: 32, fontFamily: FONT_SANS, fontSize: 12, color: C.muted }}>
                    Trusted by engineers building production AI
                </div>
            </div>

            {/* ─── RIGHT AUTH PANEL ───────────────────── */}
            <div style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '48px',
                background: C.bg,
                minHeight: '100vh',
            }}>
                <div style={{ width: '100%', maxWidth: 400 }}>
                    {showVerification ? (
                        <VerificationState email={email} onResend={handleResendVerification} loading={loading} />
                    ) : forgotPassword ? (
                        <ForgotPasswordForm
                            email={email}
                            setEmail={setEmail}
                            loading={loading}
                            error={error}
                            resetSent={resetSent}
                            onSubmit={handlePasswordReset}
                            onBack={() => setForgotPassword(false)}
                        />
                    ) : (
                        <>
                            {/* Header */}
                            <h1 style={{ fontFamily: FONT_SANS, fontSize: 24, fontWeight: 600, color: C.white, margin: 0, lineHeight: 1.3 }}>
                                {mode === 'signup' ? 'Start building smarter agents.' : 'Welcome back.'}
                            </h1>
                            <p style={{ fontFamily: FONT_SANS, fontSize: 14, color: C.muted, marginTop: 8, marginBottom: 32 }}>
                                {mode === 'signup' ? 'Free during beta. No credit card required.' : 'Sign in to your Layer5 dashboard.'}
                            </p>

                            {/* Google OAuth */}
                            <button
                                onClick={handleGoogleAuth}
                                disabled={loading}
                                style={{
                                    width: '100%',
                                    height: 48,
                                    background: C.white,
                                    color: C.bg,
                                    border: '1px solid #E0E0E0',
                                    borderRadius: 0,
                                    fontFamily: FONT_SANS,
                                    fontSize: 14,
                                    fontWeight: 500,
                                    cursor: 'pointer',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    gap: 10,
                                    transition: 'background 150ms',
                                }}
                                onMouseEnter={(e) => (e.currentTarget.style.background = '#F5F5F5')}
                                onMouseLeave={(e) => (e.currentTarget.style.background = C.white)}
                            >
                                <GoogleLogo />
                                Continue with Google
                            </button>

                            {/* Divider */}
                            <div style={{ position: 'relative', margin: '24px 0' }}>
                                <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center' }}>
                                    <div style={{ width: '100%', borderTop: `1px solid ${C.border}` }} />
                                </div>
                                <div style={{ position: 'relative', display: 'flex', justifyContent: 'center' }}>
                                    <span style={{
                                        background: C.bg,
                                        padding: '0 12px',
                                        fontSize: 11,
                                        color: C.muted,
                                        fontFamily: FONT_MONO,
                                        textTransform: 'uppercase',
                                        letterSpacing: '0.15em',
                                    }}>
                                        or continue with email
                                    </span>
                                </div>
                            </div>

                            {/* Global error banner */}
                            {error && (
                                <div style={{
                                    padding: '10px 14px',
                                    marginBottom: 16,
                                    background: 'rgba(255,68,68,0.08)',
                                    borderLeft: `3px solid ${C.error}`,
                                    fontFamily: FONT_MONO,
                                    fontSize: 11,
                                    color: C.error,
                                    animation: 'auth-fadeIn 200ms',
                                }}>
                                    {error}
                                </div>
                            )}

                            {/* Email form */}
                            <form onSubmit={mode === 'signup' ? handleSignup : handleLogin}>
                                {mode === 'signup' && (
                                    <>
                                        <FormField label="Full Name" value={fullName} onChange={setFullName} placeholder="Jane Smith" type="text" />
                                        <FormField label="Company Name" value={companyName} onChange={setCompanyName} placeholder="Acme Corp" type="text" />
                                    </>
                                )}
                                <FormField label="Work Email" value={email} onChange={setEmail} placeholder="you@company.com" type="email"
                                    error={fieldError?.includes('Account exists') ? fieldError : undefined}
                                    errorLink={fieldError?.includes('Account exists') ? { text: 'Sign in instead', href: '/auth?mode=login' } : undefined}
                                />
                                <FormField label="Password" value={password} onChange={setPassword}
                                    placeholder={mode === 'signup' ? 'Min 8 characters' : '••••••••'}
                                    type="password"
                                    error={fieldError?.includes('Wrong email') ? fieldError : undefined}
                                />
                                {mode === 'login' && (
                                    <div style={{ textAlign: 'right', marginTop: -8, marginBottom: 16 }}>
                                        <button type="button" onClick={() => setForgotPassword(true)}
                                            style={{ background: 'none', border: 'none', color: C.muted, fontFamily: FONT_SANS, fontSize: 11, cursor: 'pointer', padding: 0 }}
                                            onMouseEnter={(e) => (e.currentTarget.style.color = C.accent)}
                                            onMouseLeave={(e) => (e.currentTarget.style.color = C.muted)}
                                        >
                                            Forgot password?
                                        </button>
                                    </div>
                                )}

                                {/* Submit */}
                                <button type="submit" disabled={loading}
                                    style={{
                                        width: '100%',
                                        height: 48,
                                        background: success ? C.accent : C.accent,
                                        color: C.bg,
                                        border: 'none',
                                        fontFamily: FONT_SANS,
                                        fontSize: 14,
                                        fontWeight: 700,
                                        cursor: loading ? 'wait' : 'pointer',
                                        transition: 'all 150ms',
                                        marginTop: 8,
                                        opacity: loading ? 0.8 : 1,
                                    }}
                                    onMouseEnter={(e) => { if (!loading) e.currentTarget.style.background = C.white; }}
                                    onMouseLeave={(e) => { if (!loading) e.currentTarget.style.background = C.accent; }}
                                >
                                    {loading ? (
                                        <><Spinner />{mode === 'signup' ? 'Creating account...' : 'Signing in...'}</>
                                    ) : success ? (
                                        '✓ Redirecting...'
                                    ) : (
                                        mode === 'signup' ? 'Create Account' : 'Sign In'
                                    )}
                                </button>
                            </form>

                            {/* Toggle link */}
                            <p style={{ textAlign: 'center', marginTop: 24, fontFamily: FONT_SANS, fontSize: 12, color: C.muted }}>
                                {mode === 'signup' ? (
                                    <>Already have an account?{' '}
                                        <a href="/auth?mode=login" style={{ color: C.accent, textDecoration: 'none' }}>Sign in</a>
                                    </>
                                ) : (
                                    <>Don&apos;t have an account?{' '}
                                        <a href="/auth?mode=signup" style={{ color: C.accent, textDecoration: 'none' }}>Get started free</a>
                                    </>
                                )}
                            </p>

                            {/* Legal links */}
                            <p style={{ textAlign: 'center', marginTop: 32, fontFamily: FONT_SANS, fontSize: 11, color: C.muted }}>
                                By signing up, you agree to our{' '}
                                <a href="/terms" target="_blank" rel="noreferrer" style={{ color: C.muted, textDecoration: 'underline' }}>Terms</a>
                                {' '}and{' '}
                                <a href="/privacy" target="_blank" rel="noreferrer" style={{ color: C.muted, textDecoration: 'underline' }}>Privacy Policy</a>.
                            </p>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}

// ═══════════════════════════════════════════════════════
// SUB-COMPONENTS
// ═══════════════════════════════════════════════════════

function TerminalWindow() {
    const { visibleLines, typingText } = useTerminalAnimation();
    return (
        <div style={{
            width: '100%',
            maxWidth: 480,
            background: '#0A0A0A',
            border: `1px solid ${C.border}`,
            borderRadius: 6,
            overflow: 'hidden',
        }}>
            {/* Title bar */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 14px', borderBottom: `1px solid ${C.border}` }}>
                <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#FF5F57' }} />
                <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#FEBC2E' }} />
                <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#28C840' }} />
                <span style={{ flex: 1 }} />
                <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: C.muted }}>layer5-cli</span>
            </div>
            {/* Content */}
            <div style={{ padding: '16px 18px', minHeight: 140 }}>
                {visibleLines.map((line, i) => (
                    <div key={i} style={{ ...line.style, lineHeight: 1.8, whiteSpace: 'pre' }}>{line.text}</div>
                ))}
                {typingText && (
                    <div style={{ color: C.accent, fontFamily: FONT_MONO, fontSize: 12, lineHeight: 1.8, whiteSpace: 'pre' }}>
                        {typingText}<span style={{ animation: 'auth-blink 1s step-end infinite' }}>▊</span>
                    </div>
                )}
            </div>
        </div>
    );
}

function FormField({ label, value, onChange, placeholder, type, error, errorLink }: {
    label: string;
    value: string;
    onChange: (v: string) => void;
    placeholder: string;
    type: string;
    error?: string;
    errorLink?: { text: string; href: string };
}) {
    const [focused, setFocused] = useState(false);

    return (
        <div style={{ marginBottom: 16 }}>
            <label style={{
                display: 'block',
                fontFamily: FONT_SANS,
                fontSize: 11,
                fontWeight: 500,
                textTransform: 'uppercase',
                letterSpacing: '0.1em',
                color: C.muted,
                marginBottom: 6,
            }}>
                {label}
            </label>
            <input
                type={type}
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder={placeholder}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                required
                minLength={type === 'password' ? 8 : undefined}
                style={{
                    width: '100%',
                    height: 48,
                    background: C.surface,
                    border: `1px solid ${error ? C.error : focused ? C.accent : C.border}`,
                    color: C.white,
                    padding: '12px 16px',
                    fontFamily: FONT_MONO,
                    fontSize: 13,
                    outline: 'none',
                    boxSizing: 'border-box',
                    boxShadow: focused ? `0 0 0 1px rgba(0,255,133,0.2)` : error ? `0 0 0 1px rgba(255,68,68,0.2)` : 'none',
                    transition: 'border-color 150ms, box-shadow 150ms',
                }}
            />
            {error && (
                <div style={{
                    fontFamily: FONT_MONO, fontSize: 11, color: C.error,
                    marginTop: 6, animation: 'auth-fadeIn 200ms',
                }}>
                    {error}
                    {errorLink && (
                        <> <a href={errorLink.href} style={{ color: C.accent, textDecoration: 'none' }}>{errorLink.text}</a></>
                    )}
                </div>
            )}
        </div>
    );
}

function VerificationState({ email, onResend, loading }: { email: string; onResend: () => void; loading: boolean }) {
    return (
        <div style={{ textAlign: 'center', animation: 'auth-fadeIn 300ms' }}>
            <CheckmarkIcon />
            <h2 style={{ fontFamily: FONT_SANS, fontSize: 22, fontWeight: 600, color: C.white, marginTop: 24, marginBottom: 8 }}>
                Check your email.
            </h2>
            <p style={{ fontFamily: FONT_SANS, fontSize: 14, color: C.muted, lineHeight: 1.6 }}>
                We sent a verification link to:<br />
                <strong style={{ color: C.white }}>{email}</strong>
            </p>
            <p style={{ fontFamily: FONT_SANS, fontSize: 13, color: C.muted, marginTop: 16, lineHeight: 1.6 }}>
                Click the link to activate your account<br />and access your dashboard.
            </p>
            <button onClick={onResend} disabled={loading}
                style={{
                    marginTop: 24,
                    background: 'none',
                    border: `1px solid ${C.border}`,
                    color: C.muted,
                    padding: '10px 24px',
                    fontFamily: FONT_SANS,
                    fontSize: 13,
                    cursor: 'pointer',
                    transition: 'border-color 150ms',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.borderColor = C.accent)}
                onMouseLeave={(e) => (e.currentTarget.style.borderColor = C.border)}
            >
                {loading ? 'Sending...' : 'Resend email'}
            </button>
            <p style={{ fontFamily: FONT_SANS, fontSize: 12, color: C.muted, marginTop: 16 }}>
                Wrong email?{' '}
                <a href="/auth?mode=signup" style={{ color: C.accent, textDecoration: 'none' }}>Go back</a>
            </p>
        </div>
    );
}

function ForgotPasswordForm({ email, setEmail, loading, error, resetSent, onSubmit, onBack }: {
    email: string;
    setEmail: (v: string) => void;
    loading: boolean;
    error: string | null;
    resetSent: boolean;
    onSubmit: (e: React.FormEvent) => void;
    onBack: () => void;
}) {
    if (resetSent) {
        return (
            <div style={{ animation: 'auth-fadeIn 300ms' }}>
                <CheckmarkIcon />
                <h2 style={{ fontFamily: FONT_SANS, fontSize: 22, fontWeight: 600, color: C.white, marginTop: 24, marginBottom: 8 }}>
                    Reset link sent.
                </h2>
                <p style={{ fontFamily: FONT_SANS, fontSize: 14, color: C.muted, lineHeight: 1.6 }}>
                    Check your inbox for a password reset link.
                </p>
                <button onClick={onBack}
                    style={{ background: 'none', border: 'none', color: C.accent, fontFamily: FONT_SANS, fontSize: 13, cursor: 'pointer', marginTop: 20, padding: 0 }}>
                    ← Back to sign in
                </button>
            </div>
        );
    }

    return (
        <div style={{ animation: 'auth-fadeIn 300ms' }}>
            <h2 style={{ fontFamily: FONT_SANS, fontSize: 22, fontWeight: 600, color: C.white, marginBottom: 8 }}>
                Reset your password.
            </h2>
            <p style={{ fontFamily: FONT_SANS, fontSize: 14, color: C.muted, marginBottom: 32, lineHeight: 1.6 }}>
                Enter your email and we&apos;ll send a reset link.
            </p>
            {error && (
                <div style={{
                    padding: '10px 14px',
                    marginBottom: 16,
                    background: 'rgba(255,68,68,0.08)',
                    borderLeft: `3px solid ${C.error}`,
                    fontFamily: FONT_MONO,
                    fontSize: 11,
                    color: C.error,
                }}>
                    {error}
                </div>
            )}
            <form onSubmit={onSubmit}>
                <FormField label="Work Email" value={email} onChange={setEmail} placeholder="you@company.com" type="email" />
                <button type="submit" disabled={loading}
                    style={{
                        width: '100%', height: 48, background: C.accent, color: C.bg,
                        border: 'none', fontFamily: FONT_SANS, fontSize: 14, fontWeight: 700,
                        cursor: loading ? 'wait' : 'pointer', marginTop: 8,
                    }}>
                    {loading ? <><Spinner />Sending...</> : 'Send Reset Link'}
                </button>
            </form>
            <button onClick={onBack}
                style={{ background: 'none', border: 'none', color: C.accent, fontFamily: FONT_SANS, fontSize: 13, cursor: 'pointer', marginTop: 20, padding: 0 }}>
                ← Back to sign in
            </button>
        </div>
    );
}
