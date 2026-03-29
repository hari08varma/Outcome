import React, { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

const TERMINAL_LINES = [
  { delay: 0,    color: 'text-[#555555]',   text: '# 1. Install the SDK' },
  { delay: 400,  color: 'text-[#00FF85]',   text: '$ pip install layerinfinite-sdk' },
  { delay: 1000, color: 'text-[#555555]',   text: '' },
  { delay: 1200, color: 'text-[#555555]',   text: '# 2. Get ranked actions before your agent acts' },
  { delay: 1600, color: 'text-blue-400',    text: 'from layerinfinite import LayerinfiniteClient, LogOutcomeRequest' },
  { delay: 1900, color: 'text-white',       text: 'client = LayerinfiniteClient(api_key="layerinfinite_xxxx")' },
  { delay: 2300, color: 'text-white',       text: 'scores = client.get_scores(' },
  { delay: 2500, color: 'text-green-300',   text: '    issue_type="payment_failed",' },
  { delay: 2700, color: 'text-green-300',   text: '    agent_id="payment-bot-1"' },
  { delay: 2900, color: 'text-white',       text: ')' },
  { delay: 3100, color: 'text-[#555555]',   text: '' },
  { delay: 3300, color: 'text-[#555555]',   text: '# Returns ranked actions instantly' },
  { delay: 3600, color: 'text-[#00FF85]',   text: '# v  update_app     score: 0.85  <- best action' },
  { delay: 3900, color: 'text-[#888888]',   text: '# .  clear_cache    score: 0.61' },
  { delay: 4100, color: 'text-red-400',     text: '# x  restart_svc    score: 0.07  <- skip' },
  { delay: 4400, color: 'text-[#555555]',   text: '' },
  { delay: 4600, color: 'text-[#555555]',   text: '# 3. Log outcome after execution' },
  { delay: 5000, color: 'text-white',       text: 'client.log_outcome(LogOutcomeRequest(' },
  { delay: 5200, color: 'text-green-300',   text: '    agent_id="payment-bot-1",' },
  { delay: 5400, color: 'text-green-300',   text: '    action_name="update_app",' },
  { delay: 5600, color: 'text-green-300',   text: '    issue_type="payment_failed",' },
  { delay: 5800, color: 'text-green-300',   text: '    context_id="ctx_abc",' },
  { delay: 6000, color: 'text-green-300',   text: '    success=True,' },
  { delay: 6200, color: 'text-green-300',   text: '    outcome_score=0.9' },
  { delay: 6400, color: 'text-white',       text: '))' },
  { delay: 6700, color: 'text-[#00FF85]',   text: '# Agent is now learning from this outcome.' },
];

function AnimatedTerminal(): React.ReactElement {
  const [visibleCount, setVisibleCount] = useState(0);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    TERMINAL_LINES.forEach((line, i) => {
      setTimeout(() => setVisibleCount(i + 1), line.delay);
    });
  }, []);

  return (
    <div className="rounded-lg border border-[#1a1a24] bg-[#07070f] shadow-2xl overflow-hidden font-mono text-[13px] leading-relaxed">
      <div className="bg-[#0e0e18] px-4 py-3 border-b border-[#1a1a24] flex items-center gap-2">
        <div className="w-2.5 h-2.5 rounded-full bg-red-500/50" />
        <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/50" />
        <div className="w-2.5 h-2.5 rounded-full bg-[#00FF85]/50" />
        <span className="text-[11px] text-[#555555] ml-3">quick_start.py</span>
      </div>
      <div className="p-6 min-h-[340px]">
        {TERMINAL_LINES.slice(0, visibleCount).map((line, i) => (
          <div key={i} className={`${line.color} ${line.text === '' ? 'h-4' : ''}`}>
            {line.text}
          </div>
        ))}
        {visibleCount < TERMINAL_LINES.length && (
          <span className="inline-block w-2 h-4 bg-[#00FF85] animate-pulse" />
        )}
      </div>
    </div>
  );
}

function StatCard({ value, label }: { value: string; label: string }): React.ReactElement {
  return (
    <div className="text-center md:text-left">
      <div className="text-[#00FF85] text-3xl md:text-4xl font-bold mb-2 tracking-tight">{value}</div>
      <div className="text-[#888888] text-sm font-medium">{label}</div>
    </div>
  );
}

function FeatureCard({ icon, title, desc }: { icon: string; title: string; desc: string }): React.ReactElement {
  return (
    <div className="bg-black border border-[#1a1a24] p-8 hover:border-[#00FF85]/30 hover:bg-[#07070f] transition-all group">
      <div className="text-2xl mb-5">{icon}</div>
      <h4 className="text-base font-bold mb-3 group-hover:text-[#00FF85] transition-colors">{title}</h4>
      <p className="text-sm text-[#888888] leading-relaxed">{desc}</p>
    </div>
  );
}

