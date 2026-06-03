/**
 * LayerInfinite API — routes/business-webhook.ts
 * ══════════════════════════════════════════════════════════════
 * POST /v1/webhook/callback — Business outcome webhook endpoint.
 *
 * Receives Layer 2 (session) and Layer 3 (business) outcome signals
 * linked via decision_id. Validates HMAC signature, resolves the
 * original outcome, and orchestrates the 3-layer score overwrite.
 *
 * Idempotent: duplicate (decision_id + layer) → 200 (replayed).
 * ══════════════════════════════════════════════════════════════
 */

import { Context } from 'hono';
import { z } from 'zod';
import {
  verifyBusinessWebhook,
  isTimestampValid,
  checkRateLimit,
} from '../lib/webhook-verifier.js';
import { handleWebhookCallback } from '../lib/outcome-orchestrator.js';

// ── Request schema ───────────────────────────────────────────

const WebhookCallbackBody = z.object({
  decision_id: z.string().min(1).max(255),
  layer: z
    .number()
    .int()
    .refine((v) => v === 2 || v === 3, { message: 'layer must be 2 (session) or 3 (business)' }),
  success: z.boolean(),
  score: z
    .number()
    .min(0)
    .max(1)
    .default(0.5),
  reason: z.string().max(500).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  timestamp: z.string().datetime().optional(),
});

// ── POST /v1/webhook/callback ────────────────────────────────

export default async function businessWebhookRoute(c: Context): Promise<Response> {
  // ── 1. Rate limit ─────────────────────────────────────────
  const customerId = c.get('customer_id') as string | undefined;
  if (customerId && !checkRateLimit(customerId)) {
    return c.json(
      { error: 'Rate limit exceeded', code: 'RATE_LIMITED', retry_after_ms: 60_000 },
      429,
    );
  }

  // ── 2. Parse body ─────────────────────────────────────────
  let body: z.infer<typeof WebhookCallbackBody>;
  try {
    body = WebhookCallbackBody.parse(await c.req.json());
  } catch (err: any) {
    const details = err.errors
      ? err.errors.map((e: any) => `${e.path.join('.')}: ${e.message}`).join(', ')
      : err.message;
    return c.json({ error: 'Invalid request body', details, code: 'VALIDATION_ERROR' }, 400);
  }

  // ── 3. Verify webhook signature ───────────────────────────
  // HMAC verification is always enforced except when the explicit
  // LI_WEBHOOK_DEV_BYPASS flag is set (local development only).
  if (process.env.LI_WEBHOOK_DEV_BYPASS !== 'true') {
    const rawBody = JSON.stringify(body);
    const signatureHeader = c.req.header('X-LI-Webhook-Signature');

    if (!customerId) {
      return c.json({ error: 'Missing customer context', code: 'MISSING_CUSTOMER_ID' }, 401);
    }

    const verified = await verifyBusinessWebhook(rawBody, signatureHeader, customerId);
    if (!verified) {
      return c.json({ error: 'Invalid webhook signature', code: 'UNAUTHORIZED' }, 401);
    }
  }

  // ── 4. Validate timestamp (if provided in header) ─────────
  const headerTimestamp = c.req.header('X-LI-Webhook-Timestamp');
  if (headerTimestamp) {
    const ts = Number(headerTimestamp);
    if (Number.isFinite(ts) && !isTimestampValid(ts)) {
      return c.json(
        { error: 'Webhook timestamp expired (>24h old or in the future)', code: 'TIMESTAMP_EXPIRED' },
        400,
      );
    }
  }

  // ── 5. Process callback via orchestrator ──────────────────
  try {
    const result = await handleWebhookCallback({
      decisionId: body.decision_id,
      layer: body.layer as 2 | 3,
      success: body.success,
      score: body.score,
      reason: body.reason,
      metadata: body.metadata,
      timestamp: body.timestamp ?? new Date().toISOString(),
    });

    if (!result.resolved) {
      return c.json(
        {
          resolved: false,
          decision_id: body.decision_id,
          message: 'No outcome found for the given decision_id. The outcome may not have been logged yet.',
          code: 'DECISION_NOT_FOUND',
        },
        200,
      );
    }

    const statusCode = result.idempotent ? 200 : 202;

    return c.json(
      {
        resolved: true,
        outcome_id: result.outcomeId,
        decision_id: body.decision_id,
        layer: result.layer,
        previous_score: result.previousScore,
        new_score: result.newScore,
        idempotent_replay: result.idempotent,
        message: result.idempotent
          ? 'Webhook callback already processed (idempotent replay).'
          : 'Webhook callback accepted. Score overwrite applied.',
      },
      statusCode,
    );
  } catch (err: any) {
    console.error('[business-webhook] callback processing failed:', err.message);
    return c.json(
      { error: 'Failed to process webhook callback', details: err.message, code: 'PROCESSING_ERROR' },
      500,
    );
  }
}
