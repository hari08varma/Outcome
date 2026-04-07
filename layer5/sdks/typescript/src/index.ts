// Layerinfinite SDK — index.ts
// Public barrel export. v0.3.0 — clean rewrite, zero legacy imports.

// ── Primary class ────────────────────────────────────────────────
export { Layerinfinite } from './client.js';

// ── Backward compatibility alias ─────────────────────────────────
export { LayerinfiniteClient } from './client.js';

// ── All types ────────────────────────────────────────────────────
export type {
    LayerinfiniteConfig,
    ActionFunction,
    WrappedActionFunction,
    ActionEntry,
    Suggestion,
    RankedAction,
    Recommendation,
    ObservationSummary,
    GetScoresResponse,
    ScoredAction,
    LogOutcomeRequest,
    LogOutcomeResponse,
    PendingProviderHint,
    PendingSignalRequest,
    PendingSignalResponse,
    OutcomeFeedbackRequest,
    OutcomeFeedbackResponse,
    DiscrepancyDetectResponse,
    DiscrepancySummaryResponse,
    DiscrepancyDriftOptions,
    DiscrepancyDriftSnapshot,
    DelayedSignalMetadata,
} from './types.js';

// ── All error classes ────────────────────────────────────────────
export {
    LayerinfiniteError,
    LayerinfiniteAuthError,
    LayerinfiniteNotFoundError,
    LayerinfiniteRateLimitError,
    LayerinfiniteServerError,
    LowConfidenceError,
} from './errors.js';