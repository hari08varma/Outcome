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
const MAX_TASK_NAME_LENGTH = 64;
const GENERIC_TASK_NAME = 'unspecified_issue';
const GENERIC_PLACEHOLDER_TOKENS = new Set([
  'unknown',
  'unknown_task',
  'unspecified',
  'unspecified_issue',
  'n_a',
  'na',
  'none',
  'null',
  'undefined',
]);

function stableTaskHash(raw: string): string {
  // Deterministic short hash so unparseable labels still map to a stable task bucket.
  let hash = 2166136261;
  const input = raw.trim().toLowerCase();
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).padStart(7, '0').slice(0, 10);
}

function normalizeTaskToken(raw: string): string {
  return raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[\s\-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function fallbackTaskName(raw: string): string {
  return `task_${stableTaskHash(raw)}`;
}

function buildTaskCandidate(raw: string): string {
  const normalized = normalizeTaskToken(raw);
  if (!normalized) return '';

  const prefixed = /^[a-z]/.test(normalized)
    ? normalized
    : `task_${normalized}`;

  return prefixed
    .slice(0, MAX_TASK_NAME_LENGTH)
    .replace(/^_+|_+$/g, '')
    .replace(/_+$/g, '');
}

export function validateTaskName(raw: string | null | undefined): string {
  if (!raw) return 'unknown_task';
  if (raw.trim() === '') return 'unknown_task';

  const candidate = buildTaskCandidate(raw);
  if (!candidate) return fallbackTaskName(raw);

  if (GENERIC_PLACEHOLDER_TOKENS.has(candidate)) {
    return GENERIC_TASK_NAME;
  }

  if (!VALID_TASK_PATTERN.test(candidate)) {
    return fallbackTaskName(raw);
  }

  return candidate;
}

export function isGenericTaskName(taskName: string | null | undefined): boolean {
  if (!taskName) return false;
  const normalized = validateTaskName(taskName);
  return normalized === 'unknown_task' || normalized === GENERIC_TASK_NAME;
}

/**
 * Confidence tiers for issue_type → task_name mapping.
 *
 * DEVELOPER_PROVIDED (1.0): Developer explicitly set task_name — authoritative.
 * EXACT_MATCH        (0.90): issue_type found verbatim in ISSUE_TYPE_TO_TASK table.
 * PREFIX_MATCH       (0.70): issue_type shares a known prefix — plausible but inferred.
 * SLUGIFIED_FALLBACK (0.50): No known mapping; issue_type used directly after slugify.
 * UNKNOWN            (0.30): issue_type was blank.
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
 *   4. Blank issue_type → 'unknown_task', confidence 0.30
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

  const normalized = normalizeTaskToken(issueType);
  if (!normalized) {
    return {
      task: fallbackTaskName(issueType),
      confidence: TASK_MAPPING_CONFIDENCE.slugified_fallback,
      tier: 'slugified_fallback',
    };
  }

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
    if (prefix && (normalized === prefix || normalized.startsWith(`${prefix}_`))) {
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
