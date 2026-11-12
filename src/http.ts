import type {NextFunction, Request, Response} from 'express';
import {z} from 'zod';

/** An error with a status code that is safe to show to the app. */
export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new ApiError(400, 'BAD_REQUEST', message, details);
export const notFound = (what: string) =>
  new ApiError(404, 'NOT_FOUND', `${what} not found`);
export const conflict = (message: string) =>
  new ApiError(409, 'CONFLICT', message);

/** Validate input against a schema, or fail with a 400 listing each problem. */
export const parse = <T extends z.ZodType>(
  schema: T,
  data: unknown,
): z.infer<T> => {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw badRequest(
      'Invalid input',
      result.error.issues.map(issue => ({
        field: issue.path.join('.'),
        message: issue.message,
      })),
    );
  }
  return result.data;
};

/* ------------------------------ shared fields ----------------------------- */

const isRealDate = (value: string) => {
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  );
};

/** A calendar date as 'YYYY-MM-DD' that really exists (no 2026-02-30). */
export const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine(isRealDate, 'Not a real date');

/** Accepts +91 / 0 prefixes and spacing; stores the bare 10 digits. */
export const phone = z
  .string()
  .transform(value => {
    let digits = value.replace(/\D/g, '');
    if (digits.length > 10 && digits.startsWith('91')) {
      digits = digits.slice(2);
    } else if (digits.length > 10 && digits.startsWith('0')) {
      digits = digits.slice(1);
    }
    return digits;
  })
  .refine(
    value => /^[6-9]\d{9}$/.test(value),
    'Enter a valid 10-digit mobile number',
  );

export const uuid = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    'Invalid id',
  );

/* ------------------------------ error handler ----------------------------- */

export const errorHandler = (
  error: any,
  _req: Request,
  res: Response,
  _next: NextFunction,
) => {
  if (error instanceof ApiError) {
    res.status(error.status).json({
      error: {code: error.code, message: error.message, details: error.details},
    });
    return;
  }
  // Malformed JSON body.
  if (error?.type === 'entity.parse.failed') {
    res.status(400).json({
      error: {code: 'BAD_REQUEST', message: 'Request body is not valid JSON'},
    });
    return;
  }
  // The database refused the row (a rule the validation above did not catch).
  if (error?.code === '23505') {
    res
      .status(409)
      .json({error: {code: 'CONFLICT', message: 'That already exists'}});
    return;
  }
  if (typeof error?.code === 'string' && error.code.startsWith('23')) {
    res.status(400).json({
      error: {
        code: 'BAD_REQUEST',
        message: 'The data was rejected by the database',
      },
    });
    return;
  }
  console.error(error);
  res.status(500).json({
    error: {code: 'SERVER_ERROR', message: 'Something went wrong on the server'},
  });
};
