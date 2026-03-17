import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useTopActions } from '../../hooks/useTopActions';

function trendBadge(trend: 'improving' | 'degrading' | 'stable'): { text: string; classes: string } {
  if (trend === 'improving') {
    return { text: 'IMPROVING', classes: 'bg-[#00cc66]/10 text-[#00cc66] border border-[#00cc66]/30' };
  }
  if (trend === 'degrading') {
    return { text: 'DEGRADING', classes: 'bg-[#ff4444]/10 text-[#ff4444] border border-[#ff4444]/30' };
  }
  return { text: 'STABLE', classes: 'bg-[#52525b]/20 text-[#a1a1aa] border border-[#52525b]/30' };
}

export default function Actions(): React.ReactElement {
  const navigate = useNavigate();
  const { topActions, degradingActions, loading, error } = useTopActions();

  const totalSamples = topActions.reduce((sum, item) => sum + item.sampleCount, 0);

  if (loading) {
    return <div className="h-[320px] rounded-xl bg-[#111118] border border-[#1a1a24] animate-pulse" />;
  }

  if (error) {
    return (
      <div className="bg-[#ff4444]/10 border border-[#ff4444]/30 text-[#ff8a8a] rounded-xl p-4 text-sm">
        {error}
      </div>
    );
  }

  if (topActions.length === 0) {
    return (
      <div className="bg-[#111118] border border-[#1a1a24] rounded-xl p-8 text-center">
        <p className="text-white text-lg font-medium">No action data yet - start logging outcomes via the SDK to see performance metrics here.</p>
      </div>
    );
  }

  return (
    <div className="text-white">
      <section className="mb-10">
        <h1 className="text-2xl font-bold">Top Actions by Success Rate</h1>
        <p className="text-[#a1a1aa] text-sm mt-1">
          Global performance metrics for high-frequency operations <span className="text-[#52525b]">(n={totalSamples.toLocaleString()} outcomes)</span>
        </p>

        <div className="mt-5 bg-[#111118] border border-[#1a1a24] rounded-xl px-5">
          {topActions.map((action, index) => {
            const badge = trendBadge(action.trend);
            return (
              <div key={`${action.actionName}-${index}`} className="py-4 border-b border-[#1a1a24] last:border-b-0">
                <div className="flex items-center gap-3">
                  <span className="font-mono text-sm text-white min-w-[220px]">{action.actionName}</span>
                  <div className="bg-[#1a1a24] rounded-full h-1.5 flex-1 mx-1 overflow-hidden">
                    <div
                      className="h-full transition-all duration-700"
                      style={{ width: `${Math.max(0, Math.min(action.successRate * 100, 100))}%`, backgroundColor: action.barColor }}
                    />
                  </div>
                  <span className={`text-[10px] font-bold px-2 py-1 rounded-full ${badge.classes}`}>{badge.text}</span>
                  <span className="font-mono font-bold text-white min-w-[56px] text-right">{(action.successRate * 100).toFixed(1)}%</span>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold">Needs Improvement</h2>
          {degradingActions.length === 0 && (
            <div className="text-xs px-3 py-1.5 rounded-full bg-[#00cc66]/10 border border-[#00cc66]/30 text-[#00cc66]">
              ✓ System Overall Healthy
            </div>
          )}
        </div>

        {degradingActions.length === 0 ? (
          <div className="bg-[#111118] border border-[#1a1a24] rounded-xl p-8 text-center">
            <div className="text-[#00cc66] text-3xl">✓</div>
            <p className="text-white mt-3">All other actions performing well ✓</p>
            <p className="text-[#a1a1aa] text-sm mt-1">No additional degrading trends detected</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {degradingActions.map((action, index) => (
              <div key={action.actionId} className="bg-[#111118] border border-[#1a1a24] rounded-xl p-4">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-[#52525b] text-xs font-mono">ID: ACT-{String(index + 1).padStart(3, '0')}</span>
                  <span className="text-[10px] font-bold px-2 py-1 rounded-full bg-[#ff4444]/20 text-[#ff4444] border border-[#ff4444]/40">ALERT</span>
                </div>
                <p className="text-xl font-bold text-white font-mono">{action.actionName}</p>
                <p className="text-3xl font-bold text-[#ff4444] mt-2">{(action.successRate * 100).toFixed(1)}%</p>
                <p className="text-[#ff4444] text-sm mt-1">-{Math.abs(action.trendDelta * 100).toFixed(1)}% this week</p>
                <button
                  className="mt-4 border border-[#1a1a24] text-[#a1a1aa] hover:text-white hover:border-[#2a2a34] px-3 py-2 rounded-lg text-sm"
                  onClick={() => navigate(`/dashboard/alerts?action=${encodeURIComponent(action.actionName)}`)}
                >
                  Analyze
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      <footer className="mt-8 text-[#52525b] text-xs text-center">© Layerinfinite. Data snapshots refreshed every 30s.</footer>
    </div>
  );
}
