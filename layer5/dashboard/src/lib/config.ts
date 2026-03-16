/**
 * Dashboard config — single source of truth for environment variables.
 * Import API_BASE from here instead of redefining per-page.
 */

const _apiUrl = import.meta.env.VITE_LAYERINFINITE_API_URL
  ?? import.meta.env.VITE_API_URL;

const _isLocalhost =
  typeof window !== 'undefined' &&
  window.location.hostname === 'localhost';

/**
 * API_BASE is the base URL for the Layerinfinite API.
 *
 * - In development (localhost): falls back to http://localhost:3000
 * - In production: VITE_LAYERINFINITE_API_URL must be set in Vercel
 *   environment variables. If it is missing, API_BASE is null and
 *   pages will display a visible CONFIGURATION ERROR.
 */
export const API_BASE: string | null = _apiUrl
  ? _apiUrl
  : _isLocalhost
    ? 'http://localhost:3000'
    : null;

// Log a fatal error to the console in production so it appears in Vercel logs
if (!API_BASE && import.meta.env.PROD) {
  console.error(
    '[LAYERINFINITE] FATAL: VITE_LAYERINFINITE_API_URL is not set. ' +
    'Add it to your Vercel environment variables and redeploy.'
  );
}