// ── Real Python SDK code lines (matches client.py + models.py) ──
const PY_LINES = [
  { color: 'text-[#555555]', text: '# Install' },
  { color: 'text-[#00FF85]', text: 'pip install layerinfinite-sdk' },
  { color: '', text: '' },
  { color: 'text-[#555555]', text: '# Import' },
  { color: 'text-blue-400',  text: 'from layerinfinite import LayerinfiniteClient, LogOutcomeRequest' },
  { color: '', text: '' },
  { color: 'text-[#555555]', text: '# Init — key must start with layerinfinite_' },
  { color: 'text-white',     text: 'client = LayerinfiniteClient(' },
  { color: 'text-green-300', text: '    api_key="layerinfinite_your_key"' },
  { color: 'text-white',     text: ')' },
  { color: '', text: '' },
  { color: 'text-[#555555]', text: '# Get ranked actions' },
  { color: 'text-white',     text: 'scores = client.get_scores(' },
  { color: 'text-green-300', text: '    issue_type="payment_failed",' },
  { color: 'text-green-300', text: '    agent_id="my-agent"        # optional' },
  { color: 'text-white',     text: ')' },
  { color: 'text-[#888888]', text: '# scores.top_action.action_name  -> best action' },
  { color: '', text: '' },
  { color: 'text-[#555555]', text: '# Log outcome' },
  { color: 'text-white',     text: 'client.log_outcome(LogOutcomeRequest(' },
  { color: 'text-green-300', text: '    agent_id="my-agent",' },
  { color: 'text-green-300', text: '    action_name="escalate_to_human",' },
  { color: 'text-green-300', text: '    issue_type="payment_failed",' },
  { color: 'text-green-300', text: '    context_id=scores.context_id,' },
  { color: 'text-green-300', text: '    success=True,' },
  { color: 'text-green-300', text: '    outcome_score=0.9' },
  { color: 'text-white',     text: '))' },
];

// ── Real JS/TS SDK code lines (matches client.ts + types.ts) ──
const JS_LINES = [
  { color: 'text-[#555555]', text: '// Install' },
  { color: 'text-[#00FF85]', text: 'npm install layerinfinite-sdk' },
  { color: '', text: '' },
  { color: 'text-[#555555]', text: '// Import' },
  { color: 'text-blue-400',  text: "import { LayerinfiniteClient } from 'layerinfinite-sdk';" },
  { color: '', text: '' },
  { color: 'text-[#555555]', text: '// Init — key must start with layerinfinite_' },
  { color: 'text-white',     text: 'const client = new LayerinfiniteClient({' },
  { color: 'text-green-300', text: '  apiKey: "layerinfinite_your_key"' },
  { color: 'text-white',     text: '});' },
  { color: '', text: '' },
  { color: 'text-[#555555]', text: '// Get ranked actions' },
  { color: 'text-white',     text: 'const scores = await client.getScores({' },
  { color: 'text-green-300', text: '  agentId: "my-agent",' },
  { color: 'text-green-300', text: '  issueType: "payment_failed"' },
  { color: 'text-white',     text: '});' },
  { color: 'text-[#888888]', text: '// scores.top_action.action_name  -> best action' },
  { color: '', text: '' },
  { color: 'text-[#555555]', text: '// Log outcome' },
  { color: 'text-white',     text: 'await client.logOutcome({' },
  { color: 'text-green-300', text: '  agent_id: "my-agent",' },
  { color: 'text-green-300', text: '  action_id: scores.top_action.action_id,' },
  { color: 'text-green-300', text: '  context_id: scores.context_id,' },
  { color: 'text-green-300', text: '  issue_type: "payment_failed",' },
  { color: 'text-green-300', text: '  success: true,' },
  { color: 'text-green-300', text: '  outcome_score: 0.9' },
  { color: 'text-white',     text: '});' },
];

function CodeBlock({ lines }: { lines: { color: string; text: string }[] }): React.ReactElement {
  return (
    <div className="p-6 font-mono text-[12px] leading-relaxed space-y-0">
      {lines.map((line, i) =>
        line.text === '' ? (
          <div key={i} className="h-3" />
        ) : (
          <div key={i} className={line.color}>{line.text}</div>
        )
      )}
    </div>
  );
}

