import React, { useMemo, useState } from 'react';
import { format, formatDistanceToNowStrict, parseISO } from 'date-fns';
import { AlertsFilter, useAlerts } from '../../hooks/useAlerts';

const FILTERS: Array<{ key: AlertsFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'latency_spike', label: 'Latency Spike' },
  { key: 'context_drift', label: 'Context Drift' },
  { key: 'coordinated_failure', label: 'Coordinated Failure' },
  { key: 'silent_failure', label: 'Silent Failure' },
];

function alertTypeLabel(value: string): string {
  return value.replace(/_/g, ' ').toUpperCase();
}

function parseDateSafe(value: string): Date | null {
  const parsed = parseISO(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export default function Alerts(): React.ReactElement {
  const [activeFilter, setActiveFilter] = useState<AlertsFilter>('all');
  const [showResolved, setShowResolved] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [fadingIds, setFadingIds] = useState<Set<string>>(new Set());

  const { alerts, resolveAlert, loading, error, refetch } = useAlerts(activeFilter, showResolved);

  const onRetry = (): void => {
    refetch();
  };

  const unresolvedOnlyCount = useMemo(() => alerts.filter((a) => !a.resolved).length, [alerts]);

  const onResolve = async (id: string): Promise<void> => {
    setResolvingId(id);
    setFadingIds((prev) => new Set(prev).add(id));

    window.setTimeout(async () => {
      try {
        await resolveAlert(id);
      } finally {
        setResolvingId(null);
        setConfirmingId(null);
        setFadingIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    }, 300);
  };

  return (
    <div className="text-white">
      <h1 className="text-2xl font-bold">Alerts & Anomalies</h1>

      <section className="mt-6 flex flex-col xl:flex-row xl:items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-2">
          {FILTERS.map((item) => (
            <button
              key={item.key}
              className={activeFilter === item.key
                ? 'px-4 py-1.5 rounded-full text-sm font-medium bg-[#b8ff00] text-black'
                : 'px-4 py-1.5 rounded-full text-sm font-medium border border-[#1a1a24] text-[#a1a1aa] hover:text-white'}
              onClick={() => setActiveFilter(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-3">
          <span className="text-sm text-[#a1a1aa]">Show Resolved</span>
          <button
            role="switch"
            aria-checked={showResolved}
            className={`relative inline-flex h-6 w-11 rounded-full transition-colors ${showResolved ? 'bg-[#b8ff00]' : 'bg-[#1a1a24]'}`}
            onClick={() => setShowResolved((prev) => !prev)}
          >
            <span className={`inline-block h-5 w-5 rounded-full bg-white mt-0.5 transition-transform ${showResolved ? 'translate-x-5' : 'translate-x-0.5'}`} />
          </button>
        </div>
      </section>

      {error && (
        <div className="mt-4 bg-[#ff4444]/10 border border-[#ff4444]/30 text-[#ff8a8a] rounded-xl p-4 text-sm flex items-center justify-between gap-3">
          <span>{error}</span>
          <button className="text-white text-xs border border-[#1a1a24] rounded-lg px-3 py-1.5" onClick={onRetry}>Retry</button>
        </div>
      )}

      {loading ? (
        <div className="mt-6 h-[260px] rounded-xl bg-[#111118] border border-[#1a1a24] animate-pulse" />
      ) : unresolvedOnlyCount === 0 && !showResolved ? (
        <section className="mt-20 flex flex-col items-center text-center py-24">
          <div className="text-5xl mb-4 opacity-20">🔔</div>
          <h2 className="text-white font-semibold text-lg mb-2">No alerts — all clear</h2>
          <p className="text-[#52525b] text-sm max-w-sm">
            Degradation alerts, latency spikes, and coordinated failures appear here when detected.
          </p>
        </section>
      ) : (
        <section className="mt-6 flex flex-col gap-3">
          {alerts.map((alert) => (
            (() => {
              const createdDate = parseDateSafe(alert.createdAt);
              const relativeTime = createdDate
                ? formatDistanceToNowStrict(createdDate, { addSuffix: true })
                : '-';
              const absoluteTime = createdDate
                ? format(createdDate, 'MMM dd, yyyy HH:mm:ss')
                : '-';

              return (
            <article
              key={alert.id}
              className={`bg-[#111118] border border-[#1a1a24] rounded-xl p-4 flex gap-4 transition-opacity duration-300 ${fadingIds.has(alert.id) ? 'opacity-0' : 'opacity-100'}`}
            >
              <div className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0">
                {alert.severity === 'critical' ? (
                  <span className="w-8 h-8 rounded-full bg-[#ff4444]/20 text-[#ff4444] flex items-center justify-center">!</span>
                ) : (
                  <span className="w-8 h-8 rounded-full bg-[#ffaa00]/20 text-[#ffaa00] flex items-center justify-center">!</span>
                )}
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <span className="uppercase text-[10px] font-bold px-2 py-1 rounded-full bg-[#1a1a24] text-[#a1a1aa] border border-[#2a2a34]">
                    {alertTypeLabel(alert.alertType)}
                  </span>
                  <span className={`uppercase text-[10px] font-bold px-2 py-1 rounded-full ${alert.severity === 'critical' ? 'bg-[#ff4444]/20 text-[#ff4444] border border-[#ff4444]/40' : 'bg-[#ffaa00]/20 text-[#ffaa00] border border-[#ffaa00]/40'}`}>
                    {alert.severity}
                  </span>
                </div>

                <p className="text-white text-sm font-medium mt-2">{alert.message}</p>

                <div className="flex flex-wrap gap-2 mt-2 items-center">
                  <span className="font-mono text-xs bg-[#1a1a24] px-2 py-0.5 rounded text-[#a1a1aa]">{alert.actionName}</span>
                  <span className="text-[#52525b] text-xs">{relativeTime}</span>
                  {alert.alertType === 'latency_spike' && alert.currentValue != null && alert.baselineValue != null && (
                    <span className="text-[#ffaa00] text-xs font-mono">{(alert.currentValue / 1000).toFixed(1)}s vs baseline {(alert.baselineValue / 1000).toFixed(1)}s</span>
                  )}
                  {alert.alertType === 'coordinated_failure' && alert.currentValue != null && alert.baselineValue != null && (
                    <span className="text-[#ff4444] text-xs font-mono">{(alert.currentValue * 100).toFixed(1)}% failure vs baseline {(alert.baselineValue * 100).toFixed(1)}%</span>
                  )}
                </div>

                <div className="text-[#52525b] text-xs mt-2">{absoluteTime}</div>
              </div>

              {!alert.resolved && (
                <div className="flex-shrink-0 self-center">
                  {confirmingId !== alert.id ? (
                    <button
                      className="border border-[#1a1a24] text-[#a1a1aa] hover:text-white hover:border-[#2a2a34] rounded-lg text-sm px-3 py-1.5"
                      onClick={() => setConfirmingId(alert.id)}
                    >
                      Resolve
                    </button>
                  ) : (
                    <div className="flex items-center gap-2">
                      <button className="text-[#52525b] text-xs" onClick={() => setConfirmingId(null)}>Cancel</button>
                      <button
                        className="border border-[#ffaa00] text-[#ffaa00] rounded-lg text-sm px-3 py-1.5 min-w-[90px]"
                        onClick={() => onResolve(alert.id)}
                        disabled={resolvingId === alert.id}
                      >
                        {resolvingId === alert.id ? '...' : 'Confirm?'}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </article>
              );
            })()
          ))}
        </section>
      )}

    </div>
  );
}
