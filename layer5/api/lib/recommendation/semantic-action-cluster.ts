interface SemanticActionClusterParams {
    actionName: string;
    issueType: string;
    taskName?: string | null;
}

export interface SemanticActionClusterResult {
    clusterKey: string;
    domain: string;
    intent: string;
    confidence: number;
    matchedTokens: string[];
}

const STOPWORDS = new Set([
    'the', 'and', 'for', 'with', 'from', 'into', 'onto', 'this', 'that', 'then',
    'agent', 'action', 'task', 'flow', 'step', 'do', 'run', 'exec', 'execute',
]);

const TOKEN_ALIASES: Record<string, string> = {
    refunds: 'refund',
    refunding: 'refund',
    reimbursement: 'refund',
    reimburse: 'refund',
    chargeback: 'refund',
    retries: 'retry',
    retrying: 'retry',
    backoff: 'retry',
    reattempt: 'retry',
    requeue: 'retry',
    reboot: 'restart',
    redeploy: 'restart',
    rerun: 'restart',
    escalation: 'escalate',
    handoff: 'escalate',
    ticketing: 'ticket',
    tickets: 'ticket',
    notify: 'notification',
    notifier: 'notification',
    email: 'notification',
    sms: 'notification',
    alert: 'notification',
    cacheing: 'cache',
    invalidate: 'cache',
    flush: 'cache',
    signin: 'login',
    authenticate: 'auth',
    authentication: 'auth',
    password: 'auth',
    upgrade: 'update',
    patch: 'update',
    provisioning: 'provision',
    setup: 'provision',
};

const INTENT_TOKENS: Record<string, string[]> = {
    refund: ['refund', 'payment', 'charge', 'invoice', 'subscription'],
    retry: ['retry', 'backoff', 'reattempt', 'requeue'],
    restart: ['restart', 'reboot', 'redeploy', 'rerun'],
    escalate: ['escalate', 'ticket', 'handoff', 'support'],
    notification: ['notification', 'email', 'sms', 'webhook', 'alert'],
    auth: ['auth', 'login', 'token', 'password', 'access'],
    cache: ['cache', 'invalidate', 'flush'],
    update: ['update', 'upgrade', 'patch', 'sync'],
    cancel: ['cancel', 'terminate', 'stop'],
    provision: ['provision', 'setup', 'create', 'onboard'],
};

const DOMAIN_HINTS: Record<string, string> = {
    payment: 'payments',
    billing: 'payments',
    refund: 'payments',
    charge: 'payments',
    ticket: 'support',
    support: 'support',
    complaint: 'support',
    auth: 'auth',
    login: 'auth',
    password: 'auth',
    access: 'auth',
    order: 'operations',
    delivery: 'operations',
    shipment: 'operations',
    onboarding: 'onboarding',
    setup: 'onboarding',
    integration: 'onboarding',
    email: 'communication',
    notification: 'communication',
    webhook: 'communication',
};

function clamp01(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(1, value));
}

function normalizeToken(token: string): string {
    const cleaned = token
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, '');
    if (!cleaned) return '';
    return TOKEN_ALIASES[cleaned] ?? cleaned;
}

function tokenize(value: string): string[] {
    // CamelCase/PascalCase decomposition — MUST happen before toLowerCase().
    // processTicketRefundV2 → process Ticket Refund V2
    // XMLParser             → XML Parser
    const camelSplit = value
        .trim()
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');

    const raw = camelSplit
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .split(/\s+/)
        .filter(t => !/^(v\d+|\d+)$/.test(t))
        .map((token) => normalizeToken(token))
        .filter((token) => token.length > 0 && !STOPWORDS.has(token));

    return [...new Set(raw)];
}

function resolveIntent(tokens: string[]): {
    intent: string;
    matchedTokens: string[];
    confidenceBoost: number;
} {
    let bestIntent = 'general';
    let bestMatches: string[] = [];

    for (const [intent, keywords] of Object.entries(INTENT_TOKENS)) {
        const matches = keywords.filter((keyword) => tokens.includes(keyword));
        if (matches.length > bestMatches.length) {
            bestIntent = intent;
            bestMatches = matches;
        }
    }

    if (bestMatches.length > 0) {
        return {
            intent: bestIntent,
            matchedTokens: bestMatches,
            confidenceBoost: bestMatches.length >= 2 ? 0.35 : 0.30,
        };
    }

    return {
        intent: tokens[0] ?? 'general',
        matchedTokens: tokens[0] ? [tokens[0]] : [],
        confidenceBoost: tokens.length > 0 ? 0.18 : 0.05,
    };
}

function resolveDomain(taskName: string | null | undefined, issueType: string, tokens: string[]): {
    domain: string;
    confidenceBoost: number;
} {
    const taskTokens = tokenize(taskName ?? '');
    const issueTokens = tokenize(issueType);
    const candidates = [...taskTokens, ...issueTokens, ...tokens];

    for (const token of candidates) {
        const mapped = DOMAIN_HINTS[token];
        if (mapped) {
            return {
                domain: mapped,
                confidenceBoost: taskTokens.includes(token) ? 0.30 : 0.22,
            };
        }
    }

    if (taskTokens.length > 0) {
        return {
            domain: taskTokens[0] ?? 'general',
            confidenceBoost: 0.16,
        };
    }

    if (issueTokens.length > 0) {
        return {
            domain: issueTokens[0] ?? 'general',
            confidenceBoost: 0.12,
        };
    }

    return {
        domain: 'general',
        confidenceBoost: 0.05,
    };
}

export function inferSemanticActionCluster(params: SemanticActionClusterParams): SemanticActionClusterResult {
    const tokens = tokenize(params.actionName);
    const intent = resolveIntent(tokens);
    const domain = resolveDomain(params.taskName ?? null, params.issueType, tokens);

    let confidence = 0.35;
    confidence += intent.confidenceBoost;
    confidence += domain.confidenceBoost;

    if (intent.matchedTokens.length >= 2) {
        confidence += 0.05;
    }

    const clusterKey = `${domain.domain}__${intent.intent}`;

    return {
        clusterKey,
        domain: domain.domain,
        intent: intent.intent,
        confidence: Number(clamp01(confidence).toFixed(4)),
        matchedTokens: intent.matchedTokens,
    };
}
