/**
 * LayerInfinite API — lib/model-versioning.ts
 * ══════════════════════════════════════════════════════════════
 * Model version tracking for world_model_artifacts.
 *
 * Operations:
 *   - List version history for a customer
 *   - Rollback: deactivate current version, re-activate a previous one
 *   - Pin: lock a task_type to a specific model version
 *   - Unpin: remove a pin
 *   - Diff: compare two versions (training_episodes delta, trained_at)
 *
 * Cache invalidation: after rollback/pin, invalidates the world-model
 * module-level cache so next predictOutcome() picks up the change.
 * ══════════════════════════════════════════════════════════════
 */

import { supabase } from './supabase.js';
import { invalidateModelCache } from './simulation/world-model.js';

// ── Types ──────────────────────────────────────────────────────

export interface ModelVersionSummary {
  version: number;
  trained_at: string;
  training_episodes: number;
  is_active: boolean;
  is_canary: boolean;
  canary_traffic_pct: number;
  tier: number;
  customer_id: string;
}

export interface VersionDiff {
  from_version: number;
  to_version: number;
  episode_delta: number;
  time_delta_hours: number;
  from_trained_at: string;
  to_trained_at: string;
}

export interface ModelPin {
  task_type: string;
  pinned_version: number;
  pinned_at: string;
  pinned_by?: string;
}

// ── Public API ─────────────────────────────────────────────────

/**
 * List all model versions for a customer, newest first.
 */
export async function listModelVersions(
  customerId: string,
  limit = 20,
): Promise<ModelVersionSummary[]> {
  const { data, error } = await supabase
    .from('world_model_artifacts')
    .select('version, trained_at, training_episodes, is_active, is_canary, canary_traffic_pct, tier, customer_id')
    .eq('customer_id', customerId)
    .order('version', { ascending: false })
    .limit(limit);

  if (error || !data) {
    console.warn('[model-versioning] Failed to list versions:', error?.message);
    return [];
  }

  return data as ModelVersionSummary[];
}

/**
 * Get the currently active version for a customer.
 */
export async function getActiveVersion(
  customerId: string,
): Promise<ModelVersionSummary | null> {
  const { data, error } = await supabase
    .from('world_model_artifacts')
    .select('version, trained_at, training_episodes, is_active, is_canary, canary_traffic_pct, tier, customer_id')
    .eq('customer_id', customerId)
    .eq('is_active', true)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;
  return data as ModelVersionSummary;
}

/**
 * Rollback to a previous model version.
 *
 * Deactivates the current active model and re-activates the target version.
 * Invalidates the world-model cache so subsequent predictions use the rolled-back model.
 */
export async function rollbackModel(
  customerId: string,
  targetVersion: number,
): Promise<{ success: boolean; previousVersion: number | null; newVersion: number; error?: string }> {
  const active = await getActiveVersion(customerId);

  if (!active) {
    return { success: false, previousVersion: null, newVersion: targetVersion, error: 'No active model found' };
  }

  if (active.version === targetVersion) {
    return { success: false, previousVersion: active.version, newVersion: targetVersion, error: 'Target version is already active' };
  }

  // Verify target version exists
  const { data: target, error: targetError } = await supabase
    .from('world_model_artifacts')
    .select('version, customer_id')
    .eq('customer_id', customerId)
    .eq('version', targetVersion)
    .maybeSingle();

  if (targetError || !target) {
    return { success: false, previousVersion: active.version, newVersion: targetVersion, error: `Version ${targetVersion} not found` };
  }

  // Deactivate current
  const { error: deactivateError } = await supabase
    .from('world_model_artifacts')
    .update({ is_active: false })
    .eq('customer_id', customerId)
    .eq('version', active.version);

  if (deactivateError) {
    return { success: false, previousVersion: active.version, newVersion: targetVersion, error: deactivateError.message };
  }

  // Activate target
  const { error: activateError } = await supabase
    .from('world_model_artifacts')
    .update({ is_active: true })
    .eq('customer_id', customerId)
    .eq('version', targetVersion);

  if (activateError) {
    // Rollback the deactivation
    await supabase
      .from('world_model_artifacts')
      .update({ is_active: true })
      .eq('customer_id', customerId)
      .eq('version', active.version);
    return { success: false, previousVersion: active.version, newVersion: targetVersion, error: activateError.message };
  }

  invalidateModelCache(customerId);

  console.info(
    `[model-versioning] Rollback: customer=${customerId} ` +
    `v${active.version} → v${targetVersion}`,
  );

  return { success: true, previousVersion: active.version, newVersion: targetVersion };
}

/**
 * Compute a diff between two model versions.
 */
