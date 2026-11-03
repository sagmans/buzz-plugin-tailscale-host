// Domain errors. Each carries a stable `code` the HTTP layer returns as
// `{error: code}` (docs/RUNNER_CONTRACT.md) and the HTTP status it maps to, so routes
// never invent status codes and the cause chain stays intact for logs.

export class RunnerError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The config file is missing, unreadable or invalid: startup must stop. */
export class ConfigError extends RunnerError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("config_invalid", 500, message, options);
  }
}

/** A request body or parameter failed validation at the trust boundary. */
export class ValidationError extends RunnerError {
  constructor(message: string, code = "invalid_request") {
    super(code, 400, message);
  }
}

/** The caller is not an allowed tailnet login. */
export class ForbiddenError extends RunnerError {
  constructor(message = "Not allowed") {
    super("forbidden", 403, message);
  }
}

export class NotFoundError extends RunnerError {
  constructor(message = "Not found") {
    super("not_found", 404, message);
  }
}

export class ConflictError extends RunnerError {
  constructor(message: string) {
    super("conflict", 409, message);
  }
}

/** The harness is not one this runner offers, cannot run yet, or is not
 * ready (claude not installed or not signed in). The owner fixes it on the
 * host; repeating the call does not help until then. */
export class HarnessUnavailableError extends RunnerError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("harness_unavailable", 409, message, options);
  }
}

/** The host is too busy to answer now (every live-session slot is busy);
 * repeating later works. */
export class BusyError extends RunnerError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("busy", 503, message, options);
  }
}

export class PayloadTooLargeError extends RunnerError {
  constructor(limit: number) {
    super("payload_too_large", 413, `Body over ${limit} bytes`);
  }
}

export class UnsupportedMediaError extends RunnerError {
  constructor() {
    super("unsupported_media_type", 415, "Send application/json");
  }
}

/** The NIP-OA owner proof does not name the configured owner or does not
 * verify. */
export class AttestationError extends RunnerError {
  constructor(message: string) {
    super("invalid_auth", 400, message);
  }
}

/** The community refused or could not be reached. */
export class RelayError extends RunnerError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("relay_unavailable", 502, message, options);
  }
}

/** State on disk could not be read or written. */
export class StateError extends RunnerError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("state_error", 500, message, options);
  }
}

/** The claude process could not be started or controlled. */
export class ProcessError extends RunnerError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("process_error", 500, message, options);
  }
}

export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