// ── Pricing tier data ──
const PRICING_TIERS = [
  {
    label: 'Free',
    price: '$0',
    per: '/month',
    sub: 'No credit card required',
    highlight: false,
    badge: null,
    features: [
      '1 agent',
      '5,000 outcomes / month',
      'Action scoring — see what worked',
      '1 task type recommendation',
      'Community support',
    ],
    cta: 'Get Started Free',
    ctaType: 'signup' as const,
  },
  {
    label: 'Pro',
    price: '$79',
    per: '/month',
    sub: 'Individual devs & small startups',
    highlight: true,
    badge: 'MOST POPULAR',
    features: [
      'Up to 5 agents',
      '50,000 outcomes / month',
      'Full recommendation engine — all task types',
      'Safety gate (≥20 samples, ≥0.75 confidence)',
      'Reason engine — plain language per recommendation',
      'Compliance export CSV / JSON',
      'Email support',
    ],
    cta: 'Start Pro',
    ctaType: 'signup' as const,
  },
  {
    label: 'Growth',
    price: '$249',
    per: '/month',
    sub: 'Production teams at scale',
    highlight: false,
    badge: null,
    features: [
      'Unlimited agents',
      '500,000 outcomes / month',
      'Everything in Pro',
      'Recommendations API (GET /v1/recommendations)',
      '3 team dashboard seats',
      'Slack / Email degradation alerts',
      'Priority support',
    ],
    cta: 'Start Growth',
    ctaType: 'signup' as const,
  },
  {
    label: 'Enterprise',
    price: 'Custom',
    per: '',
    sub: 'From $1,500 / month',
    highlight: false,
    badge: null,
    features: [
      'Unlimited everything',
      'Private deploy option',
      'SOC2 / HIPAA on request',
      'Custom retention policies',
      'SLA guarantee',
      'Dedicated onboarding',
    ],
    cta: 'Contact Us',
    ctaType: 'email' as const,
  },
];

// ── Use case data ──
const USE_CASES = [
  {
    icon: '🤖',
    title: 'Customer Support Agents',
    quote: 'Your agent is routing edge cases to humans. Layerinfinite tells you which routing action actually closes tickets — and which one is making it worse.',
  },
  {
    icon: '💰',
    title: 'Finance & Payment Agents',
    quote: '31% of your recovery emails are failing. Layerinfinite identifies the exact action to replace and shows you the expected recovery rate improvement.',
  },
  {
    icon: '🔧',
    title: 'DevOps Automation',
    quote: 'Stop guessing which fix to run first. Layerinfinite builds a ranked playbook from real incident data. Best action first, every time.',
  },
  {
    icon: '📊',
    title: 'Data Pipeline Agents',
    quote: 'One bad imputation strategy is silently failing 57% of your pipelines. Layerinfinite finds it before it hits SLA.',
  },
];

