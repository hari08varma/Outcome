import React from 'react';
import { Link, useNavigate } from 'react-router-dom';

export default function LandingPage(): React.ReactElement {
    const navigate = useNavigate();

    const scrollTo = (id: string) => {
        document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
    };

    return (
        <div className="bg-black text-white landing-page">
            {/* Navigation */}
            <nav className="fixed top-0 w-full z-50 border-b border-[#1A1A1A] bg-black/80 backdrop-blur-md">
                <div className="max-w-7xl mx-auto px-6 h-20 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <span className="text-2xl font-bold tracking-tighter">Layer<span className="text-[#00FF85]">5</span></span>
                    </div>
                    <div className="hidden md:flex items-center gap-8 text-sm font-medium text-[#888888]">
                        <button className="hover:text-white transition-colors" onClick={() => scrollTo('problem')}>Problem</button>
                        <button className="hover:text-white transition-colors" onClick={() => scrollTo('how-it-works')}>How It Works</button>
                        <button className="hover:text-white transition-colors" onClick={() => scrollTo('proof-metrics')}>Proof</button>
                        <button className="hover:text-white transition-colors" onClick={() => scrollTo('docs')}>Docs</button>
                    </div>
                    <div className="flex items-center gap-3">
                        <button
                            onClick={() => navigate('/auth?mode=login')}
                            className="text-sm font-medium text-[#888888] hover:text-white transition-colors"
                        >Sign In</button>
                        <button
                            onClick={() => navigate('/auth?mode=signup')}
                            className="bg-[#00FF85] text-black px-6 py-2.5 text-sm font-bold tracking-tight hover:bg-white transition-all"
                        >Get Started Free</button>
                    </div>
                </div>
            </nav>

            <main>
                {/* Hero */}
                <section className="relative pt-20 pb-20 overflow-hidden" id="hero">
                    <div className="max-w-7xl mx-auto px-6 grid grid-cols-1 lg:grid-cols-2 gap-16 items-center">
                        <div>
                            <h1
                                className="font-bold leading-tight tracking-tighter mb-8"
                                style={{ fontSize: 'clamp(42px, 6vw, 68px)' }}
                            >
                                Your AI <br />agents are <br />repeating <br />failures. <br />
                                <span className="text-[#00FF85]">Layer5 stops them.</span>
                            </h1>
                            <p className="text-lg text-[#888888] max-w-lg leading-relaxed mb-6">
                                Outcome-ranked decision intelligence that sits between your LLM and infrastructure. Agents learn what works. Without retraining. Without rebuilding.
                            </p>
                            <div className="h-1 w-24 bg-[#00FF85] mb-10"></div>
                            <div className="flex flex-col sm:flex-row gap-4 mt-2">
                                <button
                                    onClick={() => navigate('/auth?mode=signup')}
                                    className="bg-[#00FF85] text-black px-8 py-4 text-sm font-bold tracking-tight hover:bg-white transition-all"
                                >
                                    Get Started Free
                                </button>
                                <button
                                    onClick={() => navigate('/auth?mode=login')}
                                    className="border border-[#1A1A1A] text-white px-8 py-4 text-sm font-bold tracking-tight hover:border-[#00FF85]/50 transition-all"
                                >
                                    Sign In →
                                </button>
                            </div>
                        </div>
                        <div className="relative">
                            <div className="glass-card rounded-lg p-1 border border-[#1A1A1A] shadow-2xl">
                                <div className="bg-[#111111]/50 rounded-t-md p-3 border-b border-[#1A1A1A] flex gap-1.5">
                                    <div className="w-2.5 h-2.5 rounded-full bg-red-500/50"></div>
                                    <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/50"></div>
                                    <div className="w-2.5 h-2.5 rounded-full bg-green-500/50"></div>
                                    <span className="text-[10px] text-[#888888] ml-2 font-mono">agent-session-0x4f2a</span>
                                </div>
                                <div className="p-6 font-mono text-sm space-y-4">
                                    <div className="text-[#888888] opacity-50">[before Layer5]</div>
                                    <div className="flex items-center gap-3 text-red-400">
                                        <span>✕</span>
                                        <span>restart_service attempt 1 <span className="text-red-500/80 font-bold">FAILED</span> 503ms</span>
                                    </div>
                                    <div className="flex items-center gap-3 text-red-400">
                                        <span>✕</span>
                                        <span>restart_service attempt 2 <span className="text-red-500/80 font-bold">FAILED</span> 498ms</span>
                                    </div>
                                    <div className="flex items-center gap-3 text-red-400">
                                        <span>✕</span>
                                        <span>restart_service attempt 3 <span className="text-red-500/80 font-bold">FAILED</span> 501ms</span>
                                    </div>
                                    <div className="pt-2 text-[#00FF85] opacity-70">[Layer5 active]</div>
                                    <div className="flex items-center gap-3 text-[#00FF85]">
                                        <span>✓</span>
                                        <span>update_app <span className="opacity-60 text-xs">score 0.85</span> <span className="font-bold">SUCCESS</span> 241ms</span>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </section>

                {/* Problem */}
                <section className="py-24 bg-[#111111]/30 border-y border-[#1A1A1A]" id="problem">
                    <div className="max-w-7xl mx-auto px-6">
                        <span className="text-[#00FF85] text-[10px] font-bold tracking-[0.2em] uppercase mb-4 block">The Problem</span>
                        <h2 className="text-4xl md:text-5xl font-bold tracking-tight mb-6">Every session starts from zero.</h2>
                        <p className="text-[#888888] max-w-xl mb-16">Your agents are expensive. They're also amnesiac. Here's what production looks like without a decision layer.</p>
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
                            <div className="border border-[#1A1A1A] p-8 hover:border-[#00FF85]/30 transition-colors">
                                <div className="text-[10px] font-mono text-red-500/60 mb-6 uppercase tracking-widest">[ERR] agent_loop :: retry_overflow</div>
                                <h3 className="text-xl font-bold mb-4">Agent Amnesia</h3>
                                <p className="text-sm text-[#888888] leading-relaxed mb-8">
                                    AI agents retry the same failed action 5-10 times per session with zero adaptation. Every failure costs compute, latency, and user trust.
                                </p>
                                <div className="inline-block px-3 py-1 border border-[#00FF85]/20 text-[#00FF85] text-[10px] font-mono">
                                    5-10 retries / session
                                </div>
                            </div>
                            <div className="border border-[#1A1A1A] p-8 hover:border-[#00FF85]/30 transition-colors">
                                <div className="text-[10px] font-mono text-red-500/60 mb-6 uppercase tracking-widest">[ERR] session_init :: cold_start</div>
                                <h3 className="text-xl font-bold mb-4">No Learning Between Sessions</h3>
                                <p className="text-sm text-[#888888] leading-relaxed mb-8">
                                    Every deployment resets to zero. The model never improves from production experience. Last week's fix is forgotten today.
                                </p>
                                <div className="inline-block px-3 py-1 border border-[#00FF85]/20 text-[#00FF85] text-[10px] font-mono">
                                    0% knowledge retained
                                </div>
                            </div>
                            <div className="border border-[#1A1A1A] p-8 hover:border-[#00FF85]/30 transition-colors">
                                <div className="text-[10px] font-mono text-red-500/60 mb-6 uppercase tracking-widest">[ERR] compliance :: audit_missing</div>
                                <h3 className="text-xl font-bold mb-4">Zero Audit Trail</h3>
                                <p className="text-sm text-[#888888] leading-relaxed mb-8">
                                    EU AI Act requires 10-year decision trails. Vector stores cannot produce them. Your compliance team is flying blind.
                                </p>
                                <div className="inline-block px-3 py-1 border border-[#00FF85]/20 text-[#00FF85] text-[10px] font-mono">
                                    10yr retention required
                                </div>
                            </div>
                        </div>
                    </div>
                </section>

                {/* Proof metrics */}
                <section className="py-20 bg-black border-b border-[#1A1A1A]" id="proof-metrics">
                    <div className="max-w-7xl mx-auto px-6">
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-8 md:gap-12">
                            <div className="text-center md:text-left">
                                <div className="text-[#00FF85] text-3xl md:text-4xl font-bold mb-2 tracking-tight">Sub-5ms decision latency</div>
                                <div className="text-[#888888] text-sm font-medium">Benchmarked on PostgreSQL materialized views — scores return in under 5ms at scale</div>
                            </div>
                            <div className="text-center md:text-left">
                                <div className="text-[#00FF85] text-3xl md:text-4xl font-bold mb-2 tracking-tight">Append-only audit trail</div>
                                <div className="text-[#888888] text-sm font-medium">Every decision is immutably recorded. No data loss. GDPR-compliant soft deletes.</div>
                            </div>
                            <div className="text-center md:text-left">
                                <div className="text-[#00FF85] text-3xl md:text-4xl font-bold mb-2 tracking-tight">Early access</div>
                                <div className="text-[#888888] text-sm font-medium">Now open to founding teams. Shape the product from day one.</div>
                            </div>
                        </div>
                    </div>
                </section>

                {/* Capabilities */}
                <section className="py-24 bg-black" id="capabilities">
                    <div className="max-w-7xl mx-auto px-6">
                        <span className="text-[#00FF85] text-[10px] font-bold tracking-[0.2em] uppercase mb-4 block">Capabilities</span>
                        <h2 className="text-4xl md:text-5xl font-bold tracking-tight mb-20">Every layer your production agents need.</h2>
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-px bg-[#1A1A1A] border border-[#1A1A1A]">
                            <div className="bg-black p-10 hover:bg-[#111111]/50 transition-colors">
                                <span className="text-[10px] text-[#888888] font-mono mb-4 block">Layer 01</span>
                                <h4 className="text-lg font-bold mb-4">Outcome-Ranked Decisions</h4>
                                <p className="text-sm text-[#888888] leading-relaxed">Scores every available action using context-weighted success history. Best action floats to the top automatically.</p>
                            </div>
                            <div className="bg-black p-10 hover:bg-[#111111]/50 transition-colors">
                                <span className="text-[10px] text-[#888888] font-mono mb-4 block">Layer 02</span>
                                <h4 className="text-lg font-bold mb-4">Cold Start Protocol</h4>
                                <p className="text-sm text-[#888888] leading-relaxed">Four-stage bootstrap with prior injection and cross-agent transfer. Intelligent from day one—not after 10,000 outcomes.</p>
                            </div>
                            <div className="bg-black p-10 hover:bg-[#111111]/50 transition-colors">
                                <span className="text-[10px] text-[#888888] font-mono mb-4 block">Layer 03</span>
                                <h4 className="text-lg font-bold mb-4">Trust-Aware Routing</h4>
                                <p className="text-sm text-[#888888] leading-relaxed">Auto-suspends agents whose success rate drops below threshold. Routes to human escalation before damage compounds.</p>
                            </div>
                            <div className="bg-black p-10 hover:bg-[#111111]/50 transition-colors">
                                <span className="text-[10px] text-[#888888] font-mono mb-4 block">Layer 04</span>
                                <h4 className="text-lg font-bold mb-4">Temporal Memory</h4>
                                <p className="text-sm text-[#888888] leading-relaxed">Detects performance degradation trends before they crash your system. Recency-weighted scoring with automatic decay.</p>
                            </div>
                            <div className="bg-black p-10 hover:bg-[#111111]/50 transition-colors">
                                <span className="text-[10px] text-[#888888] font-mono mb-4 block">Layer 05</span>
                                <h4 className="text-lg font-bold mb-4">Compliance Audit Trail</h4>
                                <p className="text-sm text-[#888888] leading-relaxed">Append-only, SQL-readable decision log. Every action traceable by agent, context, score, and timestamp. GDPR-ready.</p>
                            </div>
                            <div className="bg-black p-10 hover:bg-[#111111]/50 transition-colors">
                                <span className="text-[10px] text-[#888888] font-mono mb-4 block">Layer 06</span>
                                <h4 className="text-lg font-bold mb-4">Automated Pruning</h4>
                                <p className="text-sm text-[#888888] leading-relaxed">Storage grows at log(n) not linear. Salience filtering, automated archival, and contradiction resolution—fully automatic.</p>
                            </div>
                        </div>
                    </div>
                </section>

                {/* Comparison */}
                <section className="py-24 bg-[#111111]/10" id="comparison">
                    <div className="max-w-7xl mx-auto px-6">
                        <h3 className="text-2xl font-bold mb-12 text-center uppercase tracking-widest text-[#888888]">The Decision Layer Advantage</h3>
                        <div className="overflow-x-auto">
                            <table className="w-full text-left border-collapse">
                                <thead>
                                    <tr className="border-b border-[#1A1A1A] text-[10px] uppercase tracking-widest text-[#888888]">
                                        <th className="py-6 px-4">Feature</th>
                                        <th className="py-6 px-4 text-[#00FF85]">Layer5</th>
                                        <th className="py-6 px-4">Observability</th>
                                        <th className="py-6 px-4">RL Pipelines</th>
                                    </tr>
                                </thead>
                                <tbody className="text-sm">
                                    <tr className="border-b border-[#1A1A1A]/50">
                                        <td className="py-6 px-4 font-bold">Production Learning</td>
                                        <td className="py-6 px-4 text-[#00FF85] font-mono">Real-time / Instant</td>
                                        <td className="py-6 px-4">Manual Review</td>
                                        <td className="py-6 px-4">Weeks (Retraining)</td>
                                    </tr>
                                    <tr className="border-b border-[#1A1A1A]/50">
                                        <td className="py-6 px-4 font-bold">Integration Cost</td>
                                        <td className="py-6 px-4 text-[#00FF85] font-mono">&lt;10 Lines of Code</td>
                                        <td className="py-6 px-4">Heavy SDKs</td>
                                        <td className="py-6 px-4">Infrastructure Rebuild</td>
                                    </tr>
                                    <tr className="border-b border-[#1A1A1A]/50">
                                        <td className="py-6 px-4 font-bold">Compliance Audit</td>
                                        <td className="py-6 px-4 text-[#00FF85] font-mono">Built-in (SQL)</td>
                                        <td className="py-6 px-4">Log Aggregation</td>
                                        <td className="py-6 px-4">Black-box Weights</td>
                                    </tr>
                                    <tr className="border-b border-[#1A1A1A]/50">
                                        <td className="py-6 px-4 font-bold">Cold Start Support</td>
                                        <td className="py-6 px-4 text-[#00FF85] font-mono">Day 1 Prior Injection</td>
                                        <td className="py-6 px-4">None</td>
                                        <td className="py-6 px-4">Data Dependency</td>
                                    </tr>
                                    <tr>
                                        <td className="py-6 px-4 font-bold">Latency</td>
                                        <td className="py-6 px-4 text-[#00FF85] font-mono">Sub-5ms</td>
                                        <td className="py-6 px-4">100ms+</td>
                                        <td className="py-6 px-4">Variable</td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>
                    </div>
                </section>

                {/* How it works */}
                <section className="py-24 bg-[#111111]/20 overflow-hidden" id="how-it-works">
                    <div className="max-w-7xl mx-auto px-6">
                        <span className="text-[#00FF85] text-[10px] font-bold tracking-[0.2em] uppercase mb-16 block">Proof</span>
                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-16 items-start">
                            <div className="rounded-lg border border-[#1A1A1A] bg-[#050505] shadow-2xl overflow-hidden font-mono text-sm leading-relaxed">
                                <div className="bg-[#111111] p-4 border-b border-[#1A1A1A] flex items-center justify-between">
                                    <span className="text-xs text-[#888888]">implementation.js</span>
                                    <div className="flex gap-2">
                                        <div className="w-3 h-3 rounded-full bg-[#1A1A1A]"></div>
                                    </div>
                                </div>
                                <div className="p-8">
                                    <span className="text-[#888888] block mb-2">{'// Before your agent acts'}</span>
                                    <span className="text-blue-400">const</span>{' { ranked_actions } = '}
                                    <span className="text-purple-400">await</span>{' layer5.'}
                                    <span className="text-yellow-200">getScores</span>{'({'}<br />
                                    {'  agent_id: '}<span className="text-green-300">{'\'payment-bot-1\''}</span>{','}<br />
                                    {'  context: { issue_type: '}<span className="text-green-300">{'\'payment_failed\''}</span>{', tier: '}<span className="text-green-300">{'\'enterprise\''}</span>{' }'}<br />
                                    {'});'}<br /><br />
                                    <span className="text-[#888888] block mb-2">{'// Returns: update_app(0.85) > clear_cache(0.61) > restart(0.07)'}</span>
                                    {'agent.'}<span className="text-yellow-200">execute</span>{'(ranked_actions['}<span className="text-orange-400">0</span>{'].action);'}<br /><br />
                                    <span className="text-[#888888] block mb-2">{'// After your agent acts'}</span>
                                    <span className="text-purple-400">await</span>{' layer5.'}<span className="text-yellow-200">logOutcome</span>{'({'}<br />
                                    {'  action: '}<span className="text-green-300">{'\'update_app\''}</span>{','}<br />
                                    {'  success: '}<span className="text-blue-400">true</span>{','}<br />
                                    {'  response_ms: '}<span className="text-orange-400">241</span><br />
                                    {'});'}
                                </div>
                            </div>
                            <div className="space-y-12 py-6">
                                <div className="flex gap-6">
                                    <div className="flex-shrink-0 w-8 h-8 rounded-sm bg-[#00FF85]/10 border border-[#00FF85]/30 flex items-center justify-center text-[#00FF85] text-xs font-bold">1</div>
                                    <div>
                                        <h4 className="text-lg font-bold mb-2">Layer5 works with any agent</h4>
                                        <p className="text-[#888888] text-sm leading-relaxed">One GET call before acting. One POST call after. No SDK required. Works with LangChain, AutoGen, or custom frameworks.</p>
                                    </div>
                                </div>
                                <div className="flex gap-6">
                                    <div className="flex-shrink-0 w-8 h-8 rounded-sm bg-[#00FF85]/10 border border-[#00FF85]/30 flex items-center justify-center text-[#00FF85] text-xs font-bold">2</div>
                                    <div>
                                        <h4 className="text-lg font-bold mb-2">Scores every action by evidence</h4>
                                        <p className="text-[#888888] text-sm leading-relaxed">ML scoring engine ranks actions by past success rate, recency, and context similarity. Updated in real-time.</p>
                                    </div>
                                </div>
                                <div className="flex gap-6">
                                    <div className="flex-shrink-0 w-8 h-8 rounded-sm bg-[#00FF85]/10 border border-[#00FF85]/30 flex items-center justify-center text-[#00FF85] text-xs font-bold">3</div>
                                    <div>
                                        <h4 className="text-lg font-bold mb-2">Agents get ranked recommendations</h4>
                                        <p className="text-[#888888] text-sm leading-relaxed">Sub-5ms latency ensures your agents aren't waiting for intelligence. Always takes the best action first.</p>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </section>

                {/* Final CTA */}
                <section className="py-[100px] relative" id="final-cta">
                    <div className="absolute inset-0 bg-gradient-to-b from-black via-[#00FF85]/5 to-black pointer-events-none"></div>
                    <div className="max-w-7xl mx-auto px-6 text-center relative z-10">
                        <span className="text-[#00FF85] text-[10px] font-bold tracking-[0.2em] uppercase mb-8 block">Get Started</span>
                        <h2 className="text-5xl md:text-7xl font-bold tracking-tighter mb-8 max-w-3xl mx-auto">
                            Your agents are failing right now.
                        </h2>
                        <p className="text-[#888888] mb-12 max-w-xl mx-auto">
                            Layer5 starts learning from your first outcome. Free during beta. No credit card required. Integration in under 30 minutes.
                        </p>
                        <div className="flex flex-col items-center gap-6">
                            <button
                                onClick={() => navigate('/auth?mode=signup')}
                                className="bg-[#00FF85] text-black px-12 py-5 text-lg font-bold tracking-tight hover:scale-105 hover:bg-white transition-all shadow-[0_0_40px_rgba(0,255,133,0.3)]"
                            >
                                Get Started Free — No Credit Card
                            </button>
                            <div className="mt-4 flex flex-col items-center gap-6">
                                <div className="flex flex-wrap justify-center gap-4 text-[10px] font-bold uppercase tracking-widest text-[#888888] opacity-60">
                                    <span>Built on PostgreSQL · Runs on your Supabase</span>
                                </div>
                                <div className="bg-[#111111]/50 border border-[#1A1A1A] px-4 py-2 rounded-full flex items-center gap-3">
                                    <span className="text-[11px] font-mono text-[#00FF85]">Beta access open · Limited to 50 teams</span>
                                </div>
                            </div>
                            <div className="flex items-center gap-8 text-[10px] text-[#888888] font-mono uppercase tracking-widest opacity-60">
                                <span>Free during beta</span>
                                <span>No credit card</span>
                                <span>30m setup</span>
                            </div>
                        </div>
                    </div>
                </section>
            </main>

            {/* Footer */}
            <footer className="py-12 border-t border-[#1A1A1A] bg-black">
                <div className="max-w-7xl mx-auto px-6 flex flex-col md:flex-row items-center justify-between gap-8">
                    <div className="flex items-center gap-2">
                        <span className="text-xl font-bold tracking-tighter">Layer<span className="text-[#00FF85]">5</span></span>
                        <span className="text-[#888888] text-[10px] ml-4 font-mono">Build v1.0.4 - March 2026</span>
                    </div>
                    <div className="flex gap-8 text-[10px] font-bold uppercase tracking-widest text-[#888888]">
                        <Link className="hover:text-[#00FF85] transition-colors" to="/privacy">Privacy</Link>
                        <Link className="hover:text-[#00FF85] transition-colors" to="/terms">Terms</Link>
                        <a className="hover:text-[#00FF85] transition-colors" href="#">Security</a>
                        <a className="hover:text-[#00FF85] transition-colors" href="#">Twitter</a>
                    </div>
                </div>
            </footer>
        </div>
    );
}
