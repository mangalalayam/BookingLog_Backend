import bcrypt from 'bcryptjs';
import {Router} from 'express';
import {z} from 'zod';
import {requireRole, requireUser} from '../auth.ts';
import {pool} from '../db.ts';
import {badRequest, conflict, notFound, parse, phone, uuid} from '../http.ts';

/*
 * A company's team. Everyone can see the list; only the owner changes it.
 * Members are deactivated rather than deleted, so trip history keeps the
 * name of whoever made each change.
 */
const router = Router();
router.use('/members', requireUser);

const FIELDS = 'id, name, phone, role, active, created_at';

/** GET /members → everyone in my company */
router.get('/members', async (req, res) => {
  const {rows} = await pool.query(
    `select ${FIELDS} from users where company_id = $1 order by created_at`,
    [req.user.companyId],
  );
  res.json(rows);
});

const createSchema = z.object({
  name: z.string().trim().min(1),
  phone,
  password: z.string().min(6, 'Password must be at least 6 characters'),
  role: z.enum(['owner', 'staff', 'driver']).default('staff'),
});

/** POST /members  {name, phone, password, role?} → add a team member */
router.post('/members', requireRole('owner'), async (req, res) => {
  const input = parse(createSchema, req.body);

  const taken = await pool.query('select 1 from users where phone = $1', [
    input.phone,
  ]);
  if (taken.rowCount) {
    throw conflict('That phone number already has an account');
  }

  const {rows} = await pool.query(
    `insert into users (company_id, role, name, phone, password_hash)
     values ($1, $2, $3, $4, $5)
     returning ${FIELDS}`,
    [
      req.user.companyId,
      input.role,
      input.name,
      input.phone,
      await bcrypt.hash(input.password, 10),
    ],
  );
  res.status(201).json(rows[0]);
});

const updateSchema = z
  .object({
    name: z.string().trim().min(1),
    role: z.enum(['owner', 'staff', 'driver']),
    active: z.boolean(),
    password: z.string().min(6, 'Password must be at least 6 characters'),
  })
  .partial();

/** PATCH /members/:id  {name?, role?, active?, password?} */
router.patch('/members/:id', requireRole('owner'), async (req, res) => {
  const id = parse(uuid, req.params.id);
  const input = parse(updateSchema, req.body);

  // An owner cannot lock themselves out or demote themselves by accident.
  if (
    id === req.user.id &&
    (input.active === false || (input.role && input.role !== 'owner'))
  ) {
    throw badRequest('You cannot remove your own owner access');
  }

  const {rows} = await pool.query(
    `update users
        set name = coalesce($3, name),
            role = coalesce($4, role),
            active = coalesce($5, active),
            password_hash = coalesce($6, password_hash)
      where id = $1 and company_id = $2
      returning ${FIELDS}`,
    [
      id,
      req.user.companyId,
      input.name ?? null,
      input.role ?? null,
      input.active ?? null,
      input.password ? await bcrypt.hash(input.password, 10) : null,
    ],
  );
  if (!rows[0]) {
    throw notFound('Member');
  }
  res.json(rows[0]);
});

export default router;
