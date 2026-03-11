/**
 * Layer5 SDK — Error hierarchy.
 *
 * Every error a user encounters has:
 *   - A specific error class (not generic Error)
 *   - A message that tells them exactly what to do
 *   - Relevant properties for programmatic handling
 *   - Object.setPrototypeOf for correct instanceof checks
 *
 * Error tree:
 *   Layer5Error
 *   ├── Layer5AuthError
 *   ├── Layer5RateLimitError
 *   ├── Layer5ValidationError
 *   ├── Layer5NetworkError
 *   │   └── Layer5TimeoutError
 *   ├── Layer5ServerError
 *   ├── Layer5UnknownActionError
 *   └── Layer5AgentSuspendedError
 */

export class Layer5Error extends Error {
  override readonly name: string = 'Layer5Error';
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, Layer5Error.prototype);
  }
}

export class Layer5AuthError extends Layer5Error {
  override readonly name = 'Layer5AuthError';
  constructor(message?: string) {
    super(
      message ??
        "Invalid or missing API key. " +
          "Keys must start with 'layer5_'. " +
          "Get yours at https://app.layer5.dev/settings/api-keys"
    );
    Object.setPrototypeOf(this, Layer5AuthError.prototype);
  }
}

export class Layer5RateLimitError extends Layer5Error {
  override readonly name = 'Layer5RateLimitError';
  constructor(public readonly retryAfter: number = 60) {
    super(
      `Rate limit exceeded. ` +
        `Retry after ${retryAfter} seconds. ` +
        `Consider upgrading your plan for higher limits.`
    );
    Object.setPrototypeOf(this, Layer5RateLimitError.prototype);
  }
}

export class Layer5ValidationError extends Layer5Error {
  override readonly name = 'Layer5ValidationError';
  constructor(
    message: string,
    public readonly field?: string
  ) {
    super(
      `Validation error${field ? ` [${field}]` : ''}: ${message}`
    );
    Object.setPrototypeOf(this, Layer5ValidationError.prototype);
  }
}

export class Layer5NetworkError extends Layer5Error {
  override readonly name: string = 'Layer5NetworkError';
  constructor(
    message: string,
    public readonly original?: Error
  ) {
    super(
      `Network error after retries: ${message}. ` +
        `Check your internet connection and ` +
        `that api.layer5.dev is reachable.`
    );
    Object.setPrototypeOf(this, Layer5NetworkError.prototype);
  }
}

export class Layer5TimeoutError extends Layer5NetworkError {
  override readonly name = 'Layer5TimeoutError';
  constructor(message: string, original?: Error) {
    super(message, original);
    Object.setPrototypeOf(this, Layer5TimeoutError.prototype);
  }
}

export class Layer5ServerError extends Layer5Error {
  override readonly name = 'Layer5ServerError';
  constructor(
    public readonly statusCode: number,
    public readonly requestId?: string
  ) {
    super(
      `Layer5 server error (${statusCode})` +
        `${requestId ? ` (request_id: ${requestId})` : ''}. ` +
        `This is not your fault. ` +
        `Check https://status.layer5.dev or contact support@layer5.dev`
    );
    Object.setPrototypeOf(this, Layer5ServerError.prototype);
  }
}

export class Layer5UnknownActionError extends Layer5Error {
  override readonly name = 'Layer5UnknownActionError';
  constructor(public readonly actionName: string) {
    super(
      `Unknown action: '${actionName}'. ` +
        `Register it first at https://app.layer5.dev/actions ` +
        `or via POST /v1/admin/register-action. ` +
        `This prevents unregistered actions from polluting your outcome history.`
    );
    Object.setPrototypeOf(this, Layer5UnknownActionError.prototype);
  }
}

export class Layer5AgentSuspendedError extends Layer5Error {
  override readonly name = 'Layer5AgentSuspendedError';
  constructor(public readonly agentId: string) {
    super(
      `Agent '${agentId}' is suspended. ` +
        `Reinstate it at https://app.layer5.dev/trust ` +
        `or via POST /v1/admin/reinstate-agent. ` +
        `Review why the agent was suspended first.`
    );
    Object.setPrototypeOf(this, Layer5AgentSuspendedError.prototype);
  }
}
