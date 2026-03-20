import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { format, parseISO } from 'date-fns';
import { useOverviewMetrics } from '../../hooks/useOverviewMetrics';
import { useSuccessRateTrend } from '../../hooks/useSuccessRateTrend';
import { supabase } from '../../supabaseClient';

interface TrendTooltipProps {
  active?: boolean;
  payload?: Array<{ value: number | null }>;
  label?: string;
}

function TrendTooltip({ active, payload, label }: TrendTooltipProps): React.ReactElement | null {
  if (!active || !payload || payload.length === 0 || !label) return null;
  const value = payload[0]?.value;
  return (
    <div className="bg-[#111118] border border-[#1a1a24] rounded-lg px-3 py-2 text-xs">
      <div className="text-white font-medium">{format(parseISO(label), 'MMM dd, yyyy')}</div>
      <div className="text-[#a1a1aa]">Rate: {value == null ? 'No data' : `${value.toFixed(1)}%`}</div>
    </div>
  );
}

function SkeletonCard(): React.ReactElement {
  return <div className="h-28 rounded-xl bg-[#111118] border border-[#1a1a24] animate-pulse" />;
}

export default function Overview(): React.ReactElement {
  const navigate = useNavigate();
  const [selectedContext, setSelectedContext] = useState('');
  const [secondsSinceRefresh, setSecondsSinceRefresh] = useState(0);

  const metrics = useOverviewMetrics();
  const trend   = useSuccessRateTrend(selectedContext || undefined);

  useEffect(() => {
    const timer = window.setInterval(() => setSecondsSinceRefresh((p) => p + 5), 5000);
    return () => window.clearInterval(timer);
  }, []);

  const onRefresh = (): void => {
    metrics.refetch();
    trend.refetch();
    setSecondsSinceRefresh(0);
  };

  const isLoading              = metrics.loading || trend.loading;
  const error                  = metrics.error ?? trend.error;
  const isAccountSetupIncomplete = error?.includes('Account setup incomplete') ?? false;
  const showEmptyState         = !isLoading && !error && !metrics.hasScores;
  const chartData              = useMemo(() => trend.data, [trend.data]);

  const healthColor  = metrics.agentHealthScore >= 75 ? '#00cc66' : metrics.agentHealthScore >= 40 ? '#ffaa00' : '#ff4444';
  const successColor = metrics.successRate7d * 100 >= 80 ? '#00cc66' : metrics.successRate7d * 100 >= 60 ? '#ffaa00' : '#ff4444';
  const alertsColor  = metrics.activeAlerts > 0 ? '#ff4444' : '#00cc66';

  const xTickFormatter = (value: string, index: number): string => {
    if (index === 0) return '30 days ago';
    if (index === Math.floor((chartData.length - 1) / 2)) return '15 days ago';
    if (index === chartData.length - 1) return 'Today';
    return '';
  };

  return (
    <div className="text-white">
      <div className="flex items-end justify-between mb-6">
        <h1 className="text-3xl font-bold">Dashboard Overview</h1>
        <button className="text-xs text-[#a1a1aa] hover:text-white" onClick={onRefresh}>
          Last updated {secondsSinceRefresh}s ago
        </button>
      </div>

      {isAccountSetupIncomplete && (
        <div className="bg-[#ffaa00]/10 border border-[#ffaa00]/30 text-[#ffaa00] p-4 rounded-xl mb-6 flex items-center justify-between gap-3">
          <span>⚠ Account setup incomplete — sign out and sign in again to load your dashboard data.</span>
          <button
            className="border border-[#ffaa00]/40 rounded-lg px-3 py-1.5 text-xs font-semibold hover:bg-[#ffaa00]/10"
            onClick={async () => { await supabase.auth.signOut(); navigate('/auth?mode=login'); }}
          >
            Sign Out
          </button>
        </div>
      )}

      {error && !isAccountSetupIncomplete && (
        <div className="mb-4 bg-[#ff4444]/10 border border-[#ff4444]/30 text-[#ff8a8a] rounded-xl px-4 py-3 text-sm flex items-center justify-between">
          <span>{error}</span>
          <button className="text-white text-xs border border-[#1a1a24] rounded-lg px-3 py-1.5" onClick={onRefresh}>Retry</button>
        </div>
      )}

      {isLoading ? (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4 mb-6">
            <SkeletonCard /><SkeletonCard /><SkeletonCard /><SkeletonCard />
          </div>
          <div className="h-[360px] rounded-xl bg-[#111118] border border-[#1a1a24] animate-pulse" />
        </>
      ) : showEmptyState ? (
        <section className="flex flex-col items-center justify-center py-24 text-center">
          <div className="text-5xl mb-4 opacity-20">📊</div>
          <h3 className="text-white font-semibold text-lg mb-2">No scores yet</h3>
          <p className="text-[#52525b] text-sm max-w-sm mb-6">
            Connect your agent with the SDK and log your first outcome. Scores appear here within minutes.
          </p>
          {/* Fixed: links to real PyPI page instead of broken /docs route */}
          <a
            href="https://pypi.org/project/layerinfinite-sdk/"
            target="_blank"
            rel="noreferrer"
            className="bg-[#b8ff00] text-black font-semibold px-5 py-2 rounded-lg text-sm hover:bg-[#a0e600]"
          >
            View SDK Docs
          </a>
        </section>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4 mb-6">
            <div className="bg-[#111118] border border-[#1a1a24] rounded-xl p-5">
              <p className="text-[#a1a1aa] text-sm">Agent Health Score</p>
              <div className="flex items-end gap-2 mt-3">
                <span className="text-4xl font-bold" style={{ color: healthColor }}>{metrics.agentHealthScore}</span>
                <span className="text-[#52525b] text-sm mb-1">/ 100</span>
              </div>
              <p className="text-xs mt-3 text-[#a1a1aa]">{metrics.agentHealthDelta > 0 ? '+' : ''}{metrics.agentHealthDelta} vs previous</p>
            </div>

            <div className="bg-[#111118] border border-[#1a1a24] rounded-xl p-5">
              <p className="text-[#a1a1aa] text-sm">Decisions Today</p>
              <div className="flex items-end gap-2 mt-3">
                <span className="text-4xl font-bold">{metrics.decisionsToday.toLocaleString()}</span>
              </div>
              <p className="text-xs mt-3 text-[#a1a1aa]">{metrics.decisionsDelta > 0 ? '+' : ''}{metrics.decisionsDelta} vs previous 24h</p>
            </div>

            <div className="bg-[#111118] border border-[#1a1a24] rounded-xl p-5">
              <p className="text-[#a1a1aa] text-sm">7-Day Success Rate</p>
              <div className="flex items-end gap-2 mt-3">
                <span className="text-4xl font-bold" style={{ color: successColor }}>{(metrics.successRate7d * 100).toFixed(1)}%</span>
              </div>
              <p className="text-xs mt-3 text-[#a1a1aa]">{metrics.successRateDelta > 0 ? '+' : ''}{metrics.successRateDelta.toFixed(1)} pts vs baseline</p>
            </div>

            <button className="bg-[#111118] border border-[#1a1a24] rounded-xl p-5 text-left" onClick={() => navigate('/dashboard/alerts')}>
              <div className="flex items-center justify-between">
                <p className="text-[#a1a1aa] text-sm">Active Alerts</p>
                {metrics.alertSeverity === 'critical' && (
                  <span className="text-[10px] font-bold px-2 py-1 rounded-full bg-[#ff4444]/20 text-[#ff4444] border border-[#ff4444]/40">CRITICAL</span>
                )}
              </div>
              <div className="flex items-end gap-2 mt-3">
                <span className="text-4xl font-bold" style={{ color: alertsColor }}>{metrics.activeAlerts}</span>
              </div>
              <p className="text-xs mt-3 text-[#a1a1aa]">Click to open alerts feed</p>
            </button>
          </div>

          <section className="bg-[#111118] border border-[#1a1a24] rounded-xl overflow-hidden">
            <div className="p-5 border-b border-[#1a1a24] flex items-center justify-between">
              <h2 className="font-bold text-lg">Success Rate - Last 30 Days</h2>
              <select
                className="bg-[#0a0a0f] border border-[#1a1a24] rounded-lg px-3 py-1.5 text-xs text-[#a1a1aa]"
                value={selectedContext}
                onChange={(e) => setSelectedContext(e.target.value)}
              >
                <option value="">All Contexts</option>
              </select>
            </div>
            <div className="p-5 h-[320px]">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData}>
                  <defs>
                    <linearGradient id="overviewRateFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="rgba(184,255,0,0.12)" />
                      <stop offset="100%" stopColor="rgba(184,255,0,0.00)" />
                    </linearGradient>
                  </defs>
                  <CartesianGrid vertical={false} stroke="#1a1a24" opacity={0.5} />
                  <XAxis dataKey="date" tickFormatter={xTickFormatter} tick={{ fill: '#52525b', fontSize: 11 }} axisLine={{ stroke: '#1a1a24' }} tickLine={false} minTickGap={40} />
                  <YAxis domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} tickFormatter={(v) => `${v}%`} tick={{ fill: '#52525b', fontSize: 11, fontFamily: 'monospace' }} axisLine={{ stroke: '#1a1a24' }} tickLine={false} />
                  <Tooltip content={<TrendTooltip />} />
                  <ReferenceLine y={80} stroke="#52525b" strokeDasharray="4 4" label={{ value: 'Target', fill: '#52525b', fontSize: 11, position: 'right' }} />
                  <Area type="monotone" dataKey="rate" stroke="none" fill="url(#overviewRateFill)" connectNulls={false} />
                  <Line type="monotone" dataKey="rate" stroke="#b8ff00" strokeWidth={2} dot={false} connectNulls={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </section>
        </>
      )}
    </div>
  );
}