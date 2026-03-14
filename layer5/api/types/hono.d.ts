/**
 * Layer5 — Hono Context Variables Type Declaration
 * Extends Hono's context to include our custom variables
 * set by the auth middleware.
 */

import 'hono';

declare module 'hono' {
    interface ContextVariableMap {
        agent_id: string;
        customer_id: string;
        agent_name: string;
        customer_tier: string;
        user_id: string;
        validated_action: {
            action_id: string;
            action_name: string;
            action_category: string;
        };
        parsed_body: Record<string, unknown>;
    }
}
