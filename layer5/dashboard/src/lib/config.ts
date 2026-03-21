const raw = import.meta.env.VITE_LAYERINFINITE_API_URL as
  string | undefined

export const API_BASE = raw
  ? raw.replace(/\/$/, '')  // strip trailing slash
  : null

export const isApiConfigured = !!API_BASE

function validateApiBase(url: string | null): void {
  if (!url) {
    console.error(
      '[Layerinfinite] CRITICAL: VITE_LAYERINFINITE_API_URL is not set.\n' +
      'The dashboard cannot communicate with the API.\n' +
      'Set this variable in your deployment environment:\n' +
      '  VITE_LAYERINFINITE_API_URL=https://your-railway-url.up.railway.app\n' +
      'Then redeploy. The dashboard will show empty data until this is fixed.'
    );
    return;
  }

  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      console.error(
        `[Layerinfinite] CRITICAL: VITE_LAYERINFINITE_API_URL has an invalid protocol: "${parsed.protocol}". ` +
        'Only http:// or https:// are supported.'
      );
    }
  } catch {
    console.error(
      `[Layerinfinite] CRITICAL: VITE_LAYERINFINITE_API_URL is not a valid URL: "${url}". ` +
      'Example: https://your-railway-url.up.railway.app'
    );
  }
}

export function getApiBase(): string {
  if (!API_BASE) {
    throw new Error(
      'VITE_LAYERINFINITE_API_URL is not configured. ' +
      'Set it in your deployment environment and redeploy.'
    );
  }
  return API_BASE;
}

validateApiBase(API_BASE);
if (import.meta.env.DEV && API_BASE) {
  console.log('[Layerinfinite] API_BASE:', API_BASE);
}
