"""
Layer5 SDK — Exception hierarchy.

Every error a user encounters has:
  - A specific exception class (not generic Exception)
  - A message that tells them exactly what to do
  - The original error attached for debugging

Exception tree:
  Layer5Error
  ├── Layer5AuthError
  ├── Layer5RateLimitError
  ├── Layer5ValidationError
  ├── Layer5NetworkError
  │   └── Layer5TimeoutError
  ├── Layer5ServerError
  ├── Layer5UnknownActionError
  └── Layer5AgentSuspendedError
"""


class Layer5Error(Exception):
    """Base exception for all Layer5 errors."""
    pass


class Layer5AuthError(Layer5Error):
    """
    Raised when API key is invalid or missing.

    Fix: Check your api_key parameter.
    Keys start with 'layer5_' and are 32 chars long.
    Get your key at: https://app.layer5.dev/settings/api-keys
    """

    def __init__(self, message: str | None = None):
        super().__init__(
            message
            or "Invalid or missing API key. "
            "Keys must start with 'layer5_'. "
            "Get yours at https://app.layer5.dev/settings/api-keys"
        )


class Layer5RateLimitError(Layer5Error):
    """
    Raised when rate limit is exceeded.
    Contains retry_after seconds if provided by server.
    """

    def __init__(self, retry_after: int = 60):
        self.retry_after = retry_after
        super().__init__(
            f"Rate limit exceeded. "
            f"Retry after {retry_after} seconds. "
            f"Consider upgrading your plan for higher limits."
        )


class Layer5ValidationError(Layer5Error):
    """
    Raised when request data fails validation.
    field: which field caused the error
    """

    def __init__(self, message: str, field: str | None = None):
        self.field = field
        prefix = f"[{field}] " if field else ""
        super().__init__(f"Validation error: {prefix}{message}")


class Layer5NetworkError(Layer5Error):
    """
    Raised on connection failures, timeouts, DNS errors.
    The SDK retried automatically before raising this.
    """

    def __init__(self, message: str, original: Exception | None = None):
        self.original = original
        super().__init__(
            f"Network error after retries: {message}. "
            f"Check your internet connection and "
            f"that api.layer5.dev is reachable."
        )


class Layer5TimeoutError(Layer5NetworkError):
    """Request timed out after all retries."""
    pass


class Layer5ServerError(Layer5Error):
    """
    Raised on 5xx responses from Layer5 servers.
    status_code: HTTP status code received
    request_id: for reporting to Layer5 support
    """

    def __init__(self, status_code: int, request_id: str | None = None):
        self.status_code = status_code
        self.request_id = request_id
        ref = f" (request_id: {request_id})" if request_id else ""
        super().__init__(
            f"Layer5 server error ({status_code}){ref}. "
            f"This is not your fault. "
            f"Check https://status.layer5.dev or "
            f"contact support@layer5.dev"
        )


class Layer5UnknownActionError(Layer5Error):
    """
    Raised when action_name is not registered in Layer5.
    This prevents hallucinated actions from being logged.
    """

    def __init__(self, action_name: str):
        self.action_name = action_name
        super().__init__(
            f"Unknown action: '{action_name}'. "
            f"Register it first at "
            f"https://app.layer5.dev/actions or via "
            f"POST /v1/admin/register-action. "
            f"This prevents unregistered actions "
            f"from polluting your outcome history."
        )


class Layer5AgentSuspendedError(Layer5Error):
    """
    Raised when the agent is suspended due to
    too many failures. Human reinstatement required.
    """

    def __init__(self, agent_id: str):
        self.agent_id = agent_id
        super().__init__(
            f"Agent '{agent_id}' is suspended. "
            f"Reinstate it at "
            f"https://app.layer5.dev/trust "
            f"or via POST /v1/admin/reinstate-agent. "
            f"Review why the agent was suspended first."
        )
