import bcrypt from 'bcryptjs';
import {Router} from 'express';
import {z} from 'zod';
import {requireUser, signToken} from '../auth.ts';
import {pool} from '../db.ts';
import {ApiError, parse, phone} from '../http.ts';
import {
  clearFailures,
  isThrottled,
  recordFailure,
  TOO_MANY_ATTEMPTS,
} from '../throttle.ts';

const router = Router();

/* ------------------------- failed-login throttling ------------------------ */

/*
 * Wrong passwords are counted three ways, each over 15 minutes:
 *  - one phone from one IP address: 8. The normal case; someone else's wrong
 *    guesses from elsewhere do not lock the real user out this quickly.
 *  - one phone from anywhere: 30. Stops guessing spread over many addresses.
 *  - one IP address, any phone: 40. Stops one address trying many accounts.
 */
const loginLimits = (userPhone: string, ip: string) => ({
  [`login:${userPhone}:${ip}`]: 8,
  [`login-phone:${userPhone}`]: 30,
  [`login-ip:${ip}`]: 40,
});

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

  const limits = loginLimits(input.phone, req.ip ?? 'unknown');

  if (await isThrottled(limits)) {
    throw new ApiError(429, 'TOO_MANY_ATTEMPTS', TOO_MANY_ATTEMPTS);
  }

  const {rows} = await pool.query(
    `select u.id, u.name, u.phone, u.role, u.password_hash, u.active,
            u.token_version,
            u.company_id, c.name as company_name, c.active as company_active
       from users u
       join companies c on c.id = u.company_id
      where u.phone = $1 and u.deleted_at is null`,
    [input.phone],
  );
  const row = rows[0];

  const passwordOk = await bcrypt.compare(
    input.password,
    row?.password_hash ?? DUMMY_HASH,
  );
  if (!row || !passwordOk || !row.active) {
    await recordFailure(Object.keys(limits));
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

  // The per-IP count stays: one right password does not excuse the rest.
  await clearFailures(
    Object.keys(limits).filter(key => !key.startsWith('login-ip:')),
  );
  res.json({
    token: signToken(row.id, row.token_version),
    user: publicUser(row),
  });
});

/** POST /auth/refresh-token  (valid token in Authorization) → {token} */
router.post('/auth/refresh-token', requireUser, (req, res) => {
  res.json({token: signToken(req.user.id, req.user.tokenVersion)});
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
