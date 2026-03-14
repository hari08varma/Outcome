import React from 'react';

export default function PrivacyPolicy() {
    return (
        <div style={{ maxWidth: '800px', margin: '0 auto', padding: '4rem 1rem', display: 'flex', flexDirection: 'column', gap: '2rem' }}>
            <div>
                <h1 style={{ fontSize: '2.5rem', fontWeight: 700, margin: '0 0 0.5rem 0' }}>Privacy Policy</h1>
                <div style={{ color: '#888888', fontFamily: "'JetBrains Mono', monospace", fontSize: '0.85rem' }}>
                    <p>Effective date: March 13, 2026</p>
                    <p>Last updated: March 13, 2026</p>
                </div>
            </div>

            <section>
                <h2 style={{ fontSize: '1.25rem', fontWeight: 600, borderBottom: '1px solid #1A1A1A', paddingBottom: '0.5rem', marginBottom: '1rem' }}>1. DATA WE COLLECT</h2>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', color: '#DDDDDD', fontSize: '0.95rem' }}>
                    <div>
                        <h3 style={{ color: '#00FF85', fontWeight: 600, marginBottom: '0.25rem' }}>Account data:</h3>
                        <p style={{ margin: '0 0 0.5rem 0' }}>Email address and name (when you sign up with Google OAuth or email/password).</p>
                        <ul style={{ color: '#888888', margin: 0, paddingLeft: '1.5rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                            <li>Used to: identify your account.</li>
                            <li>Stored in: Supabase Auth.</li>
                            <li>Retained until: account deletion.</li>
                        </ul>
                    </div>
                    <div>
                        <h3 style={{ color: '#00FF85', fontWeight: 600, marginBottom: '0.25rem' }}>Agent outcome data:</h3>
                        <p style={{ margin: '0 0 0.5rem 0' }}>Action names, success/failure outcomes, response times, and context metadata that your AI agents log to Layer5.</p>
                        <ul style={{ color: '#888888', margin: 0, paddingLeft: '1.5rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                            <li>Used to: compute scores and recommendations.</li>
                            <li>Stored in: our Supabase PostgreSQL database.</li>
                            <li>Retained: 90 days hot storage, 365 days archive.</li>
                            <li>Deleted: on account deletion request.</li>
                        </ul>
                    </div>
                    <div>
                        <h3 style={{ color: '#00FF85', fontWeight: 600, marginBottom: '0.25rem' }}>API keys:</h3>
                        <p style={{ margin: '0 0 0.5rem 0' }}>Hashed API keys (we store the hash, not the key).</p>
                        <ul style={{ color: '#888888', margin: 0, paddingLeft: '1.5rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                            <li>Used to: authenticate API requests.</li>
                            <li>Retained until: key revocation or account deletion.</li>
                        </ul>
                    </div>
                    <div>
                        <h3 style={{ color: '#00FF85', fontWeight: 600, marginBottom: '0.25rem' }}>Usage data:</h3>
                        <p style={{ margin: '0 0 0.5rem 0' }}>Request logs (IP address, endpoint, timestamp).</p>
                        <ul style={{ color: '#888888', margin: 0, paddingLeft: '1.5rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                            <li>Used to: rate limiting and abuse prevention.</li>
                            <li>Retained: 30 days.</li>
                        </ul>
                    </div>
                </div>
            </section>

            <section>
                <h2 style={{ fontSize: '1.25rem', fontWeight: 600, borderBottom: '1px solid #1A1A1A', paddingBottom: '0.5rem', marginBottom: '1rem' }}>2. HOW WE USE YOUR DATA</h2>
                <div style={{ color: '#DDDDDD', fontSize: '0.95rem' }}>
                    <p style={{ marginBottom: '0.5rem' }}>We use collected data exclusively to:</p>
                    <ul style={{ margin: '0 0 1rem 0', paddingLeft: '1.5rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                        <li>Provide the Layer5 service</li>
                        <li>Compute action scores and recommendations</li>
                        <li>Detect anomalies in your agent performance</li>
                        <li>Authenticate API requests</li>
                    </ul>
                    <p style={{ marginBottom: '0.5rem', color: '#ff6b6b' }}>We do NOT:</p>
                    <ul style={{ margin: 0, paddingLeft: '1.5rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                        <li>Sell your data to third parties</li>
                        <li>Use your agent outcome data to train models for other customers</li>
                        <li>Share identifiable data with advertisers</li>
                    </ul>
                </div>
            </section>

            <section>
                <h2 style={{ fontSize: '1.25rem', fontWeight: 600, borderBottom: '1px solid #1A1A1A', paddingBottom: '0.5rem', marginBottom: '1rem' }}>3. DATA STORAGE AND SECURITY</h2>
                <div style={{ color: '#DDDDDD', fontSize: '0.95rem' }}>
                    <p style={{ marginBottom: '1rem' }}>Data is stored in Supabase (PostgreSQL) hosted in the ap-south-1 region.</p>
                    <p style={{ marginBottom: '0.5rem' }}>Access controls:</p>
                    <ul style={{ margin: 0, paddingLeft: '1.5rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                        <li>Row Level Security (RLS) ensures each customer sees only their own data</li>
                        <li>API keys are stored as hashes (SHA-256)</li>
                        <li>Service role credentials are never exposed in client-facing responses</li>
                    </ul>
                </div>
            </section>

            <section>
                <h2 style={{ fontSize: '1.25rem', fontWeight: 600, borderBottom: '1px solid #1A1A1A', paddingBottom: '0.5rem', marginBottom: '1rem' }}>4. YOUR RIGHTS</h2>
                <div style={{ color: '#DDDDDD', fontSize: '0.95rem' }}>
                    <p style={{ marginBottom: '0.5rem' }}>You have the right to:</p>
                    <ul style={{ margin: '0 0 1rem 0', paddingLeft: '1.5rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                        <li>Access your data: <code style={{ color: '#00FF85', background: '#111', padding: '0.1rem 0.3rem', borderRadius: '4px' }}>GET /v1/audit</code></li>
                        <li>Export your data: <code style={{ color: '#00FF85', background: '#111', padding: '0.1rem 0.3rem', borderRadius: '4px' }}>GET /v1/audit?format=csv</code></li>
                        <li>Delete your data: email privacy@layer5.ai (We will delete all your data within 30 days)</li>
                        <li>Correct inaccurate data: contact us</li>
                    </ul>
                    <p style={{ marginBottom: '0.5rem' }}>Under DPDPA 2023 (India), you additionally have the right to nominate a representative to exercise rights on your behalf.</p>
                    <p>To exercise any right: email privacy@layer5.ai</p>
                </div>
            </section>

            <section>
                <h2 style={{ fontSize: '1.25rem', fontWeight: 600, borderBottom: '1px solid #1A1A1A', paddingBottom: '0.5rem', marginBottom: '1rem' }}>5. COOKIES</h2>
                <div style={{ color: '#DDDDDD', fontSize: '0.95rem' }}>
                    <p>Layer5 does not use tracking cookies. We use localStorage only for session tokens (required for authentication).</p>
                </div>
            </section>

            <section>
                <h2 style={{ fontSize: '1.25rem', fontWeight: 600, borderBottom: '1px solid #1A1A1A', paddingBottom: '0.5rem', marginBottom: '1rem' }}>6. THIRD-PARTY SERVICES</h2>
                <div style={{ color: '#DDDDDD', fontSize: '0.95rem' }}>
                    <ul style={{ margin: 0, paddingLeft: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                        <li>
                            <strong style={{ color: '#fff' }}>Supabase:</strong> Database and authentication.<br />
                            <a href="https://supabase.com/privacy" style={{ color: '#00FF85', textDecoration: 'none' }}>https://supabase.com/privacy</a>
                        </li>
                        <li>
                            <strong style={{ color: '#fff' }}>Google OAuth:</strong> Sign-in authentication.<br />
                            <a href="https://policies.google.com/privacy" style={{ color: '#00FF85', textDecoration: 'none' }}>https://policies.google.com/privacy</a>
                        </li>
                    </ul>
                </div>
            </section>

            <section>
                <h2 style={{ fontSize: '1.25rem', fontWeight: 600, borderBottom: '1px solid #1A1A1A', paddingBottom: '0.5rem', marginBottom: '1rem' }}>7. CHANGES TO THIS POLICY</h2>
                <div style={{ color: '#DDDDDD', fontSize: '0.95rem' }}>
                    <p>We will notify users of material changes via email. The effective date above reflects the last update.</p>
                </div>
            </section>

            <section>
                <h2 style={{ fontSize: '1.25rem', fontWeight: 600, borderBottom: '1px solid #1A1A1A', paddingBottom: '0.5rem', marginBottom: '1rem' }}>8. CONTACT</h2>
                <div style={{ color: '#DDDDDD', fontSize: '0.95rem' }}>
                    <p style={{ marginBottom: '0.5rem' }}>For privacy inquiries or data deletion requests:</p>
                    <p style={{ margin: '0 0 0.5rem 0', fontFamily: "'JetBrains Mono', monospace" }}>Email: privacy@layer5.ai</p>
                    <p>Response time: within 30 business days.</p>
                </div>
            </section>
        </div>
    );
}
