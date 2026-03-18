const raw = import.meta.env.VITE_LAYERINFINITE_API_URL as
  string | undefined

export const API_BASE = raw
  ? raw.replace(/\/$/, '')  // strip trailing slash
  : null

export const isApiConfigured = !!API_BASE

if (import.meta.env.DEV) {
  if (!API_BASE) {
    console.warn(
      '[Layerinfinite] VITE_LAYERINFINITE_API_URL is not set.\n' +
      'Add it to .env.local:\n' +
      'VITE_LAYERINFINITE_API_URL=https://your-railway-url.up.railway.app'
    )
  } else {
    console.log('[Layerinfinite] API_BASE:', API_BASE)
  }
}
