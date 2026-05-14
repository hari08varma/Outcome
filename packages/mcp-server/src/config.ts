/**
 * LayerInfinite MCP Server — config.ts
 * ══════════════════════════════════════════════════════════════
 * Single source of truth for all environment configuration.
 * Validates required vars at startup and exports a frozen config object.
 * ══════════════════════════════════════════════════════════════
 */

export type LIMode = 'recommend' | 'assist' | 'auto';

export interface LIConfig {
  /** API key for authenticating with the LayerInfinite REST API. */
  readonly apiKey: string;
  /** Base URL of the LayerInfinite API (no trailing slash). */
  readonly baseUrl: string;
  /** Operating mode. null = bootstrap (log only). */
  readonly mode: LIMode | null;
  /** Admin key for gated tools. null = admin tools disabled. */
  readonly adminKey: string | null;
}

const VALID_MODES: ReadonlySet<string> = new Set(['recommend', 'assist', 'auto']);

/**
 * Reads and validates environment variables.
 * Throws immediately if required vars are missing — fail fast at startup.
 */
export function loadConfig(): LIConfig {
  const apiKey = process.env.LAYERINFINITE_API_KEY;
  if (!apiKey || apiKey.trim() === '') {
    throw new Error(
      '[layerinfinite-mcp] LAYERINFINITE_API_KEY is required. ' +
      'Get your key from the LayerInfinite dashboard.',
    );
  }

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

  const config: LIConfig = Object.freeze({ apiKey, baseUrl, mode, adminKey });
  return config;
}
