/**
 * Layer5 TypeScript SDK — main export barrel.
 *
 * @example
 * ```ts
 * import { Layer5 } from '@layer5/sdk';
 *
 * const l5 = new Layer5({ apiKey: 'layer5_...' });
 * const scores = await l5.getScores({ agentId: 'bot' });
 * ```
 */

// Client
export { Layer5 } from './client.js';

// Errors
export {
  Layer5Error,
  Layer5AuthError,
  Layer5RateLimitError,
  Layer5ValidationError,
  Layer5NetworkError,
  Layer5TimeoutError,
  Layer5ServerError,
  Layer5UnknownActionError,
  Layer5AgentSuspendedError,
} from './errors.js';

// Types
export type {
  BusinessOutcome,
  FeedbackSignal,
  PolicyDecision,
  TrendLabel,
  ActionRecommendation,
  RankedAction,
  PolicyResult,
  ContextWarning,
  AgentTrust,
  NextActions,
  GetScoresOptions,
  GetScoresResponse,
  LogOutcomeOptions,
  LogOutcomeResponse,
  OutcomeFeedbackOptions,
  OutcomeFeedbackResponse,
  Layer5ClientOptions,
  SequencePrediction,
  SimulateResponse,
  SimulateOptions,
} from './types.js';

// Retry utilities
export { exponentialBackoff, sleep } from './retry.js';
