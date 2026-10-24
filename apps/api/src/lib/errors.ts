export type ErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'PAYMENT_REQUIRED'
  | 'TOO_MANY_REQUESTS'
  | 'CAPTCHA_REQUIRED'
  | 'PASSWORD_CHANGE_REQUIRED'
  | 'UNAVAILABLE'
  | 'INTERNAL';

const STATUS: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PAYMENT_REQUIRED: 402,
  TOO_MANY_REQUESTS: 429,
  CAPTCHA_REQUIRED: 428,
  PASSWORD_CHANGE_REQUIRED: 403,
  UNAVAILABLE: 503,
  INTERNAL: 500,
};

/** Error carrying a Persian user-facing message. Response shape: { error: { code, message, details? } } */
export class AppError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.status = STATUS[code];
  }
}

export function fail(code: ErrorCode, message: string, details?: Record<string, unknown>): never {
  throw new AppError(code, message, details);
}
