import bcrypt from 'bcryptjs';
import {Router} from 'express';
import {z} from 'zod';
import {requireUser, signToken} from '../auth.ts';
import {pool} from '../db.ts';
import {ApiError, parse, phone} from '../http.ts';

const router = Router();

/* ------------------------- failed-login throttling ------------------------ */

// Per phone number, in memory: enough to stop password guessing on one server.
const MAX_FAILURES = 8;
const WINDOW_MS = 15 * 60 * 1000;
const failures = new Map<string, {count: number; since: number}>();

const isLocked = (key: string) => {
  const entry = failures.get(key);
  if (!entry) {
    return false;
  }
  if (Date.now() - entry.since > WINDOW_MS) {
    failures.delete(key);
    return false;
  }
  return entry.count >= MAX_FAILURES;
};

const recordFailure = (key: string) => {
  const entry = failures.get(key);
  if (!entry || Date.now() - entry.since > WINDOW_MS) {
    failures.set(key, {count: 1, since: Date.now()});
  } else {
    entry.count += 1;
  }
};

// Compared against when the phone is unknown, so both cases take equally long.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

/* --------------------------------- routes --------------------------------- */

const loginSchema = z.object({
  phone,
  password: z.string().min(1),
});

const publicUser = (row: any) => ({
  id: row.id,
  name: row.name,
  phone: row.phone,
  role: row.role,
  company: {id: row.company_id, name: row.company_name},
});

/** POST /auth/login  {phone, password} → {token, user} */
router.post('/auth/login', async (req, res) => {
  const input = parse(loginSchema, req.body);

  if (isLocked(input.phone)) {
    throw new ApiError(
      429,
      'TOO_MANY_ATTEMPTS',
      'Too many failed attempts. Try again in 15 minutes.',
    );
  }

  const {rows} = await pool.query(
    `select u.id, u.name, u.phone, u.role, u.password_hash, u.active,
            u.company_id, c.name as company_name, c.active as company_active
       from users u
       join companies c on c.id = u.company_id
      where u.phone = $1`,
    [input.phone],
  );
  const row = rows[0];

  const passwordOk = await bcrypt.compare(
    input.password,
    row?.password_hash ?? DUMMY_HASH,
  );
  if (!row || !passwordOk || !row.active) {
    recordFailure(input.phone);
    throw new ApiError(
      401,
      'INVALID_LOGIN',
      'Wrong phone number or password',
    );
  }
  if (!row.company_active) {
    throw new ApiError(
      403,
      'COMPANY_INACTIVE',
      'This company account has been suspended. Contact support.',
    );
  }

  failures.delete(input.phone);
  res.json({token: signToken(row.id), user: publicUser(row)});
});

/** POST /auth/refresh-token  (valid token in Authorization) → {token} */
router.post('/auth/refresh-token', requireUser, (req, res) => {
  res.json({token: signToken(req.user.id)});
});

/** GET /profile → the logged-in user and their company */
router.get('/profile', requireUser, (req, res) => {
  const {id, name, phone: userPhone, role, companyId, companyName} = req.user;
  res.json({
    id,
    name,
    phone: userPhone,
    role,
    company: {id: companyId, name: companyName},
  });
});

export default router;
