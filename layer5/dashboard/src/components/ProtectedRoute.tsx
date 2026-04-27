/**
 * ProtectedRoute — Dashboard Auth Guard
 * Checks Supabase session. Redirects to /auth?mode=login if unauthenticated.
 */
import React, { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { supabase } from '../supabaseClient';
import type { Session } from '@supabase/supabase-js';

interface Props {
    children: React.ReactNode;
}

export default function ProtectedRoute({ children }: Props) {
    const [session, setSession] = useState<Session | null | undefined>(undefined);
    const [accessStatus, setAccessStatus] = useState<string | null>(null);
    const [hasCompletedSurvey, setHasCompletedSurvey] = useState<boolean | null>(null);

    // Survey State
    const [agentType, setAgentType] = useState('');
    const [useCase, setUseCase] = useState('');
    const [estimatedVolume, setEstimatedVolume] = useState('');
    const [submitting, setSubmitting] = useState(false);

    useEffect(() => {
        let isMounted = true;
        let timeoutId: NodeJS.Timeout;

        const checkProfile = async (userId: string, attempts: number = 0) => {
            if (!isMounted) return;
            
            try {
                const { data, error } = await supabase
                    .from('user_profiles')
                    .select('access_status, agent_type, use_case, estimated_volume')
                    .eq('id', userId)
                    .single();

                if (!isMounted) return;

                if (data) {
                    setAccessStatus(data.access_status || 'pending');
                    const isSurveyComplete = Boolean(data.agent_type && data.use_case && data.estimated_volume);
                    setHasCompletedSurvey(isSurveyComplete);
                } else if (error && error.code === 'PGRST116') {
                    if (attempts < 5) {
                        timeoutId = setTimeout(() => checkProfile(userId, attempts + 1), 1000);
                    } else {
                        console.error('Profile creation timed out.');
                        setAccessStatus('error');
                    }
                } else {
                    console.error('Failed to fetch profile:', error);
                    setAccessStatus('error');
                }
            } catch (err) {
                console.error('Unexpected error checking profile:', err);
                if (isMounted) setAccessStatus('error');
            }
        };

        supabase.auth.getSession().then(({ data: { session } }) => {
            if (isMounted) {
                setSession(session);
                if (session) {
                    checkProfile(session.user.id, 0);
                } else {
                    setAccessStatus(null);
                }
            }
        });

        const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, newSession) => {
            if (isMounted) {
                setSession(newSession);
                if (newSession) {
                    checkProfile(newSession.user.id, 0);
                } else {
                    setAccessStatus(null);
                }
            }
        });

        return () => {
            isMounted = false;
            clearTimeout(timeoutId);
            subscription.unsubscribe();
        };
    }, []);

    const handleSurveySubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!session) return;
        setSubmitting(true);

        const { error } = await supabase
            .from('user_profiles')
            .update({
                agent_type: agentType,
                use_case: useCase,
                estimated_volume: estimatedVolume
            })
            .eq('id', session.user.id);

        if (!error) {
            setHasCompletedSurvey(true);
        }
        setSubmitting(false);
    };

    if (session === undefined || (session && accessStatus === null)) {
        return (
            <div style={{
                minHeight: '100vh',
                background: '#000000',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#888',
                fontFamily: 'monospace',
                fontSize: 12
            }}>
                <div style={{
                    width: 24,
                    height: 24,
                    border: '2px solid #00FF85',
                    borderTop: '2px solid transparent',
                    borderRadius: '50%',
                    animation: 'spin 1s linear infinite',
                    marginBottom: 16
                }} />
                <div>Verifying profile...</div>
                <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
            </div>
        );
    }

    if (accessStatus === 'error') {
        return (
            <div style={{
                minHeight: '100vh',
                background: '#000000',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexDirection: 'column',
                color: '#FFFFFF',
                fontFamily: "'Inter', system-ui, -apple-system, sans-serif",
                padding: 24,
                textAlign: 'center'
            }}>
                <svg width="48" height="48" viewBox="0 0 48 48" fill="none" style={{ marginBottom: 24 }}>
                    <circle cx="24" cy="24" r="24" fill="#FF4444" opacity="0.15" />
                    <path d="M24 16v8m0 8h.01M12 24c0-6.627 5.373-12 12-12s12 5.373 12 12-5.373 12-12 12-12-5.373-12-12z" stroke="#FF4444" strokeWidth="3" strokeLinecap="round" />
                </svg>
                <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 12 }}>Profile Loading Error</h1>
                <p style={{ color: '#888888', fontSize: 14, maxWidth: 400, lineHeight: 1.6, marginBottom: 24 }}>
                    We couldn't load your profile. This usually means the database migration (127) hasn't been applied yet, or the profile trigger failed.
                </p>
                <button 
                    onClick={() => supabase.auth.signOut()}
                    style={{
                        background: 'none',
                        border: '1px solid #1A1A1A',
                        color: '#888888',
                        padding: '10px 24px',
                        fontSize: 13,
                        cursor: 'pointer',
                        transition: 'color 150ms'
                    }}
                    onMouseEnter={e => e.currentTarget.style.color = '#FFFFFF'}
                    onMouseLeave={e => e.currentTarget.style.color = '#888888'}
                >
                    Sign out
                </button>
            </div>
        );
    }

    if (!session) {
        return <Navigate to="/auth?mode=login" replace />;
    }

    if (accessStatus === 'pending') {
        if (!hasCompletedSurvey) {
            // Render Questionnaire
            return (
                <div style={{
                    minHeight: '100vh',
                    background: '#000000',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#FFFFFF',
                    fontFamily: "'Inter', system-ui, -apple-system, sans-serif",
                    padding: 24,
                }}>
                    <div style={{ width: '100%', maxWidth: 480 }}>
                        <h1 style={{ fontSize: 24, fontWeight: 600, marginBottom: 8 }}>Tell us about your agent</h1>
                        <p style={{ color: '#888888', fontSize: 14, marginBottom: 32, lineHeight: 1.6 }}>
                            We review every application to allocate the right infrastructure. This takes less than a minute.
                        </p>

                        <form onSubmit={handleSurveySubmit} style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                            <div>
                                <label style={{ display: 'block', fontSize: 11, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.1em', color: '#888888', marginBottom: 8 }}>
                                    Type of Agent
                                </label>
                                <input
                                    type="text"
                                    value={agentType}
                                    onChange={(e) => setAgentType(e.target.value)}
                                    placeholder="e.g. LangChain customer support agent, AutoGen coding assistant"
                                    required
                                    style={{
                                        width: '100%', height: 48, background: '#111111', border: '1px solid #1A1A1A', color: '#FFFFFF', padding: '12px 16px',
                                        fontFamily: "'JetBrains Mono', 'Fira Code', monospace", fontSize: 13, outline: 'none', transition: 'border-color 150ms'
                                    }}
                                    onFocus={(e) => e.target.style.borderColor = '#00FF85'}
                                    onBlur={(e) => e.target.style.borderColor = '#1A1A1A'}
                                />
                            </div>

                            <div>
                                <label style={{ display: 'block', fontSize: 11, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.1em', color: '#888888', marginBottom: 8 }}>
                                    How many outcomes will your agent log daily?
                                </label>
                                <input
                                    type="text"
                                    value={estimatedVolume}
                                    onChange={(e) => setEstimatedVolume(e.target.value)}
                                    placeholder="e.g. < 1k, 10k, 100k+"
                                    required
                                    style={{
                                        width: '100%', height: 48, background: '#111111', border: '1px solid #1A1A1A', color: '#FFFFFF', padding: '12px 16px',
                                        fontFamily: "'JetBrains Mono', 'Fira Code', monospace", fontSize: 13, outline: 'none', transition: 'border-color 150ms'
                                    }}
                                    onFocus={(e) => e.target.style.borderColor = '#00FF85'}
                                    onBlur={(e) => e.target.style.borderColor = '#1A1A1A'}
                                />
                            </div>

                            <div>
                                <label style={{ display: 'block', fontSize: 11, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.1em', color: '#888888', marginBottom: 8 }}>
                                    What's the biggest mistake your agent keeps making?
                                </label>
                                <textarea
                                    value={useCase}
                                    onChange={(e) => setUseCase(e.target.value)}
                                    placeholder="e.g. It retries the same failed API call 5 times before escalating to a human"
                                    required
                                    style={{
                                        width: '100%', height: 100, background: '#111111', border: '1px solid #1A1A1A', color: '#FFFFFF', padding: '12px 16px',
                                        fontFamily: "'JetBrains Mono', 'Fira Code', monospace", fontSize: 13, outline: 'none', transition: 'border-color 150ms', resize: 'vertical'
                                    }}
                                    onFocus={(e) => e.target.style.borderColor = '#00FF85'}
                                    onBlur={(e) => e.target.style.borderColor = '#1A1A1A'}
                                />
                            </div>

                            <button
                                type="submit"
                                disabled={submitting}
                                style={{
                                    width: '100%', height: 48, background: '#00FF85', color: '#000000', border: 'none',
                                    fontFamily: "'Inter', system-ui, -apple-system, sans-serif", fontSize: 14, fontWeight: 700,
                                    cursor: submitting ? 'wait' : 'pointer', marginTop: 8, opacity: submitting ? 0.8 : 1, transition: 'background 150ms'
                                }}
                                onMouseEnter={(e) => { if(!submitting) e.currentTarget.style.background = '#FFFFFF' }}
                                onMouseLeave={(e) => { if(!submitting) e.currentTarget.style.background = '#00FF85' }}
                            >
                                {submitting ? 'Saving...' : 'Join Waitlist'}
                            </button>

                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 }}>
                                <a
                                    href="/docs"
                                    style={{ color: '#00FF85', fontSize: 13, textDecoration: 'none', borderBottom: '1px solid rgba(0,255,133,0.3)', transition: 'border-color 150ms' }}
                                    onMouseEnter={e => e.currentTarget.style.borderColor = '#00FF85'}
                                    onMouseLeave={e => e.currentTarget.style.borderColor = 'rgba(0,255,133,0.3)'}
                                >
                                    Learn more →
                                </a>
                                <button
                                    type="button"
                                    onClick={() => supabase.auth.signOut()}
                                    style={{ background: 'none', border: 'none', color: '#555555', fontSize: 13, cursor: 'pointer' }}
                                    onMouseEnter={e => e.currentTarget.style.color = '#888888'}
                                    onMouseLeave={e => e.currentTarget.style.color = '#555555'}
                                >
                                    Sign out
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            );
        }

        // Render "You are on the waitlist" screen
        return (
            <div style={{
                minHeight: '100vh',
                background: '#000000',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexDirection: 'column',
                color: '#FFFFFF',
                fontFamily: "'Inter', system-ui, -apple-system, sans-serif",
                padding: 24,
                textAlign: 'center'
            }}>
                <svg width="48" height="48" viewBox="0 0 48 48" fill="none" style={{ marginBottom: 24 }}>
                    <circle cx="24" cy="24" r="24" fill="#00FF85" opacity="0.15" />
                    <path d="M24 14v10l6 6" stroke="#00FF85" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <h1 style={{ fontSize: 24, fontWeight: 600, marginBottom: 12 }}>You are on the waitlist.</h1>
                <p style={{ color: '#888888', fontSize: 15, maxWidth: 400, lineHeight: 1.6, marginBottom: 32 }}>
                    Thanks for signing up! We are currently rolling out access to a limited number of developers. We will email you when your spot is ready.
                </p>
                <button 
                    onClick={() => supabase.auth.signOut()}
                    style={{
                        background: 'none',
                        border: '1px solid #1A1A1A',
                        color: '#888888',
                        padding: '10px 24px',
                        fontSize: 13,
                        cursor: 'pointer',
                        transition: 'color 150ms',
                        fontFamily: "'Inter', system-ui, -apple-system, sans-serif"
                    }}
                    onMouseEnter={e => e.currentTarget.style.color = '#FFFFFF'}
                    onMouseLeave={e => e.currentTarget.style.color = '#888888'}
                >
                    Sign out
                </button>
            </div>
        );
    }

    return <>{children}</>;
}
