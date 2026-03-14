import React from 'react';

export default function TermsOfService() {
    return (
        <div style={{ maxWidth: '800px', margin: '0 auto', padding: '4rem 1rem', display: 'flex', flexDirection: 'column', gap: '2rem' }}>
            <div>
                <h1 style={{ fontSize: '2.5rem', fontWeight: 700, margin: '0 0 0.5rem 0' }}>Terms of Service</h1>
                <div style={{ color: '#888888', fontFamily: "'JetBrains Mono', monospace", fontSize: '0.85rem' }}>
                    <p>Effective date: March 13, 2026</p>
                    <p>Last updated: March 13, 2026</p>
                </div>
            </div>

            <section>
                <h2 style={{ fontSize: '1.25rem', fontWeight: 600, borderBottom: '1px solid #1A1A1A', paddingBottom: '0.5rem', marginBottom: '1rem' }}>1. ACCEPTANCE OF TERMS</h2>
                <p style={{ color: '#DDDDDD', fontSize: '0.95rem', margin: 0 }}>
                    By accessing or using the Layerinfinite API and dashboard ("Service"), you agree to be bound by these Terms of Service. If you disagree with any part of the terms, you do not have permission to access the Service.
                </p>
            </section>

            <section>
                <h2 style={{ fontSize: '1.25rem', fontWeight: 600, borderBottom: '1px solid #1A1A1A', paddingBottom: '0.5rem', marginBottom: '1rem' }}>2. SERVICE DESCRIPTION</h2>
                <p style={{ color: '#DDDDDD', fontSize: '0.95rem', margin: 0 }}>
                    Layerinfinite provides an outcome-ranked decision intelligence API for AI agents. The service captures agent outcomes, scores them, and provides recommendations for subsequent actions. The service is provided "as is" and "as available".
                </p>
            </section>

            <section>
                <h2 style={{ fontSize: '1.25rem', fontWeight: 600, borderBottom: '1px solid #1A1A1A', paddingBottom: '0.5rem', marginBottom: '1rem' }}>3. ACCEPTABLE USE</h2>
                <div style={{ color: '#DDDDDD', fontSize: '0.95rem' }}>
                    <p style={{ marginBottom: '0.5rem' }}>When using Layerinfinite, you agree not to:</p>
                    <ul style={{ margin: 0, paddingLeft: '1.5rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                        <li>Violate any laws, third party rights, or our policies.</li>
                        <li>Use the Service to transmit malicious code, malware, or illegal content.</li>
                        <li>Attempt to bypass or break any security or rate-limiting mechanism on the Service.</li>
                        <li>Reverse-engineer the Service's scoring mechanisms to gain unauthorized insights.</li>
                        <li>Resell the API access to third parties without explicit authorization.</li>
                    </ul>
                </div>
            </section>

            <section>
                <h2 style={{ fontSize: '1.25rem', fontWeight: 600, borderBottom: '1px solid #1A1A1A', paddingBottom: '0.5rem', marginBottom: '1rem' }}>4. ACCOUNT TERMINATION</h2>
                <div style={{ color: '#DDDDDD', fontSize: '0.95rem' }}>
                    <p style={{ marginBottom: '0.5rem' }}>We may terminate or suspend your account immediately, without prior notice or liability, for any reason whatsoever, including without limitation if you breach the Terms.</p>
                    <p style={{ margin: 0 }}>Upon termination, your right to use the Service will immediately cease.</p>
                </div>
            </section>

            <section>
                <h2 style={{ fontSize: '1.25rem', fontWeight: 600, borderBottom: '1px solid #1A1A1A', paddingBottom: '0.5rem', marginBottom: '1rem' }}>5. LIMITATION OF LIABILITY</h2>
                <p style={{ color: '#DDDDDD', fontSize: '0.95rem', margin: 0 }}>
                    In no event shall Layerinfinite, nor its directors, employees, partners, agents, suppliers, or affiliates, be liable for any indirect, incidental, special, consequential or punitive damages, including without limitation, loss of profits, data, use, goodwill, or other intangible losses, resulting from (i) your access to or use of or inability to access or use the Service; (ii) any conduct or content of any third party on the Service; (iii) any outcomes or decisions made by your AI agents integrated with the Service.
                </p>
            </section>

            <section>
                <h2 style={{ fontSize: '1.25rem', fontWeight: 600, borderBottom: '1px solid #1A1A1A', paddingBottom: '0.5rem', marginBottom: '1rem' }}>6. GOVERNING LAW</h2>
                <div style={{ color: '#DDDDDD', fontSize: '0.95rem' }}>
                    <p style={{ marginBottom: '0.5rem' }}>These Terms shall be governed and construed in accordance with the laws of Karnataka, India, without regard to its conflict of law provisions.</p>
                    <p style={{ margin: 0 }}>Our failure to enforce any right or provision of these Terms will not be considered a waiver of those rights.</p>
                </div>
            </section>

            <section>
                <h2 style={{ fontSize: '1.25rem', fontWeight: 600, borderBottom: '1px solid #1A1A1A', paddingBottom: '0.5rem', marginBottom: '1rem' }}>7. CONTACT US</h2>
                <div style={{ color: '#DDDDDD', fontSize: '0.95rem' }}>
                    <p style={{ marginBottom: '0.5rem' }}>If you have any questions about these Terms, please contact us:</p>
                    <p style={{ margin: 0, fontFamily: "'JetBrains Mono', monospace" }}>Email: legal@layerinfinite.ai</p>
                </div>
            </section>
        </div>
    );
}
