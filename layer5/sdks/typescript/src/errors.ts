// Layerinfinite SDK — errors.ts
// Typed exception hierarchy for all Layerinfinite API failure modes.

export class LayerinfiniteError extends Error {
    public readonly statusCode?: number;
    public readonly responseBody?: unknown;

    constructor(
        message: string,
        statusCode?: number,
        responseBody?: unknown,
    ) {
        super(message);
        this.name = 'LayerinfiniteError';
        this.statusCode = statusCode;
        this.responseBody = responseBody;
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

/** Raised on HTTP 401 — invalid or missing API key. */
export class LayerinfiniteAuthError extends LayerinfiniteError {
    override name = 'LayerinfiniteAuthError';
    constructor(message: string, responseBody?: unknown) {
        super(message, 401, responseBody);
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

/** Raised on HTTP 429 — rate limit exceeded. */
export class LayerinfiniteRateLimitError extends LayerinfiniteError {
    override name = 'LayerinfiniteRateLimitError';
    public readonly retryAfter: number;

    constructor(message: string, retryAfter: number) {
        super(message, 429);
        this.retryAfter = retryAfter;
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

/** Raised on HTTP 404 — resource not found. */
export class LayerinfiniteNotFoundError extends LayerinfiniteError {
    override name = 'LayerinfiniteNotFoundError';
    constructor(message: string, responseBody?: unknown) {
        super(message, 404, responseBody);
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

/** Raised on HTTP 5xx — server-side error. */
export class LayerinfiniteServerError extends LayerinfiniteError {
    override name = 'LayerinfiniteServerError';
    constructor(message: string, statusCode: number, responseBody?: unknown) {
        super(message, statusCode, responseBody);
        Object.setPrototypeOf(this, new.target.prototype);
    }
}
