/**
 * LayerInfinite MCP Server — config.ts
 * ══════════════════════════════════════════════════════════════
 * V2 Gateway Configuration. Supports upstream MCP servers,
 * per-task-type mode overrides, shadow mode, and environment isolation.
 *
 * Backwards-compatible: all V1 env vars (LAYERINFINITE_API_KEY,
 * LAYERINFINITE_BASE_URL, LAYERINFINITE_MODE, LAYERINFINITE_ADMIN_KEY)
 * continue to work.
 * ══════════════════════════════════════════════════════════════
 */

export type LIMode = 'recommend' | 'assist' | 'auto';

export interface ClassifierConfig {
  enabled: boolean;
  apiKey: string | null;
  model: string;
  baseUrl: string;
  timeoutMs: number;
  cacheTtlMs: number;
}

export interface UpstreamServer {
  /** Human-readable name. Used as tool prefix (e.g. "github" → "github_push_fix"). */
  readonly name: string;
  /** MCP server URL (e.g., "https://github-mcp.example.com"). */
  readonly url: string;
  /** Optional per-upstream API key. Falls back to LAYERINFINITE_API_KEY if unset. */
  readonly apiKey?: string;
  /** Health check interval in ms. Default 30_000. */
  readonly healthCheckIntervalMs?: number;
}

export interface GatewayConfig {
  /** API key for authenticating with the LayerInfinite REST API. */
  readonly apiKey: string;
  /** Optional secondary API key for zero-downtime rotation. */
  readonly apiKeySecondary?: string;
  /** Base URL of the LayerInfinite API (no trailing slash). */
  readonly baseUrl: string;
  /** Global operating mode. null = bootstrap (observe only). */
  readonly mode: LIMode | null;
  /** Upstream MCP servers to proxy. */
  readonly upstreamServers: readonly UpstreamServer[];
  /** Per-task-type mode overrides. Key = task_type, value = mode. */
  readonly modeOverrides: ReadonlyMap<string, LIMode>;
  /** If true, LI observes and logs but does NOT inject enrichment. */
  readonly shadowMode: boolean;
  /** Deployment environment. Staging outcomes are isolated from production. */
  readonly environment: 'staging' | 'production';
  /** Admin key for gated operations. null = admin disabled. */
  readonly adminKey: string | null;
  /** Log level. Default derived from NODE_ENV. */
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** LLM outcome classifier config. null = classifier disabled. */
  readonly classifier: ClassifierConfig | null;
}

const VALID_MODES: ReadonlySet<string> = new Set(['recommend', 'assist', 'auto']);
const VALID_ENVIRONMENTS: ReadonlySet<string> = new Set(['staging', 'production']);

function parseUpstreamServers(raw: string): UpstreamServer[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error('LAYERINFINITE_UPSTREAM_TOOLS must be a JSON array');
    }
    return parsed.map((item: Record<string, unknown>, i: number) => {
      if (typeof item.name !== 'string' || item.name.trim() === '') {
        throw new Error(`Upstream server at index ${i}: "name" is required and must be a non-empty string`);
      }
      if (typeof item.url !== 'string' || item.url.trim() === '') {
        throw new Error(`Upstream server "${item.name}": "url" is required and must be a non-empty string`);
      }
      return {
        name: item.name.trim(),
        url: item.url.trim(),
        apiKey: typeof item.apiKey === 'string' ? item.apiKey : undefined,
        healthCheckIntervalMs: typeof item.healthCheckIntervalMs === 'number' ? item.healthCheckIntervalMs : undefined,
      };
    });
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(`LAYERINFINITE_UPSTREAM_TOOLS is not valid JSON: ${err.message}`);
    }
    throw err;
  }
}

function parseModeOverrides(raw: string): Map<string, LIMode> {
  if (!raw || raw.trim() === '' || raw.trim() === '{}') {
    return new Map();
  }
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('LAYERINFINITE_MODE_OVERRIDES must be a JSON object (e.g., {"build_failed":"auto"})');
    }
    const map = new Map<string, LIMode>();
    for (const [taskType, mode] of Object.entries(parsed)) {
      if (typeof mode !== 'string' || !VALID_MODES.has(mode)) {
        throw new Error(
          `LAYERINFINITE_MODE_OVERRIDES: invalid mode "${String(mode)}" for task "${taskType}". ` +
          `Valid values: recommend, assist, auto.`,
        );
      }
      map.set(taskType, mode as LIMode);
    }
    return map;
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(`LAYERINFINITE_MODE_OVERRIDES is not valid JSON: ${err.message}`);
    }
    throw err;
  }
}

