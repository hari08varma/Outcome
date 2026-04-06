// ══════════════════════════════════════════════════════════════
// task-infer.ts
// Rule-based task name inference from issue_type.
//
// RULE (from v3 plan):
//   If developer provides task_name → ALWAYS use it (caller handles this)
//   Else → infer from issue_type using lookup table
//   Fallback → slugify issue_type (spaces to underscores, lowercase)
//
// This function is ONLY called when task_name is absent from request.
// It never overrides a developer-provided task_name.
// ══════════════════════════════════════════════════════════════

// Known issue_type → task_name mappings
// These cover the most common patterns seen across agent deployments.
// Add new mappings here as new issue types are discovered.
const ISSUE_TYPE_TO_TASK: Record<string, string> = {
  // Payment & billing
  'billing_dispute': 'payment_failed',
  'payment_failure': 'payment_failed',
  'payment_failed': 'payment_failed',
  'charge_failed': 'payment_failed',
  'refund_request': 'refund_processing',
  'refund_failed': 'refund_processing',
  'subscription_cancel': 'subscription_management',
  'subscription_failed': 'subscription_management',
  'invoice_dispute': 'payment_failed',

  // Support & escalation
  'ticket_open': 'ticket_resolution',
  'ticket_escalation': 'ticket_resolution',
  'support_request': 'ticket_resolution',
  'complaint': 'ticket_resolution',
  'angry_customer': 'ticket_resolution',

  // Auth & access
  'login_failed': 'auth_recovery',
  'account_locked': 'auth_recovery',
  'password_reset': 'auth_recovery',
  'access_denied': 'auth_recovery',

  // Order & fulfilment
  'order_failed': 'order_recovery',
  'delivery_failed': 'order_recovery',
  'order_cancelled': 'order_recovery',
  'item_missing': 'order_recovery',

  // Onboarding
  'onboarding_stuck': 'onboarding',
  'setup_failed': 'onboarding',
  'integration_failed': 'onboarding',
};

const VALID_TASK_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;

export function validateTaskName(raw: string | null | undefined): string {
  if (!raw) return 'unknown_task';
  // Normalize: lowercase, trim, replace spaces+hyphens with underscores
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[\s\-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .replace(/^_+|_+$/g, '');
  if (!normalized || !VALID_TASK_PATTERN.test(normalized)) return 'unknown_task';
  return normalized;
}

/**
 * Confidence tiers for issue_type → task_name mapping.
 *
 * DEVELOPER_PROVIDED (1.0): Developer explicitly set task_name — authoritative.
 * EXACT_MATCH        (0.90): issue_type found verbatim in ISSUE_TYPE_TO_TASK table.
 * PREFIX_MATCH       (0.70): issue_type shares a known prefix — plausible but inferred.
 * SLUGIFIED_FALLBACK (0.50): No known mapping; issue_type used directly after slugify.
 * UNKNOWN            (0.30): issue_type was blank or produced 'unknown_task'.
 */
export type TaskMappingTier =
  | 'developer_provided'
  | 'exact_match'
  | 'prefix_match'
  | 'slugified_fallback'
  | 'unknown';

export const TASK_MAPPING_CONFIDENCE: Record<TaskMappingTier, number> = {
  developer_provided: 1.00,
  exact_match:        0.90,
  prefix_match:       0.70,
  slugified_fallback: 0.50,
  unknown:            0.30,
};

export interface TaskInferResult {
  /** Resolved task name — always a non-empty string. */
  task: string;
  /**
   * Confidence that this task name is correct (0.0–1.0).
   * Store in fact_outcomes.mapping_confidence.
   * Scoring engine down-weights outcomes with low confidence.
   */
  confidence: number;
  /** Which resolution tier was used. */
  tier: TaskMappingTier;
}

/**
 * Infers a task_name from issue_type when the developer did not provide one.
 *
 * Priority:
 *   1. Exact match in ISSUE_TYPE_TO_TASK lookup  → confidence 0.90
 *   2. Prefix match (e.g. "payment_" → "payment_failed") → confidence 0.70
 *   3. Slugified issue_type (spaces/hyphens → underscores, lowercase) → confidence 0.50
 *   4. Unresolvable → 'unknown_task', confidence 0.30
 *
 * @param issueType - The issue_type field from the log_outcome request.
 * @returns TaskInferResult with task name, confidence, and tier.
 */
export function inferTask(issueType: string): TaskInferResult {
  if (!issueType || issueType.trim() === '') {
    return {
      task: 'unknown_task',
      confidence: TASK_MAPPING_CONFIDENCE.unknown,
      tier: 'unknown',
    };
  }

  const normalized = issueType.trim().toLowerCase();

  // 1. Exact match — highest confidence inferred mapping
  if (ISSUE_TYPE_TO_TASK[normalized]) {
    return {
      task: ISSUE_TYPE_TO_TASK[normalized]!,
      confidence: TASK_MAPPING_CONFIDENCE.exact_match,
      tier: 'exact_match',
    };
  }

  // 2. Prefix match — plausible but not certain
  for (const [key, value] of Object.entries(ISSUE_TYPE_TO_TASK)) {
    const prefix = key.split('_')[0];
    if (prefix && normalized.startsWith(prefix)) {
      return {
        task: value,
        confidence: TASK_MAPPING_CONFIDENCE.prefix_match,
        tier: 'prefix_match',
      };
    }
  }

  // 3. Slugified fallback — structural normalization only, no semantic claim
  const slugified = validateTaskName(normalized);
  if (slugified !== 'unknown_task') {
    return {
      task: slugified,
      confidence: TASK_MAPPING_CONFIDENCE.slugified_fallback,
      tier: 'slugified_fallback',
    };
  }

  // 4. Unresolvable
  return {
    task: 'unknown_task',
    confidence: TASK_MAPPING_CONFIDENCE.unknown,
    tier: 'unknown',
  };
}
