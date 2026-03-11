/**
 * Logout Page — /logout
 * Clears Supabase session and redirects to /login.
 */
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../supabaseClient';

export default function LogoutPage() {
    const navigate = useNavigate();

    useEffect(() => {
        supabase.auth.signOut().then(() => {
            navigate('/login', { replace: true });
        });
    }, [navigate]);

    return (
        <div style={{ padding: '2rem', textAlign: 'center', color: '#64748b', fontFamily: 'system-ui, sans-serif' }}>
            Signing out…
        </div>
    );
}
