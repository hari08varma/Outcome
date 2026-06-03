/**
 * LayerInfinite API — webhook-verifier.ts
 * ══════════════════════════════════════════════════════════════
 * Business webhook verification: HMAC-SHA256 signatures,
 * timestamp validation, per-customer secrets, rate limiting.
 * ══════════════════════════════════════════════════════════════
 */

import crypto from 'node:crypto';
import { supabase } from './supabase.js';

// ── Constants ────────────────────────────────────────────────

const MAX_TIMESTAMP_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX_PER_WINDOW = 100; // 100 requests per minute per customer

// ── In-memory rate limiter ───────────────────────────────────

interface RateLimitBucket {
  count: number;
  windowStart: number;
}

const rateLimitBuckets = new Map<string, RateLimitBucket>();

// Periodic cleanup of stale buckets (every 5 minutes)
setInterval(() => {
  const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS;
  for (const [key, bucket] of rateLimitBuckets) {
    if (bucket.windowStart < cutoff) {
      rateLimitBuckets.delete(key);
    }
  }
}, 5 * 60 * 1000).unref();

// ── Public API ───────────────────────────────────────────────

/**
 * Verify HMAC-SHA256 signature on a webhook request body.
 *
 * The client signs the raw body with their per-customer webhook secret
 * and sends the signature in the X-LI-Webhook-Signature header.
 * Format: t={unix_timestamp},v1={hex_hmac_sha256}
 */
export async function verifyBusinessWebhook(
  rawBody: string,
  signatureHeader: string | undefined,
  customerId: string,
): Promise<boolean> {
  if (!signatureHeader || !customerId) return false;

  // Parse signature header: t={ts},v1={sig}
  let timestamp: number | null = null;
  const v1Candidates: string[] = [];

  for (const part of signatureHeader.split(',')) {
    const [key, value] = part.trim().split('=', 2);
    if (!key || !value) continue;

    if (key === 't') {
      const parsed = Number(value);
      timestamp = Number.isFinite(parsed) ? parsed : null;
    }
    if (key === 'v1') {
      v1Candidates.push(value.toLowerCase());
    }
  }

  if (timestamp === null || v1Candidates.length === 0) return false;

  // Validate timestamp
  if (!isTimestampValid(timestamp)) return false;

  // Fetch customer's webhook secret
  const secret = await getCustomerWebhookSecret(customerId);
  if (!secret) return false;

  // Compute expected signature
  const signedPayload = `${timestamp}.${rawBody}`;
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(signedPayload)
    .digest('hex')
    .toLowerCase();

  // Constant-time comparison against all v1 candidates
  for (const candidate of v1Candidates) {
    if (timingSafeEqual(expectedSignature, candidate)) {
      return true;
    }
  }

  return false;
}

/**
 * Validate that a webhook timestamp is not too old (>24h) or in the future.
 */
export function isTimestampValid(unixSeconds: number, maxAgeMs = MAX_TIMESTAMP_AGE_MS): boolean {
  const nowMs = Date.now();
  const tsMs = unixSeconds * 1000;

  // Reject future timestamps (with 30s clock skew tolerance)
  if (tsMs > nowMs + 30_000) return false;

  // Reject timestamps older than maxAgeMs
  if (nowMs - tsMs > maxAgeMs) return false;

  return true;
}

/**
 * Check rate limit for a customer. Returns true if allowed, false if exceeded.
 * 100 requests per minute per customer (sliding window).
 */
export function checkRateLimit(customerId: string): boolean {
  const now = Date.now();
  const key = `customer:${customerId}`;
  const bucket = rateLimitBuckets.get(key);

  if (!bucket || now - bucket.windowStart >= RATE_LIMIT_WINDOW_MS) {
    // New window
    rateLimitBuckets.set(key, { count: 1, windowStart: now });
    return true;
  }

  if (bucket.count >= RATE_LIMIT_MAX_PER_WINDOW) {
    return false;
  }

  bucket.count++;
  return true;
}

// ── Private ──────────────────────────────────────────────────

/**
 * Fetch the customer's webhook secret from dim_customers.config.webhook_secret.
 * Returns null if no secret is configured.
 */
async function getCustomerWebhookSecret(customerId: string): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from('dim_customers')
      .select('config')
      .eq('customer_id', customerId)
      .maybeSingle();

    if (error || !data?.config) return null;

    const config = data.config as Record<string, unknown>;
    const secret = config.webhook_secret;

    if (typeof secret !== 'string' || secret.length < 16) return null;

    return secret;
  } catch {
    // DB access failure — reject verification (secure by default)
    return null;
  }
}

/**
 * Constant-time string comparison to prevent timing attacks.
 */
function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);

  if (bufA.length !== bufB.length) return false;

  return crypto.timingSafeEqual(bufA, bufB);
}
