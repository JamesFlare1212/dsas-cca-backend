export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UPSTREAM_UNAVAILABLE'
  | 'UPSTREAM_PROTOCOL_ERROR'
  | 'AUTHENTICATION_FAILED'
  | 'STORAGE_UNAVAILABLE'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'SHUTTING_DOWN';

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly status: number = 503,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'AppError';
  }
}

export class UpstreamError extends AppError {
  constructor(
    code: 'UPSTREAM_UNAVAILABLE' | 'UPSTREAM_PROTOCOL_ERROR' | 'AUTHENTICATION_FAILED',
    message: string,
    options?: ErrorOptions,
  ) {
    super(code, message, 503, options);
    this.name = 'UpstreamError';
  }
}
