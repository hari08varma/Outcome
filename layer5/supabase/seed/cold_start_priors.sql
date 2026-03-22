-- ============================================================
-- LAYERINFINITE — Seed: Cold Start Priors
-- ============================================================
-- Industry-average synthetic priors injected during cold start.
-- These provide initial score distributions before real
-- outcome data is collected.
--
-- IMPORTANT: All rows have is_synthetic = TRUE.
-- The mv_action_scores view filters WHERE is_synthetic = FALSE,
-- so these priors do NOT inflate real scores.
-- They are used ONLY by the cold-start-bootstrap function
-- for prior injection (Stage 1).
-- ============================================================

-- ────────────────────────────────────────────
-- Seed: Default Customers (for testing only)
-- ────────────────────────────────────────────
INSERT INTO dim_customers (customer_id, company_name, industry, tier, config) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'Layerinfinite Demo Company', 'SaaS', 'enterprise', 
   '{"role": "customer_admin", "risk_tolerance": "balanced", "min_confidence": 0.5, "escalation_score": 0.2, "exploration_rate": 0.05}')
ON CONFLICT DO NOTHING;

-- ────────────────────────────────────────────
-- Seed: Default Actions
-- These are the initial action registry entries.
-- Real customers will add their own via the API.
-- ────────────────────────────────────────────
INSERT INTO dim_actions (action_id, action_name, action_category, action_description, required_params) VALUES
  ('b0000000-0000-0000-0000-000000000001', 'restart_service',  'recovery',    'Restart the affected service',        '{"service_name": "string"}'),
  ('b0000000-0000-0000-0000-000000000002', 'clear_cache',      'recovery',    'Clear application cache',             '{}'),
  ('b0000000-0000-0000-0000-000000000003', 'update_app',       'recovery',    'Update the application to latest version', '{}'),
  ('b0000000-0000-0000-0000-000000000004', 'escalate_human',   'escalation',  'Escalate to human support agent',     '{"reason": "string"}'),
  ('b0000000-0000-0000-0000-000000000005', 'retry_transaction','recovery',    'Retry the failed transaction',        '{"transaction_id": "string"}'),
  ('b0000000-0000-0000-0000-000000000006', 'switch_provider',  'recovery',    'Switch to backup payment provider',   '{"provider": "string"}'),
  ('b0000000-0000-0000-0000-000000000007', 'verify_credentials','automation', 'Re-verify user credentials',          '{}'),
  ('b0000000-0000-0000-0000-000000000008', 'send_notification','automation',  'Send notification to user',           '{"message": "string", "channel": "string"}')
ON CONFLICT (action_id) DO NOTHING;

-- ────────────────────────────────────────────
-- Seed: Default Contexts
-- ────────────────────────────────────────────
INSERT INTO dim_contexts (context_id, issue_type, environment, customer_tier) VALUES
  ('c0000000-0000-0000-0000-000000000001', 'payment_failed',   'production',  'enterprise'),
  ('c0000000-0000-0000-0000-000000000002', 'timeout',          'production',  'enterprise'),
  ('c0000000-0000-0000-0000-000000000003', 'auth_error',       'production',  'pro'),
  ('c0000000-0000-0000-0000-000000000004', 'service_down',     'production',  'enterprise'),
  ('c0000000-0000-0000-0000-000000000005', 'data_sync_failure','production',  'pro')
ON CONFLICT DO NOTHING;

-- ────────────────────────────────────────────
-- Seed: Default Agent (for testing)
-- ────────────────────────────────────────────
INSERT INTO dim_agents (agent_id, agent_name, agent_type, llm_model, customer_id) VALUES
  ('d0000000-0000-0000-0000-000000000001', 'payment-bot-1', 'payment', 'gpt-4', 'a0000000-0000-0000-0000-000000000001')
ON CONFLICT (agent_id) DO NOTHING;

-- ────────────────────────────────────────────
-- Seed: Institutional Knowledge (Industry Averages)
-- Used for cold start prior injection.
-- ────────────────────────────────────────────
INSERT INTO dim_institutional_knowledge (action_id, context_type, industry, avg_success_rate, sample_count) VALUES
  ('b0000000-0000-0000-0000-000000000001', 'payment_failed',   'SaaS',     0.41, 100),  -- restart_service  (disruptive)
  ('b0000000-0000-0000-0000-000000000002', 'payment_failed',   'SaaS',     0.65, 100),  -- clear_cache      (good auto)
  ('b0000000-0000-0000-0000-000000000003', 'payment_failed',   'SaaS',     0.72, 100),  -- update_app       (best auto)
  ('b0000000-0000-0000-0000-000000000004', 'payment_failed',   'SaaS',     0.25, 100),  -- escalate_human   (LAST RESORT)
  ('b0000000-0000-0000-0000-000000000005', 'payment_failed',   'SaaS',     0.58, 100),  -- retry_transaction (moderate)
  ('b0000000-0000-0000-0000-000000000006', 'payment_failed',   'SaaS',     0.54, 100),  -- switch_provider  (moderate)
  ('b0000000-0000-0000-0000-000000000001', 'timeout',          'SaaS',     0.50, 80),   -- restart_service
  ('b0000000-0000-0000-0000-000000000002', 'timeout',          'SaaS',     0.60, 80),   -- clear_cache
  ('b0000000-0000-0000-0000-000000000003', 'timeout',          'SaaS',     0.40, 80),   -- update_app
  ('b0000000-0000-0000-0000-000000000001', 'auth_error',       'SaaS',     0.20, 60),   -- restart_service
  ('b0000000-0000-0000-0000-000000000007', 'auth_error',       'SaaS',     0.75, 60),   -- verify_credentials
  ('b0000000-0000-0000-0000-000000000004', 'auth_error',       'SaaS',     0.30, 60);   -- escalate_human (last resort)
