/**
 * LayerInfinite MCP Server — logger.ts
 * ══════════════════════════════════════════════════════════════
 * Structured JSON logger to stderr (stdout is reserved for MCP
 * protocol messages over stdio transport).
 *
 * Production-grade: every log line is a JSON object with timestamp,
 * level, tool name, and structured data. Parseable by any log
 * aggregator (Datadog, Grafana Loki, CloudWatch, etc).
 * ══════════════════════════════════════════════════════════════
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const MIN_LEVEL: LogLevel = (process.env.LAYERINFINITE_LOG_LEVEL as LogLevel) ?? 'info';

export interface LogEntry {
  ts: string;
  level: LogLevel;
  tool?: string;
  msg: string;
  [key: string]: unknown;
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[MIN_LEVEL];
}

function emit(entry: LogEntry): void {
  if (!shouldLog(entry.level)) return;
  process.stderr.write(JSON.stringify(entry) + '\n');
}

export const logger = {
  debug(msg: string, data?: Record<string, unknown>) {
    emit({ ts: new Date().toISOString(), level: 'debug', msg, ...data });
  },
  info(msg: string, data?: Record<string, unknown>) {
    emit({ ts: new Date().toISOString(), level: 'info', msg, ...data });
  },
  warn(msg: string, data?: Record<string, unknown>) {
    emit({ ts: new Date().toISOString(), level: 'warn', msg, ...data });
  },
  error(msg: string, data?: Record<string, unknown>) {
    emit({ ts: new Date().toISOString(), level: 'error', msg, ...data });
  },

  /** Scoped logger that includes tool name in every log line. */
  forTool(toolName: string) {
    return {
      debug: (msg: string, data?: Record<string, unknown>) =>
        emit({ ts: new Date().toISOString(), level: 'debug', tool: toolName, msg, ...data }),
      info: (msg: string, data?: Record<string, unknown>) =>
        emit({ ts: new Date().toISOString(), level: 'info', tool: toolName, msg, ...data }),
      warn: (msg: string, data?: Record<string, unknown>) =>
        emit({ ts: new Date().toISOString(), level: 'warn', tool: toolName, msg, ...data }),
      error: (msg: string, data?: Record<string, unknown>) =>
        emit({ ts: new Date().toISOString(), level: 'error', tool: toolName, msg, ...data }),
    };
  },
};
