/**
 * Onboarding.tsx — 3-step first-time user onboarding flow.
 * Step 1: Name your first agent
 * Step 2: Your API key (shown once)
 * Step 3: Integrate Layerinfinite (code snippets)
 */
import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../supabaseClient';
import { API_BASE } from '../lib/config';

const C = {
    bg: '#000000',
    surface: '#111111',
    border: '#1A1A1A',
    accent: '#00FF85',
    muted: '#888888',
    error: '#FF4444',
    white: '#FFFFFF',
    placeholder: '#444444',
};

const FONT_SANS = "'Inter', system-ui, -apple-system, sans-serif";
const FONT_MONO = "'JetBrains Mono', 'Fira Code', monospace";

const AGENT_TYPES = ['customer_support', 'devops', 'data_pipeline', 'general', 'other'];

interface CreateApiKeyResponse {
    key?: string;
    key_id?: string;
    error?: string;
    details?: string;
}

export default function Onboarding() {
    const navigate = useNavigate();
    const [step, setStep] = useState(1);

    // Step 1
    const [agentName, setAgentName] = useState('');
    const [agentType, setAgentType] = useState('general');
    const [llmModel, setLlmModel] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Step 2
    const [apiKey, setApiKey] = useState('');
    const [copied, setCopied] = useState(false);
    const [keySaved, setKeySaved] = useState(false);

    // Step 3
    const [activeTab, setActiveTab] = useState<'node' | 'python' | 'curl'>('node');

    const handleStep1Submit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError(null);

        if (!API_BASE) {
            setError('API endpoint is not configured. Set VITE_LAYERINFINITE_API_URL and redeploy.');
            setLoading(false);
            return;
        }

        const { data: { session } } = await supabase.auth.getSession();
        if (!session) { setError('Not authenticated'); setLoading(false); return; }

        try {
            const response = await fetch(`${API_BASE}/v1/auth/api-keys`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${session.access_token}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ name: agentName.trim() }),
            });

            const payload = (await response.json()) as CreateApiKeyResponse;
            if (!response.ok || !payload.key) {
                throw new Error(payload.error ?? payload.details ?? 'Failed to generate API key');
            }

            if (payload.key_id) {
                await supabase
                    .from('dim_agents')
                    .update({
                        agent_type: agentType,
                        llm_model: llmModel.trim() ? llmModel.trim() : null,
                    })
                    .eq('agent_id', payload.key_id);
            }

            setApiKey(payload.key);
            setStep(2);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to generate API key');
        }

        setLoading(false);
    };

    const handleCopy = async () => {
        await navigator.clipboard.writeText(apiKey);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    // ── Styles ────────────────────────────────────────
    const containerStyle: React.CSSProperties = {
        minHeight: '100vh',
        background: C.bg,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: '48px 24px',
        fontFamily: FONT_SANS,
    };

    const cardStyle: React.CSSProperties = {
        width: '100%',
        maxWidth: 640,
        marginTop: 32,
    };

    const inputStyle: React.CSSProperties = {
        width: '100%',
        height: 48,
        background: C.surface,
        border: `1px solid ${C.border}`,
        color: C.white,
        padding: '12px 16px',
        fontFamily: FONT_MONO,
        fontSize: 13,
        outline: 'none',
        boxSizing: 'border-box',
    };

    const labelStyle: React.CSSProperties = {
        display: 'block',
        fontFamily: FONT_SANS,
        fontSize: 11,
        fontWeight: 500,
        textTransform: 'uppercase',
        letterSpacing: '0.1em',
        color: C.muted,
        marginBottom: 6,
    };

    const buttonPrimary: React.CSSProperties = {
        width: '100%',
        height: 48,
        background: C.accent,
        color: C.bg,
        border: 'none',
        fontFamily: FONT_SANS,
        fontSize: 14,
        fontWeight: 700,
        cursor: 'pointer',
        transition: 'all 150ms',
    };

    return (
        <div style={containerStyle}>
            <style>{`
                @keyframes onb-spin { to { transform: rotate(360deg); } }
                @keyframes onb-fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
            `}</style>

            {/* Logo */}
            <div style={{ fontFamily: FONT_MONO, fontSize: 18, fontWeight: 700, color: C.white }}>
                Layer<span style={{ color: C.accent }}>5</span>
            </div>

            {/* Progress bar */}
            <div style={{ display: 'flex', gap: 8, marginTop: 32, width: '100%', maxWidth: 640 }}>
                {[1, 2, 3].map((s) => (
                    <div key={s} style={{
                        flex: 1, height: 3,
                        background: s <= step ? C.accent : C.border,
                        transition: 'background 300ms',
                    }} />
                ))}
            </div>

            {/* Step indicator */}
            <div style={{ display: 'flex', gap: 24, marginTop: 16 }}>
                {[1, 2, 3].map((s) => (
                    <div key={s} style={{
                        width: 28, height: 28, borderRadius: '50%',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontFamily: FONT_MONO, fontSize: 12, fontWeight: 700,
                        background: s <= step ? C.accent : 'transparent',
                        color: s <= step ? C.bg : C.muted,
                        border: s <= step ? 'none' : `1px solid ${C.border}`,
                    }}>
                        {s}
                    </div>
                ))}
            </div>

            <div style={cardStyle}>
                {step === 1 && (
                    <div style={{ animation: 'onb-fadeIn 300ms' }}>
                        <h1 style={{ fontFamily: FONT_SANS, fontSize: 24, fontWeight: 600, color: C.white, margin: 0 }}>
                            Connect your first agent.
                        </h1>
                        <p style={{ fontFamily: FONT_SANS, fontSize: 14, color: C.muted, marginTop: 8, marginBottom: 32, lineHeight: 1.6 }}>
                            Layerinfinite works with any LLM framework. Name this agent so you can track it.
                        </p>

                        {error && (
                            <div style={{
                                padding: '10px 14px', marginBottom: 16,
                                background: 'rgba(255,68,68,0.08)',
                                borderLeft: `3px solid ${C.error}`,
                                fontFamily: FONT_MONO, fontSize: 11, color: C.error,
                            }}>{error}</div>
                        )}

                        <form onSubmit={handleStep1Submit}>
                            <div style={{ marginBottom: 16 }}>
                                <label style={labelStyle}>Agent Name</label>
                                <input style={inputStyle} value={agentName} onChange={(e) => setAgentName(e.target.value)}
                                    placeholder="e.g. payment-bot, support-agent" required
                                    onFocus={(e) => (e.currentTarget.style.borderColor = C.accent)}
                                    onBlur={(e) => (e.currentTarget.style.borderColor = C.border)}
                                />
                            </div>
                            <div style={{ marginBottom: 16 }}>
                                <label style={labelStyle}>Agent Type</label>
                                <select style={{ ...inputStyle, appearance: 'none', cursor: 'pointer' }} value={agentType}
                                    onChange={(e) => setAgentType(e.target.value)}
                                    onFocus={(e) => (e.currentTarget.style.borderColor = C.accent)}
                                    onBlur={(e) => (e.currentTarget.style.borderColor = C.border)}
                                >
                                    {AGENT_TYPES.map((t) => (
                                        <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>
                                    ))}
                                </select>
                            </div>
                            <div style={{ marginBottom: 24 }}>
                                <label style={labelStyle}>LLM Model <span style={{ textTransform: 'none', letterSpacing: 0 }}>(optional)</span></label>
                                <input style={inputStyle} value={llmModel} onChange={(e) => setLlmModel(e.target.value)}
                                    placeholder="e.g. gpt-4o, claude-sonnet-4-6"
                                    onFocus={(e) => (e.currentTarget.style.borderColor = C.accent)}
                                    onBlur={(e) => (e.currentTarget.style.borderColor = C.border)}
                                />
                            </div>
                            <button type="submit" disabled={loading} style={{ ...buttonPrimary, opacity: loading ? 0.8 : 1 }}>
                                {loading ? 'Creating agent...' : 'Continue →'}
                            </button>
                        </form>
                    </div>
                )}

                {step === 2 && (
                    <div style={{ animation: 'onb-fadeIn 300ms' }}>
                        <h1 style={{ fontFamily: FONT_SANS, fontSize: 24, fontWeight: 600, color: C.white, margin: 0 }}>
                            Your API key.
                        </h1>
                        <p style={{ fontFamily: FONT_SANS, fontSize: 14, color: C.muted, marginTop: 8, marginBottom: 32, lineHeight: 1.6 }}>
                            This is shown once. Save it now.
                        </p>

                        {/* API key display */}
                        <div style={{
                            background: C.surface,
                            border: `1px solid rgba(0,255,133,0.3)`,
                            padding: '14px 16px',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: 12,
                        }}>
                            <span style={{
                                fontFamily: FONT_MONO, fontSize: 13, color: C.accent,
                                overflowX: 'auto', whiteSpace: 'nowrap',
                            }}>
                                {apiKey}
                            </span>
                            <button onClick={handleCopy}
                                style={{
                                    background: 'none', border: `1px solid ${C.border}`,
                                    color: copied ? C.accent : C.muted,
                                    fontFamily: FONT_MONO, fontSize: 11, cursor: 'pointer',
                                    padding: '6px 12px', whiteSpace: 'nowrap',
                                    transition: 'all 150ms',
                                }}>
                                {copied ? '✓ Copied' : 'Copy'}
                            </button>
                        </div>

                        {/* Warning */}
                        <div style={{
                            marginTop: 16, padding: '12px 14px',
                            background: 'rgba(255,188,46,0.06)',
                            borderLeft: '3px solid #FEBC2E',
                            fontFamily: FONT_SANS, fontSize: 12, color: '#FEBC2E', lineHeight: 1.5,
                        }}>
                            ⚠ This key cannot be shown again. Store it in your environment variables.
                        </div>

                        {/* Code snippet */}
                        <div style={{
                            marginTop: 24, background: '#0A0A0A', border: `1px solid ${C.border}`,
                            padding: '16px 18px', fontFamily: FONT_MONO, fontSize: 12, color: C.muted, lineHeight: 1.8,
                        }}>
                            <div style={{ color: C.muted }}>{'// In your agent code:'}</div>
                            <div><span style={{ color: '#C678DD' }}>const</span> <span style={{ color: C.white }}>layerinfinite</span> = <span style={{ color: '#C678DD' }}>new</span> <span style={{ color: '#61AFEF' }}>LayerinfiniteClient</span>{'({'}</div>
                            <div>{'  '}<span style={{ color: C.accent }}>apiKey</span>: <span style={{ color: '#98C379' }}>'{apiKey.slice(0, 12)}...'</span>,</div>
                            <div>{'  '}<span style={{ color: C.accent }}>agentId</span>: <span style={{ color: '#98C379' }}>'{agentName}'</span></div>
                            <div>{'});'}</div>
                        </div>

                        {/* Checkbox + button */}
                        <label style={{
                            display: 'flex', alignItems: 'center', gap: 10, marginTop: 24,
                            fontFamily: FONT_SANS, fontSize: 13, color: C.muted, cursor: 'pointer',
                        }}>
                            <input type="checkbox" checked={keySaved} onChange={(e) => setKeySaved(e.target.checked)}
                                style={{ accentColor: C.accent, width: 16, height: 16 }}
                            />
                            I've saved my API key
                        </label>

                        <div style={{ display: 'flex', gap: 12, marginTop: 24 }}>
                            <button onClick={() => setStep(1)}
                                style={{
                                    height: 48, padding: '0 24px',
                                    background: 'none', border: `1px solid ${C.border}`,
                                    color: C.muted, fontFamily: FONT_SANS, fontSize: 14,
                                    cursor: 'pointer', transition: 'border-color 150ms',
                                }}>
                                ← Back
                            </button>
                            <button onClick={() => setStep(3)} disabled={!keySaved}
                                style={{
                                    ...buttonPrimary,
                                    flex: 1,
                                    opacity: keySaved ? 1 : 0.4,
                                    cursor: keySaved ? 'pointer' : 'not-allowed',
                                }}>
                                Continue →
                            </button>
                        </div>
                    </div>
                )}

                {step === 3 && (
                    <div style={{ animation: 'onb-fadeIn 300ms' }}>
                        <h1 style={{ fontFamily: FONT_SANS, fontSize: 24, fontWeight: 600, color: C.white, margin: 0 }}>
                            Two API calls. That's the integration.
                        </h1>
                        <p style={{ fontFamily: FONT_SANS, fontSize: 14, color: C.muted, marginTop: 8, marginBottom: 32, lineHeight: 1.6 }}>
                            Add these before and after each agent action.
                        </p>

                        {/* Tabs */}
                        <div style={{ display: 'flex', borderBottom: `1px solid ${C.border}`, marginBottom: 0 }}>
                            {(['node', 'python', 'curl'] as const).map((tab) => (
                                <button key={tab} onClick={() => setActiveTab(tab)}
                                    style={{
                                        background: 'none', border: 'none', borderBottom: activeTab === tab ? `2px solid ${C.accent}` : '2px solid transparent',
                                        color: activeTab === tab ? C.accent : C.muted,
                                        fontFamily: FONT_MONO, fontSize: 12, padding: '10px 20px',
                                        cursor: 'pointer', transition: 'all 150ms',
                                        textTransform: 'capitalize',
                                    }}>
                                    {tab === 'node' ? 'Node.js' : tab === 'python' ? 'Python' : 'cURL'}
                                </button>
                            ))}
                        </div>

                        {/* Code blocks */}
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 16 }}>
                            <div>
                                <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 8 }}>
                                    Before acting
                                </div>
                                <CodeBlock code={getBeforeCode(activeTab, agentName)} />
                            </div>
                            <div>
                                <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 8 }}>
                                    After acting
                                </div>
                                <CodeBlock code={getAfterCode(activeTab)} />
                            </div>
                        </div>

                        <p style={{ fontFamily: FONT_SANS, fontSize: 14, color: C.muted, marginTop: 32, lineHeight: 1.6 }}>
                            Ready to go. Your agent will start improving from the first outcome.
                        </p>

                        <div style={{ display: 'flex', gap: 12, marginTop: 24 }}>
                            <button onClick={() => setStep(2)}
                                style={{
                                    height: 48, padding: '0 24px',
                                    background: 'none', border: `1px solid ${C.border}`,
                                    color: C.muted, fontFamily: FONT_SANS, fontSize: 14,
                                    cursor: 'pointer',
                                }}>
                                ← Back
                            </button>
                            <button onClick={() => navigate('/dashboard')}
                                style={{ ...buttonPrimary, flex: 1 }}>
                                Go to Dashboard →
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

