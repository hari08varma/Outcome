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
  'billing_dispute':         'payment_failed',
  'payment_failure':         'payment_failed',
  'payment_failed':          'payment_failed',
  'charge_failed':           'payment_failed',
  'refund_request':          'refund_processing',
  'refund_failed':           'refund_processing',
  'subscription_cancel':     'subscription_management',
  'subscription_failed':     'subscription_management',
  'invoice_dispute':         'payment_failed',

  // Support & escalation
  'ticket_open':             'ticket_resolution',
  'ticket_escalation':       'ticket_resolution',
  'support_request':         'ticket_resolution',
  'complaint':               'ticket_resolution',
  'angry_customer':          'ticket_resolution',

  // Auth & access
  'login_failed':            'auth_recovery',
  'account_locked':          'auth_recovery',
  'password_reset':          'auth_recovery',
  'access_denied':           'auth_recovery',

  // Order & fulfilment
  'order_failed':            'order_recovery',
  'delivery_failed':         'order_recovery',
  'order_cancelled':         'order_recovery',
  'item_missing':            'order_recovery',

  // Onboarding
  'onboarding_stuck':        'onboarding',
  'setup_failed':            'onboarding',
  'integration_failed':      'onboarding',
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
 * Infers a task_name from issue_type when the developer did not provide one.
 *
 * Priority:
 *   1. Exact match in ISSUE_TYPE_TO_TASK lookup
 *   2. Prefix match (e.g. "payment_" → "payment_failed")
 *   3. Slugified issue_type (spaces/hyphens → underscores, lowercase)
 *
 * @param issueType - The issue_type field from log_outcome request
 * @returns inferred task_name — always a non-empty string
 */
export function inferTask(issueType: string): string {
  if (!issueType || issueType.trim() === '') return 'unknown_task';

  const normalized = issueType.trim().toLowerCase();

  // 1. Exact match
  if (ISSUE_TYPE_TO_TASK[normalized]) {
    return ISSUE_TYPE_TO_TASK[normalized]!;
  }

  // 2. Prefix match — find any key that shares a prefix with normalized
  for (const [key, value] of Object.entries(ISSUE_TYPE_TO_TASK)) {
    const prefix = key.split('_')[0];
    if (prefix && normalized.startsWith(prefix)) {
      return value;
    }
  }

  // 3. Fallback: slugify issue_type and validate
  return validateTaskName(normalized);
}