/**
 * Reads and validates environment variables.
 * Throws immediately if required vars are missing — fail fast at startup.
 */
export function loadConfig(): GatewayConfig {
  // ── V1 backwards-compatible vars ──────────────────────────
  const apiKey = process.env.LAYERINFINITE_API_KEY;
  if (!apiKey || apiKey.trim() === '') {
    throw new Error(
      '[layerinfinite-mcp] LAYERINFINITE_API_KEY is required. ' +
      'Get your key from the LayerInfinite dashboard.',
    );
  }

  const apiKeySecondary = process.env.LAYERINFINITE_API_KEY_2?.trim() || undefined;

  const baseUrl = (process.env.LAYERINFINITE_BASE_URL ?? 'https://layerinfinite.me').replace(/\/+$/, '');

  const rawMode = (process.env.LAYERINFINITE_MODE ?? '').trim().toLowerCase();
  let mode: LIMode | null = null;
  if (rawMode !== '') {
    if (!VALID_MODES.has(rawMode)) {
      throw new Error(
        `[layerinfinite-mcp] Invalid LAYERINFINITE_MODE="${rawMode}". ` +
        `Valid values: recommend, assist, auto. Omit for bootstrap mode.`,
      );
    }
    mode = rawMode as LIMode;
  }

  const adminKey = process.env.LAYERINFINITE_ADMIN_KEY?.trim() || null;

  // ── V2 new vars ──────────────────────────────────────────
  const rawUpstream = (process.env.LAYERINFINITE_UPSTREAM_TOOLS ?? '[]').trim();
  const upstreamServers = parseUpstreamServers(rawUpstream);

  const rawOverrides = (process.env.LAYERINFINITE_MODE_OVERRIDES ?? '{}').trim();
  const modeOverrides = parseModeOverrides(rawOverrides);

  const shadowMode = (process.env.LAYERINFINITE_SHADOW_MODE ?? 'false').trim().toLowerCase() === 'true';

  const rawEnv = (process.env.LAYERINFINITE_ENVIRONMENT ?? 'production').trim().toLowerCase();
  if (!VALID_ENVIRONMENTS.has(rawEnv)) {
    throw new Error(
      `[layerinfinite-mcp] Invalid LAYERINFINITE_ENVIRONMENT="${rawEnv}". ` +
      `Valid values: staging, production.`,
    );
  }
  const environment = rawEnv as 'staging' | 'production';

  const logLevel = resolveLogLevel();

  // ── Classifier config ─────────────────────────────────────
  let classifier: ClassifierConfig | null = null;
  if ((process.env.LI_CLASSIFIER_ENABLED ?? '').toLowerCase() === 'true') {
    classifier = {
      enabled: true,
      apiKey: process.env.LI_CLASSIFIER_API_KEY ?? process.env.OPENAI_API_KEY ?? null,
      model: process.env.LI_CLASSIFIER_MODEL ?? 'gpt-4o-mini',
      baseUrl: (process.env.LI_CLASSIFIER_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/+$/, ''),
      timeoutMs: Number.parseInt(process.env.LI_CLASSIFIER_TIMEOUT_MS ?? '3000', 10) || 3000,
      cacheTtlMs: Number.parseInt(process.env.LI_CLASSIFIER_CACHE_TTL_MS ?? '300000', 10) || 300000,
    };
  }

  const config: GatewayConfig = Object.freeze({
    apiKey,
    apiKeySecondary,
    baseUrl,
    mode,
    upstreamServers,
    modeOverrides,
    shadowMode,
    environment,
    adminKey,
    logLevel,
    classifier,
  });

  return config;
}

function resolveLogLevel(): GatewayConfig['logLevel'] {
  const raw = (process.env.LAYERINFINITE_LOG_LEVEL ?? '').trim().toLowerCase();
  if (['debug', 'info', 'warn', 'error'].includes(raw)) {
    return raw as GatewayConfig['logLevel'];
  }
  // Derive from NODE_ENV
  if (process.env.NODE_ENV === 'production') return 'info';
  if (process.env.NODE_ENV === 'test') return 'error';
  return 'debug';
}
