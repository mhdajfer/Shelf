import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';

import { logger } from '../observability/logger.js';

export const ERROR_CODES = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  payload_too_large: 413,
  insufficient_credits: 402,
  rate_limited: 429,
  upstream_unavailable: 503,
  internal: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export interface FieldError {
  field: string;
  message: string;
}

export interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    /** Present for validation failures so the UI can place messages inline. */
    details?: FieldError[];
  };
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: FieldError[] | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    options: { details?: FieldError[]; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.status = ERROR_CODES[code];
    this.details = options.details;
  }
}

export const badRequest = (message: string, details?: FieldError[]): AppError =>
  new AppError('bad_request', message, details === undefined ? {} : { details });

/**
 * Used for another actor's private prompt as well as for genuinely absent
 * rows. Returning 403 there would confirm the prompt exists.
 */
export const notFound = (message = 'Not found.'): AppError => new AppError('not_found', message);

export const unauthorized = (message = 'Sign in to continue.'): AppError =>
  new AppError('unauthorized', message);

function fromZod(error: ZodError): AppError {
  const details = error.issues.map((issue) => ({
    field: issue.path.join('.'),
    message: issue.message,
  }));
  return badRequest('Some fields need fixing.', details);
}

export function notFoundHandler(_req: Request, _res: Response, next: NextFunction): void {
  next(notFound('That endpoint does not exist.'));
}

export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const appError =
    error instanceof AppError
      ? error
      : error instanceof ZodError
        ? fromZod(error)
        : new AppError('internal', 'Something went wrong on our end.', { cause: error });

  if (appError.status >= 500) {
    logger.error({ err: error, reqId: req.id }, 'unhandled request failure');
  }

  const body: ErrorBody = {
    error: {
      code: appError.code,
      message: appError.message,
      ...(appError.details === undefined ? {} : { details: appError.details }),
    },
  };

  res.status(appError.status).json(body);
}