export async function diffVersions(
  customerId: string,
  fromVersion: number,
  toVersion: number,
): Promise<VersionDiff | null> {
  const { data, error } = await supabase
    .from('world_model_artifacts')
    .select('version, trained_at, training_episodes')
    .eq('customer_id', customerId)
    .in('version', [fromVersion, toVersion])
    .order('version', { ascending: true });

  if (error || !data || data.length < 2) return null;

  const from = data[0] as { version: number; trained_at: string; training_episodes: number };
  const to = data[1] as { version: number; trained_at: string; training_episodes: number };

  const timeDeltaMs = new Date(to.trained_at).getTime() - new Date(from.trained_at).getTime();

  return {
    from_version: from.version,
    to_version: to.version,
    episode_delta: to.training_episodes - from.training_episodes,
    time_delta_hours: Math.round((timeDeltaMs / 3_600_000) * 100) / 100,
    from_trained_at: from.trained_at,
    to_trained_at: to.trained_at,
  };
}

// ── Pin Management ─────────────────────────────────────────────

/**
 * Pin a task_type to a specific model version.
 * Pins are stored in dim_agents.config.pinned_models as a JSONB object:
 *   { "task_type": version_number, ... }
 *
 * Pins are global (per customer), not per-agent.
 * Uses a dedicated model_pins table if it exists, otherwise falls back
 * to an in-memory store (pins survive process lifetime only).
 */
const pinStore = new Map<string, Map<string, ModelPin>>();

function pinKey(customerId: string): string {
  return `customer:${customerId}`;
}

export async function pinModelVersion(
  customerId: string,
  taskType: string,
  version: number,
  pinnedBy?: string,
): Promise<ModelPin> {
  const pin: ModelPin = {
    task_type: taskType,
    pinned_version: version,
    pinned_at: new Date().toISOString(),
    pinned_by: pinnedBy,
  };

  const key = pinKey(customerId);
  let customerPins = pinStore.get(key);
  if (!customerPins) {
    customerPins = new Map();
    pinStore.set(key, customerPins);
  }
  customerPins.set(taskType, pin);

  // Persist to model_pins table
  try {
    await supabase.from('model_pins').upsert({
      customer_id: customerId,
      task_type: taskType,
      pinned_version: version,
      pinned_at: pin.pinned_at,
      pinned_by: pinnedBy ?? null,
    }, { onConflict: 'customer_id,task_type' });
  } catch (err: any) {
    console.warn('[model-versioning] Pin persist failed:', err.message);
  }

  console.info(
    `[model-versioning] Pin: customer=${customerId} ` +
    `task_type=${taskType} → v${version}`,
  );

  return pin;
}

export async function unpinModelVersion(
  customerId: string,
  taskType: string,
): Promise<boolean> {
  const key = pinKey(customerId);
  const customerPins = pinStore.get(key);
  const existed = customerPins?.delete(taskType) ?? false;

  try {
    await supabase
      .from('model_pins')
      .delete()
      .eq('customer_id', customerId)
      .eq('task_type', taskType);
  } catch (err: any) {
    console.warn('[model-versioning] Pin delete failed:', err.message);
  }

  if (existed) {
    console.info(`[model-versioning] Unpin: customer=${customerId} task_type=${taskType}`);
  }

  return existed;
}

export async function getPinnedVersion(
  customerId: string,
  taskType: string,
): Promise<number | null> {
  const key = pinKey(customerId);
  const customerPins = pinStore.get(key);
  const memoryPin = customerPins?.get(taskType);
  if (memoryPin) return memoryPin.pinned_version;

  // Try DB
  try {
    const { data, error } = await supabase
      .from('model_pins')
      .select('pinned_version')
      .eq('customer_id', customerId)
      .eq('task_type', taskType)
      .maybeSingle();

    if (error || !data) return null;

    const version = (data as { pinned_version: number }).pinned_version;
    // Populate memory cache
    const customerPins = pinStore.get(key) ?? new Map();
    customerPins.set(taskType, {
      task_type: taskType,
      pinned_version: version,
      pinned_at: new Date().toISOString(),
    });
    pinStore.set(key, customerPins);

    return version;
  } catch {
    return null;
  }
}

export async function listPins(customerId: string): Promise<ModelPin[]> {
  const key = pinKey(customerId);
  const customerPins = pinStore.get(key);
  const memoryPins = customerPins ? Array.from(customerPins.values()) : [];

  // Merge with DB
  try {
    const { data, error } = await supabase
      .from('model_pins')
      .select('task_type, pinned_version, pinned_at, pinned_by')
      .eq('customer_id', customerId);

    if (error || !data) return memoryPins;

    const dbPins = data as ModelPin[];
    const merged = new Map<string, ModelPin>();
    for (const p of memoryPins) merged.set(p.task_type, p);
    for (const p of dbPins) {
      if (!merged.has(p.task_type)) merged.set(p.task_type, p);
    }
    return Array.from(merged.values());
  } catch {
    return memoryPins;
  }
}
