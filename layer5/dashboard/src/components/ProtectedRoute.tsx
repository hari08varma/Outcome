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

        async function fetchSession() {
            const { data: { session } } = await supabase.auth.getSession();
            if (isMounted) setSession(session);

            if (session) {
                const { data } = await supabase
                    .from('user_profiles')
                    .select('access_status, agent_type')
                    .eq('id', session.user.id)
                    .single();
                
                if (isMounted && data) {
                    setAccessStatus(data.access_status);
                    setHasCompletedSurvey(!!data.agent_type);
                }
            }
        }

        fetchSession();

        const { data: { subscription } } = supabase.auth.onAuthStateChange(async (_event, newSession) => {
            setSession(newSession);
            if (newSession) {
                const { data } = await supabase
                    .from('user_profiles')
                    .select('access_status, agent_type')
                    .eq('id', newSession.user.id)
                    .single();
                if (data) {
                    setAccessStatus(data.access_status);
                    setHasCompletedSurvey(!!data.agent_type);
                }
            } else {
                setAccessStatus(null);
                setHasCompletedSurvey(null);
            }
        });

        return () => {
            isMounted = false;
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
                alignItems: 'center',
                justifyContent: 'center',
            }}>
                <div style={{
                    width: 16,
                    height: 16,
                    border: '2px solid #00FF85',
                    borderTop: '2px solid transparent',
                    borderRadius: '50%',
                    animation: 'spin 1s linear infinite',
                }} />
                <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
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
                        <h1 style={{ fontSize: 24, fontWeight: 600, marginBottom: 8 }}>One last step.</h1>
                        <p style={{ color: '#888888', fontSize: 14, marginBottom: 32, lineHeight: 1.6 }}>
                            Before we grant access, we need to know a little bit about what you're building so we can allocate the right resources.
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
                                    placeholder="e.g. Copilot, Autonomous Task Agent"
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
                                    Why do you want to use LayerInfinite?
                                </label>
                                <textarea
                                    value={useCase}
                                    onChange={(e) => setUseCase(e.target.value)}
                                    placeholder="e.g. I need to track which agent actions lead to user conversions"
                                    required
                                    style={{
                                        width: '100%', height: 100, background: '#111111', border: '1px solid #1A1A1A', color: '#FFFFFF', padding: '12px 16px',
                                        fontFamily: "'JetBrains Mono', 'Fira Code', monospace", fontSize: 13, outline: 'none', transition: 'border-color 150ms', resize: 'vertical'
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
                            
                            <button 
                                type="button"
                                onClick={() => supabase.auth.signOut()}
                                style={{ background: 'none', border: 'none', color: '#888888', fontSize: 13, cursor: 'pointer', marginTop: 16 }}
                            >
                                Sign out
                            </button>
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
