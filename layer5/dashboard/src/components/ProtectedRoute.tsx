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

    useEffect(() => {
        let isMounted = true;

        async function fetchSession() {
            const { data: { session } } = await supabase.auth.getSession();
            if (isMounted) setSession(session);

            if (session) {
                const { data } = await supabase
                    .from('user_profiles')
                    .select('access_status')
                    .eq('id', session.user.id)
                    .single();
                
                if (isMounted && data) {
                    setAccessStatus(data.access_status);
                }
            }
        }

        fetchSession();

        const { data: { subscription } } = supabase.auth.onAuthStateChange(async (_event, newSession) => {
            setSession(newSession);
            if (newSession) {
                const { data } = await supabase
                    .from('user_profiles')
                    .select('access_status')
                    .eq('id', newSession.user.id)
                    .single();
                if (data) setAccessStatus(data.access_status);
            } else {
                setAccessStatus(null);
            }
        });

        return () => {
            isMounted = false;
            subscription.unsubscribe();
        };
    }, []);

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