// ─── Code snippets per language ──────────────────────
function getBeforeCode(lang: 'node' | 'python' | 'curl', agentName: string): string {
        const resolvedAgentName = agentName || '<agent_id>';
        const resolvedApiBase = API_BASE ?? 'https://your-api-base.example.com';

    if (lang === 'node') {
                return `const scores = await layerinfinite.getScores({
    context: { issue_type: '<issue_type>' }
});
agent.execute(scores.ranked_actions[0].action);`;
    }
    if (lang === 'python') {
        return `scores = layerinfinite.get_scores(
    context={"issue_type": "<issue_type>"}
)
agent.execute(scores["ranked_actions"][0]["action"])`;
    }
        return `curl -X GET ${resolvedApiBase}/v1/get-scores \\
    -H "Authorization: Bearer $LAYERINFINITE_API_KEY" \\
  -H "Content-Type: application/json" \\
    -d '{"agent_id":"${resolvedAgentName}","context":{"issue_type":"<issue_type>"}}'`;
}

function getAfterCode(lang: 'node' | 'python' | 'curl'): string {
        const resolvedApiBase = API_BASE ?? 'https://your-api-base.example.com';

    if (lang === 'node') {
        return `await layerinfinite.logOutcome({
    action: '<action_name>',
    success: <true_or_false>,
    response_ms: <response_time_ms>
});`;
    }
    if (lang === 'python') {
        return `layerinfinite.log_outcome(
    action="<action_name>",
    success=<true_or_false>,
    response_ms=<response_time_ms>
)`;
    }
        return `curl -X POST ${resolvedApiBase}/v1/log-outcome \\
    -H "Authorization: Bearer $LAYERINFINITE_API_KEY" \\
  -H "Content-Type: application/json" \\
    -d '{"action":"<action_name>","success":<true_or_false>,"response_ms":<response_time_ms>}'`;
}

function CodeBlock({ code }: { code: string }) {
    return (
        <pre style={{
            background: '#0A0A0A',
            border: `1px solid ${C.border}`,
            padding: '14px 16px',
            fontFamily: FONT_MONO,
            fontSize: 11,
            color: C.muted,
            lineHeight: 1.7,
            margin: 0,
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
        }}>
            {code}
        </pre>
    );
}
