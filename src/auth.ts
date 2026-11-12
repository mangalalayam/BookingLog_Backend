import crypto from 'node:crypto';
import type {NextFunction, Request, Response} from 'express';
import jwt from 'jsonwebtoken';
import {config} from './config.ts';
import {pool} from './db.ts';
import {ApiError} from './http.ts';

export type Role = 'owner' | 'staff' | 'driver';

export type CurrentUser = {
  id: string;
  companyId: string;
  companyName: string;
  role: Role;
  name: string;
  phone: string;
};

declare global {
  namespace Express {
    interface Request {
      /** Set by `requireUser`. */
      user: CurrentUser;
    }
  }
}

export const signToken = (userId: string) =>
  jwt.sign({sub: userId}, config.jwtSecret, {expiresIn: config.tokenTtl});

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
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    userId = String((payload as jwt.JwtPayload).sub);
  } catch {
    throw unauthorized();
  }

  const {rows} = await pool.query(
    `select u.id, u.company_id, u.role, u.name, u.phone,
            u.active as user_active,
            c.active as company_active,
            c.name as company_name
       from users u
       join companies c on c.id = u.company_id
      where u.id = $1`,
    [userId],
  );
  const row = rows[0];
  if (!row || !row.user_active) {
    throw unauthorized('This account is no longer active');
  }
  if (!row.company_active) {
    throw new ApiError(
      403,
      'COMPANY_INACTIVE',
      'This company account has been suspended. Contact support.',
    );
  }

  req.user = {
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

/** Provider-only routes: the x-admin-key header must match ADMIN_API_KEY. */
export const requireAdmin = (
  req: Request,
  _res: Response,
  next: NextFunction,
) => {
  const given = Buffer.from(String(req.headers['x-admin-key'] ?? ''));
  const expected = Buffer.from(config.adminApiKey);
  if (
    given.length !== expected.length ||
    !crypto.timingSafeEqual(given, expected)
  ) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Invalid admin key');
  }
  next();
};