export default function LandingPage(): React.ReactElement {
  const navigate = useNavigate();

  const scrollTo = (id: string): void => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <div className="bg-black text-white landing-page">

      {/* Nav */}
      <nav className="fixed top-0 w-full z-50 border-b border-[#1a1a24] bg-black/85 backdrop-blur-md">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <span className="text-xl font-bold tracking-tight">
            layer<span className="text-[#00FF85]">infinite</span>
          </span>
          <div className="hidden md:flex items-center gap-8 text-sm font-medium text-[#888888]">
            <button className="hover:text-white transition-colors" onClick={() => scrollTo('problem')}>Problem</button>
            <button className="hover:text-white transition-colors" onClick={() => scrollTo('how-it-works')}>How It Works</button>
            <button className="hover:text-white transition-colors" onClick={() => scrollTo('features')}>Features</button>
            <button className="hover:text-white transition-colors" onClick={() => scrollTo('sdk-docs')}>SDK Docs</button>
            <button className="hover:text-white transition-colors" onClick={() => scrollTo('pricing')}>Pricing</button>
          </div>
          <div className="flex items-center gap-3">
            <button onClick={() => navigate('/auth?mode=login')} className="text-sm font-medium text-[#888888] hover:text-white transition-colors">Sign In</button>
            <button onClick={() => navigate('/auth?mode=signup')} className="bg-[#00FF85] text-black px-5 py-2 text-sm font-bold tracking-tight hover:bg-white transition-all">Get Started Free</button>
          </div>
        </div>
      </nav>

      <main>

        {/* Hero */}
        <section className="relative pt-28 pb-20 overflow-hidden" id="hero">
          <div
            className="absolute inset-0 opacity-[0.025] pointer-events-none"
            style={{
              backgroundImage: 'linear-gradient(#00FF85 1px,transparent 1px),linear-gradient(90deg,#00FF85 1px,transparent 1px)',
              backgroundSize: '60px 60px',
            }}
          />
          <div className="absolute inset-0 bg-gradient-to-b from-black via-transparent to-black pointer-events-none" />

          <div className="max-w-7xl mx-auto px-6 relative z-10">
            <div className="flex justify-center mb-8">
              <div className="inline-flex items-center gap-2 border border-[#00FF85]/20 bg-[#00FF85]/5 px-4 py-1.5 rounded-full text-[11px] font-mono text-[#00FF85]">
                <span className="w-1.5 h-1.5 rounded-full bg-[#00FF85] animate-pulse" />
                Beta &middot; Open to founding teams &middot; 50 seats left
              </div>
            </div>

            <h1
              className="font-bold leading-[1.05] tracking-tighter text-center mb-6 max-w-4xl mx-auto"
              style={{ fontSize: 'clamp(40px, 6vw, 72px)' }}
            >
              Your AI agents make the{' '}
              <span className="text-[#00FF85]">same mistakes</span>{' '}
              every session.
            </h1>
            <p className="text-lg text-[#888888] text-center max-w-2xl mx-auto leading-relaxed mb-10">
              Layerinfinite is a decision intelligence layer that sits between your LLM and infrastructure.
              Agents learn what works from production outcomes &mdash;{' '}
              <strong className="text-white">without retraining, without rebuilding.</strong>
            </p>

            <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-16">
              <button
                onClick={() => navigate('/auth?mode=signup')}
                className="bg-[#00FF85] text-black px-8 py-3.5 text-sm font-bold tracking-tight hover:bg-white transition-all shadow-[0_0_30px_rgba(0,255,133,0.25)]"
              >
                Start for Free &mdash; No Credit Card
              </button>
              <button
                onClick={() => scrollTo('sdk-docs')}
                className="border border-[#1a1a24] text-[#888888] px-8 py-3.5 text-sm font-bold tracking-tight hover:border-[#00FF85]/40 hover:text-white transition-all"
              >
                View SDK Docs &rarr;
              </button>
            </div>

            <div className="flex flex-wrap items-center justify-center gap-6 text-[11px] text-[#555555] font-mono mb-16">
              <span>Python SDK on PyPI</span>
              <span className="text-[#1a1a24]">|</span>
              <span>JS/TS SDK on npm</span>
              <span className="text-[#1a1a24]">|</span>
              <span>Sub-5ms decision latency</span>
              <span className="text-[#1a1a24]">|</span>
              <span>Append-only audit trail</span>
              <span className="text-[#1a1a24]">|</span>
              <span>GDPR-ready</span>
            </div>

            <div className="max-w-2xl mx-auto">
              <AnimatedTerminal />
            </div>
          </div>
        </section>

        {/* Stats */}
        <section className="py-16 border-y border-[#1a1a24] bg-[#07070f]">
          <div className="max-w-7xl mx-auto px-6 grid grid-cols-1 md:grid-cols-3 gap-10 md:gap-16">
            <StatCard value="Sub-5ms" label="Decision latency benchmarked on PostgreSQL materialized views at scale" />
            <StatCard value="3 lines" label="Minimum integration. One log_outcome call is all it takes to start learning" />
            <StatCard value="10-year" label="Immutable audit trail. Every decision logged, traceable, GDPR-compliant" />
          </div>
        </section>

        {/* Problem */}
        <section className="py-24 bg-black" id="problem">
          <div className="max-w-7xl mx-auto px-6">
            <span className="text-[#00FF85] text-[10px] font-bold tracking-[0.2em] uppercase mb-4 block">The Problem</span>
            <h2 className="text-4xl md:text-5xl font-bold tracking-tight mb-4">Every session starts from zero.</h2>
            <p className="text-[#888888] max-w-xl mb-16 text-lg">
              Your agents are expensive. They&apos;re also amnesiac. Here&apos;s what production looks like without a decision layer.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {([
                {
                  err: '[ERR] agent_loop :: retry_overflow',
                  title: 'Agent Amnesia',
                  body: 'AI agents retry the same failed action 5-10 times per session with zero adaptation. Every failure costs compute, latency, and user trust.',
                  tag: '5-10 retries / session',
                },
                {
                  err: '[ERR] session_init :: cold_start',
                  title: 'No Cross-Session Learning',
                  body: "Every deployment resets to zero. The model never improves from production experience. Last week's fix is forgotten today.",
                  tag: '0% knowledge retained',
                },
                {
                  err: '[ERR] compliance :: audit_missing',
                  title: 'Zero Audit Trail',
                  body: 'EU AI Act requires 10-year decision trails. Vector stores cannot produce them. Your compliance team is flying blind.',
                  tag: '10yr retention required',
                },
              ] as { err: string; title: string; body: string; tag: string }[]).map(({ err, title, body, tag }) => (
                <div key={title} className="border border-[#1a1a24] p-8 hover:border-[#00FF85]/30 transition-colors bg-[#07070f]">
                  <div className="text-[10px] font-mono text-red-500/60 mb-5 uppercase tracking-widest">{err}</div>
                  <h3 className="text-lg font-bold mb-3">{title}</h3>
                  <p className="text-sm text-[#888888] leading-relaxed mb-8">{body}</p>
                  <div className="inline-block px-3 py-1 border border-[#00FF85]/20 text-[#00FF85] text-[10px] font-mono">{tag}</div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* How it works */}
        <section className="py-24 bg-[#07070f] border-y border-[#1a1a24]" id="how-it-works">
          <div className="max-w-7xl mx-auto px-6">
            <span className="text-[#00FF85] text-[10px] font-bold tracking-[0.2em] uppercase mb-4 block">How It Works</span>
            <h2 className="text-4xl md:text-5xl font-bold tracking-tight mb-16">Two API calls. Agents that learn.</h2>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-16 items-center">
              <div className="space-y-10">
                {([
                  { n: '01', title: 'Before your agent acts — get ranked scores', body: 'Call get_scores() / getScores() with your issue_type. Layerinfinite returns every available action ranked by evidence-based success probability for that exact context.' },
                  { n: '02', title: 'Your agent picks the top action', body: 'Execute scores.top_action. No guessing. No retrying failed paths. The best action for this context, backed by production history.' },
                  { n: '03', title: 'After acting — log the outcome', body: 'Call log_outcome() / logOutcome() with success and outcome_score. The scoring engine updates in real-time. Every agent in your fleet benefits immediately.' },
                  { n: '04', title: 'Dashboard shows what is working', body: 'Track agent health scores, success rates, degradation alerts, and decision recommendations in one place. No additional infra.' },
                ] as { n: string; title: string; body: string }[]).map(({ n, title, body }) => (
                  <div key={n} className="flex gap-6">
                    <div className="flex-shrink-0 w-10 h-10 border border-[#00FF85]/30 bg-[#00FF85]/5 flex items-center justify-center text-[#00FF85] text-xs font-bold font-mono">{n}</div>
                    <div>
                      <h4 className="font-bold mb-2">{title}</h4>
                      <p className="text-sm text-[#888888] leading-relaxed">{body}</p>
                    </div>
                  </div>
                ))}
              </div>

              <div className="border border-[#1a1a24] bg-black p-8 rounded-lg space-y-3 font-mono text-xs">
                <div className="text-[#555555] mb-2 uppercase tracking-widest text-[10px]">// System Architecture</div>
                {([
                  { label: 'Your Agent / LLM',                        cls: 'border-blue-400/40 text-blue-300',        small: false, hi: false },
                  { label: 'getScores()  |  logOutcome()',            cls: 'border-[#00FF85]/30 text-[#00FF85]',     small: true,  hi: false },
                  { label: 'Layerinfinite Decision Layer',             cls: 'border-[#00FF85]/40 text-[#00FF85]',     small: false, hi: true  },
                  { label: 'SQL  Materialized Views  Scoring Engine',  cls: 'border-[#555555]/40 text-[#555555]',    small: true,  hi: false },
                  { label: 'Your Supabase / Postgres',                 cls: 'border-[#888888]/30 text-[#888888]',    small: false, hi: false },
                  { label: 'audit trail  outcomes  agent trust',       cls: 'border-[#555555]/40 text-[#555555]',    small: true,  hi: false },
                  { label: 'Layerinfinite Dashboard',                  cls: 'border-purple-400/30 text-purple-300',  small: false, hi: false },
                ] as { label: string; cls: string; small: boolean; hi: boolean }[]).map(({ label, cls, small, hi }) => (
                  <div
                    key={label}
                    className={[
                      'border px-4 py-3 text-center',
                      cls,
                      small ? 'border-dashed text-[10px] py-1' : '',
                      hi ? 'bg-[#00FF85]/5' : '',
                    ].join(' ')}
                  >
                    {label}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* Features */}
        <section className="py-24 bg-black" id="features">
          <div className="max-w-7xl mx-auto px-6">
            <span className="text-[#00FF85] text-[10px] font-bold tracking-[0.2em] uppercase mb-4 block">Capabilities</span>
            <h2 className="text-4xl md:text-5xl font-bold tracking-tight mb-4">Everything production agents need.</h2>
            <p className="text-[#888888] mb-16 max-w-xl">Not just monitoring. Not just logging. An active intelligence layer that makes every agent decision better over time.</p>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-px bg-[#1a1a24]">
              <FeatureCard icon="🎯" title="Outcome-Ranked Decisions" desc="Every available action is scored using context-weighted success history. The best action surfaces automatically with no prompt engineering required." />
              <FeatureCard icon="🧊" title="Cold Start Protocol" desc="Four-stage bootstrap with prior injection and cross-agent transfer. Agents are intelligent from day one, not after 10,000 outcomes." />
              <FeatureCard icon="🛡️" title="Trust-Aware Routing" desc="Auto-suspends agents whose success rate drops below threshold. Routes to human escalation before damage compounds. Configurable per agent." />
              <FeatureCard icon="📉" title="Degradation Detection" desc="Detects performance trends before they crash your system. Recency-weighted scoring with automatic decay surfaces early warning signals." />
              <FeatureCard icon="📋" title="Compliance Audit Trail" desc="Append-only, SQL-readable decision log. Every action traceable by agent, context, score, and timestamp. GDPR and EU AI Act ready." />
              <FeatureCard icon="💡" title="AI Recommendations" desc="The dashboard surfaces exactly which actions to promote, demote, or investigate, backed by statistical confidence and production evidence." />
            </div>
          </div>
        </section>

        {/* SDK Docs — code blocks use real SDK signatures */}
        <section className="py-24 bg-[#07070f] border-y border-[#1a1a24]" id="sdk-docs">
          <div className="max-w-7xl mx-auto px-6">
            <span className="text-[#00FF85] text-[10px] font-bold tracking-[0.2em] uppercase mb-4 block">SDK Docs</span>
            <h2 className="text-4xl md:text-5xl font-bold tracking-tight mb-4">Integrate in under 30 minutes.</h2>
            <p className="text-[#888888] mb-16 max-w-xl">Available for Python and JavaScript/TypeScript. Works with LangChain, AutoGen, CrewAI, or any custom agent framework.</p>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-12">
              {/* Python SDK */}
              <div className="border border-[#1a1a24] rounded-lg overflow-hidden">
                <div className="bg-[#0e0e18] px-4 py-3 border-b border-[#1a1a24] flex items-center justify-between">
                  <span className="text-[11px] text-[#888888] font-mono">🐍 Python SDK &mdash; LayerinfiniteClient</span>
                  <a href="https://pypi.org/project/layerinfinite-sdk/" target="_blank" rel="noreferrer" className="text-[10px] text-[#00FF85] hover:underline font-mono">PyPI &rarr;</a>
                </div>
                <CodeBlock lines={PY_LINES} />
              </div>

              {/* JS/TS SDK */}
              <div className="border border-[#1a1a24] rounded-lg overflow-hidden">
                <div className="bg-[#0e0e18] px-4 py-3 border-b border-[#1a1a24] flex items-center justify-between">
                  <span className="text-[11px] text-[#888888] font-mono">🟨 JS / TS SDK &mdash; LayerinfiniteClient</span>
                  <a href="https://www.npmjs.com/package/layerinfinite-sdk" target="_blank" rel="noreferrer" className="text-[10px] text-[#00FF85] hover:underline font-mono">npm &rarr;</a>
                </div>
                <CodeBlock lines={JS_LINES} />
              </div>
            </div>

            {/* Key differences callout */}
            <div className="border border-[#1a1a24] bg-black p-6 rounded-lg mb-8">
              <div className="text-[10px] font-mono text-[#00FF85] uppercase tracking-widest mb-3">Key API Notes</div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-[11px] font-mono text-[#888888]">
                <div>
                  <span className="text-white">API key prefix</span><br />
                  Must start with <span className="text-[#00FF85]">layerinfinite_</span>
                </div>
                <div>
                  <span className="text-white">get_scores / getScores</span><br />
                  Required: <span className="text-[#00FF85]">issue_type / issueType</span>
                </div>
                <div>
                  <span className="text-white">log_outcome / logOutcome</span><br />
                  Required: <span className="text-[#00FF85]">outcome_score</span> (0.0&ndash;1.0)
                </div>
              </div>
            </div>

            <div className="border border-[#1a1a24] bg-black p-6 rounded-lg flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
              <div>
                <div className="text-sm font-bold mb-1">Prefer plain HTTP? Use the REST API directly.</div>
                <div className="text-[#888888] text-sm font-mono">POST https://api.layerinfinite.app/v1/log-outcome</div>
              </div>
              <a
                href="https://pypi.org/project/layerinfinite-sdk/"
                target="_blank"
                rel="noreferrer"
                className="flex-shrink-0 border border-[#00FF85]/30 text-[#00FF85] px-5 py-2 text-sm font-bold hover:bg-[#00FF85]/10 transition-all"
              >
                Full API Reference &rarr;
              </a>
            </div>
          </div>
        </section>

        {/* Comparison */}
        <section className="py-24 bg-black" id="comparison">
          <div className="max-w-7xl mx-auto px-6">
            <span className="text-[#00FF85] text-[10px] font-bold tracking-[0.2em] uppercase mb-4 block">Why Layerinfinite</span>
            <h2 className="text-4xl md:text-5xl font-bold tracking-tight mb-16">Built for production. Not for demos.</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-[#1a1a24] text-[10px] uppercase tracking-widest text-[#888888]">
                    <th className="py-5 px-4">Capability</th>
                    <th className="py-5 px-4 text-[#00FF85]">Layerinfinite</th>
                    <th className="py-5 px-4">Observability Tools</th>
                    <th className="py-5 px-4">RL Pipelines</th>
                    <th className="py-5 px-4">Manual Prompting</th>
                  </tr>
                </thead>
                <tbody className="text-sm">
                  {([
                    ['Production Learning',  'Real-time / Instant',     'Manual Review',     'Weeks (Retraining)', 'Never'],
                    ['Integration',          '3 lines of code',         'Heavy SDK setup',   'Infra rebuild',      'Prompt iteration'],
                    ['Compliance Audit',     'Built-in (SQL)',          'Log aggregation',   'Black-box weights',  'None'],
                    ['Cold Start Support',   'Day 1 prior injection',   'None',              'Data dependency',    'None'],
                    ['Decision Latency',     'Sub-5ms',                 '100ms+',            'Variable',           'LLM latency'],
                    ['Agent Trust Scoring',  'Auto-suspend on decay',   'None',              'None',               'None'],
                  ] as string[][]).map(([feat, li, obs, rl, manual]) => (
                    <tr key={feat} className="border-b border-[#1a1a24]/50 hover:bg-[#07070f] transition-colors">
                      <td className="py-5 px-4 font-bold text-white">{feat}</td>
                      <td className="py-5 px-4 text-[#00FF85] font-mono">{li}</td>
                      <td className="py-5 px-4 text-[#888888]">{obs}</td>
                      <td className="py-5 px-4 text-[#888888]">{rl}</td>
                      <td className="py-5 px-4 text-[#888888]">{manual}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        {/* Use Cases */}
        <section className="py-24 bg-[#07070f] border-y border-[#1a1a24]" id="use-cases">
          <div className="max-w-7xl mx-auto px-6">
            <span className="text-[#00FF85] text-[10px] font-bold tracking-[0.2em] uppercase mb-4 block">Use Cases</span>
            <h2 className="text-4xl md:text-5xl font-bold tracking-tight mb-4">Works for any AI agent in production.</h2>
            <p className="text-[#888888] mb-16 max-w-xl">Not hypothetical. These are the exact problems Layerinfinite was built to solve.</p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {USE_CASES.map(({ icon, title, quote }) => (
                <div
                  key={title}
                  className="border border-[#1a1a24] bg-black p-8 hover:border-[#00FF85]/30 hover:bg-[#07070f] transition-all group"
                >
                  {/* Icon + title row */}
                  <div className="flex items-center gap-3 mb-6">
                    <span className="text-2xl">{icon}</span>
                    <span className="text-[10px] font-mono font-bold uppercase tracking-widest text-[#555555] group-hover:text-[#00FF85] transition-colors">
                      {title}
                    </span>
                  </div>
                  {/* Pull quote */}
                  <blockquote className="border-l-2 border-[#00FF85]/40 pl-5">
                    <p className="text-[15px] text-white leading-relaxed font-medium">
                      &ldquo;{quote}&rdquo;
                    </p>
                  </blockquote>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Pricing — 4 tiers */}
        <section className="py-24 bg-black" id="pricing">
          <div className="max-w-7xl mx-auto px-6">
            <span className="text-[#00FF85] text-[10px] font-bold tracking-[0.2em] uppercase mb-4 block">Pricing</span>
            <h2 className="text-4xl md:text-5xl font-bold tracking-tight mb-4">Simple, honest pricing.</h2>
            <p className="text-[#888888] mb-16 max-w-xl">
              Start free. Hit the limit in two weeks if you&apos;re serious. Upgrade when you need it.
            </p>

            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-6">
              {PRICING_TIERS.map((tier) => (
                <div
                  key={tier.label}
                  className={[
                    'relative flex flex-col p-8',
                    tier.highlight
                      ? 'border border-[#00FF85]/50 bg-[#00FF85]/5'
                      : 'border border-[#1a1a24] bg-[#07070f]',
                  ].join(' ')}
                >
                  {/* Badge */}
                  {tier.badge && (
                    <div className="absolute -top-3 left-6 bg-[#00FF85] text-black text-[10px] font-bold px-3 py-1 tracking-widest">
                      {tier.badge}
                    </div>
                  )}

                  {/* Tier name */}
                  <div className={[
                    'text-[10px] font-mono font-bold uppercase tracking-widest mb-4',
                    tier.highlight ? 'text-[#00FF85]' : 'text-[#888888]',
                  ].join(' ')}>
                    {tier.label}
                  </div>

                  {/* Price */}
                  <div className="mb-1">
                    <span className="text-4xl font-bold tracking-tight">{tier.price}</span>
                    {tier.per && <span className="text-lg text-[#888888]">{tier.per}</span>}
                  </div>
                  <div className="text-[#555555] text-xs font-mono mb-8">{tier.sub}</div>

                  {/* Features */}
                  <ul className="space-y-3 text-sm text-[#888888] mb-10 flex-1">
                    {tier.features.map((f) => (
                      <li key={f} className="flex items-start gap-2">
                        <span className="text-[#00FF85] mt-0.5 flex-shrink-0">✓</span>
                        <span>{f}</span>
                      </li>
                    ))}
                  </ul>

                  {/* CTA */}
                  {tier.ctaType === 'email' ? (
                    <a
                      href="mailto:team@layerinfinite.app"
                      className="block text-center border border-[#1a1a24] text-[#888888] py-3 text-sm font-bold hover:border-[#00FF85]/40 hover:text-white transition-all"
                    >
                      {tier.cta}
                    </a>
                  ) : tier.highlight ? (
                    <button
                      onClick={() => navigate('/auth?mode=signup')}
                      className="w-full bg-[#00FF85] text-black py-3 text-sm font-bold hover:bg-white transition-all"
                    >
                      {tier.cta}
                    </button>
                  ) : (
                    <button
                      onClick={() => navigate('/auth?mode=signup')}
                      className="w-full border border-[#1a1a24] text-[#888888] py-3 text-sm font-bold hover:border-[#00FF85]/40 hover:text-white transition-all"
                    >
                      {tier.cta}
                    </button>
                  )}
                </div>
              ))}
            </div>

            {/* Growth callout — API access note */}
            <div className="mt-8 border border-[#1a1a24] bg-[#07070f] p-5 rounded-lg flex flex-col md:flex-row items-start md:items-center gap-4">
              <div className="flex-1">
                <span className="text-[10px] font-mono text-[#00FF85] uppercase tracking-widest">Growth &amp; Enterprise</span>
                <p className="text-sm text-[#888888] mt-1">
                  The <span className="text-white font-mono">GET /v1/recommendations</span> API is only available on Growth and above.
                  Pipe recommendations directly into your own systems — no dashboard required.
                </p>
              </div>
              <button
                onClick={() => navigate('/auth?mode=signup')}
                className="flex-shrink-0 border border-[#00FF85]/30 text-[#00FF85] px-5 py-2 text-sm font-bold hover:bg-[#00FF85]/10 transition-all whitespace-nowrap"
              >
                Start Growth &rarr;
              </button>
            </div>
          </div>
        </section>

        {/* Final CTA */}
        <section className="py-28 relative" id="final-cta">
          <div className="absolute inset-0 bg-gradient-to-b from-black via-[#00FF85]/5 to-black pointer-events-none" />
          <div className="max-w-7xl mx-auto px-6 text-center relative z-10">
            <div className="inline-flex items-center gap-2 border border-[#00FF85]/20 bg-[#00FF85]/5 px-4 py-1.5 rounded-full text-[11px] font-mono text-[#00FF85] mb-8">
              <span className="w-1.5 h-1.5 rounded-full bg-[#00FF85] animate-pulse" />
              Free beta &middot; 50 founding team seats
            </div>
            <h2 className="text-5xl md:text-6xl font-bold tracking-tighter mb-6 max-w-3xl mx-auto">
              Your agents are failing{' '}<span className="text-[#00FF85]">right now.</span>
            </h2>
            <p className="text-[#888888] mb-10 max-w-lg mx-auto text-lg">
              Layerinfinite starts learning from your first outcome. Free during beta. No credit card. Integration in under 30 minutes.
            </p>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-10">
              <button
                onClick={() => navigate('/auth?mode=signup')}
                className="bg-[#00FF85] text-black px-10 py-4 text-base font-bold tracking-tight hover:scale-105 hover:bg-white transition-all shadow-[0_0_40px_rgba(0,255,133,0.3)]"
              >
                Get Started Free &mdash; No Credit Card
              </button>
              <button
                onClick={() => scrollTo('sdk-docs')}
                className="border border-[#1a1a24] text-[#888888] px-10 py-4 text-base font-bold hover:border-[#00FF85]/40 hover:text-white transition-all"
              >
                Read the Docs &rarr;
              </button>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-6 text-[11px] text-[#555555] font-mono">
              <span>Free during beta</span>
              <span>&middot;</span>
              <span>No credit card</span>
              <span>&middot;</span>
              <span>30-minute setup</span>
              <span>&middot;</span>
              <span>Cancel anytime</span>
            </div>
          </div>
        </section>

      </main>

      {/* Footer */}
      <footer className="py-12 border-t border-[#1a1a24] bg-black">
        <div className="max-w-7xl mx-auto px-6 flex flex-col md:flex-row items-center justify-between gap-8">
          <div className="flex items-center gap-6">
            <span className="text-xl font-bold tracking-tight">layer<span className="text-[#00FF85]">infinite</span></span>
            <span className="text-[#555555] text-[10px] font-mono">v1.0 &middot; March 2026</span>
          </div>
          <div className="flex gap-8 text-[11px] font-bold uppercase tracking-widest text-[#888888]">
            <Link className="hover:text-[#00FF85] transition-colors" to="/privacy">Privacy</Link>
            <Link className="hover:text-[#00FF85] transition-colors" to="/terms">Terms</Link>
            <a className="hover:text-[#00FF85] transition-colors" href="mailto:team@layerinfinite.app">Contact</a>
            <a className="hover:text-[#00FF85] transition-colors" href="https://pypi.org/project/layerinfinite-sdk/" target="_blank" rel="noreferrer">SDK</a>
          </div>
        </div>
      </footer>

    </div>
  );
}
