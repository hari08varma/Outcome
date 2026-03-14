// Layer5 SDK — errors.ts
// Typed exception hierarchy for all Layer5 API failure modes.

export class Layer5Error extends Error {
    public readonly statusCode?: number;
    public readonly responseBody?: unknown;

    constructor(
        message: string,
        statusCode?: number,
        responseBody?: unknown,
    ) {
        super(message);
        this.name = 'Layer5Error';
        this.statusCode = statusCode;
        this.responseBody = responseBody;
        // Correct instanceof behavior in transpiled code
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

/** Raised on HTTP 401 — invalid or missing API key. */
export class Layer5AuthError extends Layer5Error {
    override name = 'Layer5AuthError';
    constructor(message: string, responseBody?: unknown) {
        super(message, 401, responseBody);
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

/** Raised on HTTP 429 — rate limit exceeded. */
export class Layer5RateLimitError extends Layer5Error {
    override name = 'Layer5RateLimitError';
    public readonly retryAfter: number;

    constructor(message: string, retryAfter: number) {
        super(message, 429);
        this.retryAfter = retryAfter;
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

/** Raised on HTTP 404 — resource not found. */
export class Layer5NotFoundError extends Layer5Error {
    override name = 'Layer5NotFoundError';
    constructor(message: string, responseBody?: unknown) {
        super(message, 404, responseBody);
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

/** Raised on HTTP 5xx — server-side error. */
export class Layer5ServerError extends Layer5Error {
    override name = 'Layer5ServerError';
    constructor(message: string, statusCode: number, responseBody?: unknown) {
        super(message, statusCode, responseBody);
        Object.setPrototypeOf(this, new.target.prototype);
    }
}
