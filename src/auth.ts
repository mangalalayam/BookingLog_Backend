import crypto from 'node:crypto';
import type {NextFunction, Request, Response} from 'express';
import jwt from 'jsonwebtoken';
import {config} from './config.ts';
import {pool} from './db.ts';
import {ApiError} from './http.ts';
import {isThrottled, recordFailure, TOO_MANY_ATTEMPTS} from './throttle.ts';

export type Role = 'owner' | 'staff' | 'driver';

export type CurrentUser = {
  id: string;
  companyId: string;
  companyName: string;
  role: Role;
  name: string;
  phone: string;
  /** Goes up when the password changes; older tokens then stop working. */
  tokenVersion: number;
};

declare global {
  namespace Express {
    interface Request {
      /** Set by `requireUser`. */
      user: CurrentUser;
    }
  }
}

export const signToken = (userId: string, tokenVersion: number) =>
  jwt.sign({sub: userId, ver: tokenVersion}, config.jwtSecret, {
    expiresIn: config.tokenTtl,
  });

const unauthorized = (message = 'Please log in again') =>
  new ApiError(401, 'UNAUTHORIZED', message);

/**
 * Checks the token and loads the user fresh from the database on every
 * request, so disabling a user or a company takes effect immediately.
 */
export const requireUser = async (
  req: Request,
  _res: Response,
  next: NextFunction,
) => {
  // The app sends the bare token; "Bearer <token>" is accepted too.
  const header = req.headers.authorization ?? '';
  const token = header.replace(/^Bearer\s+/i, '').trim();
  if (!token) {
    throw unauthorized();
  }

  let userId: string;
  let tokenVersion: number;
  try {
    const payload = jwt.verify(token, config.jwtSecret) as jwt.JwtPayload;
    userId = String(payload.sub);
    // Tokens issued before versions existed count as version 0.
    tokenVersion = Number(payload.ver ?? 0);
  } catch {
    throw unauthorized();
  }

  const {rows} = await pool.query(
    `select u.id, u.company_id, u.role, u.name, u.phone, u.token_version,
            u.active as user_active,
            c.active as company_active,
            c.name as company_name
       from users u
       join companies c on c.id = u.company_id
      where u.id = $1 and u.deleted_at is null`,
    [userId],
  );
  const row = rows[0];
  if (!row || !row.user_active) {
    throw unauthorized('This account is no longer active');
  }
  // The password was changed after this token was issued.
  if (row.token_version !== tokenVersion) {
    throw unauthorized();
  }
  if (!row.company_active) {
    throw new ApiError(
      403,
      'COMPANY_INACTIVE',
      'This company account has been suspended. Contact support.',
    );
  }

  req.user = {
    tokenVersion: row.token_version,
    id: row.id,
    companyId: row.company_id,
    companyName: row.company_name,
    role: row.role,
    name: row.name,
    phone: row.phone,
  };
  next();
};

/** Allow only the listed roles (use after `requireUser`). */
export const requireRole =
  (...roles: Role[]) =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!roles.includes(req.user.role)) {
      throw new ApiError(403, 'FORBIDDEN', 'You are not allowed to do this');
    }
    next();
  };

const MAX_ADMIN_FAILURES = 10;

/**
 * Provider-only routes: the x-admin-key header must match ADMIN_API_KEY.
 * After 10 wrong keys from one IP address, that address is refused for 15
 * minutes (even with the right key), so the key cannot be guessed.
 */
export const requireAdmin = async (
  req: Request,
  _res: Response,
  next: NextFunction,
) => {
  const throttleKey = `admin:${req.ip ?? 'unknown'}`;
  if (await isThrottled({[throttleKey]: MAX_ADMIN_FAILURES})) {
    throw new ApiError(429, 'TOO_MANY_ATTEMPTS', TOO_MANY_ATTEMPTS);
  }

  const given = Buffer.from(String(req.headers['x-admin-key'] ?? ''));
  const expected = Buffer.from(config.adminApiKey);
  if (
    given.length !== expected.length ||
    !crypto.timingSafeEqual(given, expected)
  ) {
    await recordFailure([throttleKey]);
    throw new ApiError(401, 'UNAUTHORIZED', 'Invalid admin key');
  }
  next();
};
