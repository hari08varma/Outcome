/**
 * LayerInfinite API — routes/model-history.ts
 * ══════════════════════════════════════════════════════════════
 * Admin routes for model version history, rollback, and pinning.
 *
 * GET    /v1/admin/model-history          — list versions
 * GET    /v1/admin/model-history/:v1/:v2  — diff two versions
 * POST   /v1/admin/model-history/rollback — rollback to a version
 * POST   /v1/admin/model-history/pin      — pin task_type to version
 * DELETE /v1/admin/model-history/pin      — remove a pin
 * ══════════════════════════════════════════════════════════════
 */

import { Hono } from 'hono';
import { z } from 'zod';
import {
  listModelVersions,
  getActiveVersion,
  rollbackModel,
  diffVersions,
  pinModelVersion,
  unpinModelVersion,
  listPins,
} from '../lib/model-versioning.js';

export const modelHistoryRouter = new Hono();

// ── GET / — list versions ─────────────────────────────────────

modelHistoryRouter.get('/', async (c) => {
  const customerId = c.get('customer_id') as string | undefined;
  if (!customerId) {
    return c.json({ error: 'Authentication required', code: 'UNAUTHORIZED' }, 401);
  }

  const limit = Math.min(100, Math.max(1, Number(c.req.query('limit')) || 20));

  try {
    const versions = await listModelVersions(customerId, limit);
    const active = await getActiveVersion(customerId);
    const pins = await listPins(customerId);

    return c.json({
      customer_id: customerId,
      active_version: active?.version ?? null,
      version_count: versions.length,
      pins: pins.map((p) => ({
        task_type: p.task_type,
        pinned_version: p.pinned_version,
        pinned_at: p.pinned_at,
      })),
      versions: versions.map((v) => ({
        version: v.version,
        trained_at: v.trained_at,
        training_episodes: v.training_episodes,
        is_active: v.is_active,
        is_canary: v.is_canary,
        canary_traffic_pct: v.canary_traffic_pct,
        tier: v.tier,
      })),
    }, 200);
  } catch (err: any) {
    return c.json({ error: 'Failed to list versions', details: err.message, code: 'LIST_ERROR' }, 500);
  }
});

// ── GET /:fromVersion/:toVersion — diff ────────────────────────

modelHistoryRouter.get('/:fromVersion/:toVersion', async (c) => {
  const customerId = c.get('customer_id') as string | undefined;
  if (!customerId) {
    return c.json({ error: 'Authentication required', code: 'UNAUTHORIZED' }, 401);
  }

  const fromVersion = Number(c.req.param('fromVersion'));
  const toVersion = Number(c.req.param('toVersion'));

  if (!Number.isFinite(fromVersion) || !Number.isFinite(toVersion)) {
    return c.json({ error: 'Version parameters must be integers', code: 'VALIDATION_ERROR' }, 400);
  }

  try {
    const diff = await diffVersions(customerId, fromVersion, toVersion);
    if (!diff) {
      return c.json({ error: 'Could not compute diff — one or both versions not found', code: 'NOT_FOUND' }, 404);
    }

    return c.json(diff, 200);
  } catch (err: any) {
    return c.json({ error: 'Failed to compute diff', details: err.message, code: 'DIFF_ERROR' }, 500);
  }
});

// ── POST /rollback — rollback to a version ─────────────────────

const RollbackBody = z.object({
  customer_id: z.string().min(1),
  target_version: z.number().int().positive(),
});

modelHistoryRouter.post('/rollback', async (c) => {
  let body: z.infer<typeof RollbackBody>;
  try {
    body = RollbackBody.parse(await c.req.json());
  } catch (err: any) {
    const details = err.errors
      ? err.errors.map((e: any) => `${e.path.join('.')}: ${e.message}`).join(', ')
      : err.message;
    return c.json({ error: 'Invalid request body', details, code: 'VALIDATION_ERROR' }, 400);
  }

  try {
    const result = await rollbackModel(body.customer_id, body.target_version);

    if (!result.success) {
      return c.json({
        success: false,
        previous_version: result.previousVersion,
        attempted_version: body.target_version,
        error: result.error,
        code: 'ROLLBACK_FAILED',
      }, 400);
    }

    return c.json({
      success: true,
      previous_version: result.previousVersion,
      new_version: result.newVersion,
      message: `Rolled back from v${result.previousVersion} to v${result.newVersion}`,
    }, 200);
  } catch (err: any) {
    return c.json({ error: 'Rollback failed', details: err.message, code: 'ROLLBACK_ERROR' }, 500);
  }
});

// ── POST /pin — pin task_type to version ───────────────────────

const PinBody = z.object({
  customer_id: z.string().min(1),
  task_type: z.string().min(1).max(255),
  version: z.number().int().positive(),
  pinned_by: z.string().optional(),
});

modelHistoryRouter.post('/pin', async (c) => {
  let body: z.infer<typeof PinBody>;
  try {
    body = PinBody.parse(await c.req.json());
  } catch (err: any) {
    const details = err.errors
      ? err.errors.map((e: any) => `${e.path.join('.')}: ${e.message}`).join(', ')
      : err.message;
    return c.json({ error: 'Invalid request body', details, code: 'VALIDATION_ERROR' }, 400);
  }

  try {
    const pin = await pinModelVersion(body.customer_id, body.task_type, body.version, body.pinned_by);

    return c.json({
      pinned: true,
      task_type: pin.task_type,
      pinned_version: pin.pinned_version,
      pinned_at: pin.pinned_at,
      message: `Pinned "${body.task_type}" to v${body.version}`,
    }, 200);
  } catch (err: any) {
    return c.json({ error: 'Pin failed', details: err.message, code: 'PIN_ERROR' }, 500);
  }
});

// ── DELETE /pin — remove pin ───────────────────────────────────

const UnpinBody = z.object({
  customer_id: z.string().min(1),
  task_type: z.string().min(1).max(255),
});

modelHistoryRouter.delete('/pin', async (c) => {
  let body: z.infer<typeof UnpinBody>;
  try {
    body = UnpinBody.parse(await c.req.json());
  } catch (err: any) {
    const details = err.errors
      ? err.errors.map((e: any) => `${e.path.join('.')}: ${e.message}`).join(', ')
      : err.message;
    return c.json({ error: 'Invalid request body', details, code: 'VALIDATION_ERROR' }, 400);
  }

  try {
    const unpinned = await unpinModelVersion(body.customer_id, body.task_type);

    return c.json({
      unpinned,
      task_type: body.task_type,
      message: unpinned
        ? `Unpinned "${body.task_type}"`
        : `No pin found for "${body.task_type}"`,
    }, 200);
  } catch (err: any) {
    return c.json({ error: 'Unpin failed', details: err.message, code: 'UNPIN_ERROR' }, 500);
  }
});
