import bcrypt from 'bcryptjs';
import {Router} from 'express';
import {z} from 'zod';
import {requireAdmin} from '../auth.ts';
import {pool, transaction} from '../db.ts';
import {conflict, dateString, notFound, parse, phone, uuid} from '../http.ts';

/*
 * Provider-only routes (you, the software provider). Every request needs the
 * x-admin-key header. Tour companies never call these.
 */
const router = Router();
router.use('/admin', requireAdmin);

/* -------------------------------- companies ------------------------------- */

const createCompanySchema = z.object({
  name: z.string().trim().min(1),
  owner: z.object({
    name: z.string().trim().min(1),
    phone,
    password: z.string().min(6, 'Password must be at least 6 characters'),
  }),
});

/** POST /admin/companies → creates the company and its owner login together */
router.post('/admin/companies', async (req, res) => {
  const input = parse(createCompanySchema, req.body);
  const passwordHash = await bcrypt.hash(input.owner.password, 10);

  const result = await transaction(async client => {
    const taken = await client.query('select 1 from users where phone = $1', [
      input.owner.phone,
    ]);
    if (taken.rowCount) {
      throw conflict('That phone number already has an account');
    }
    const company = await client.query(
      'insert into companies (name) values ($1) returning id, name, active, created_at',
      [input.name],
    );
    const owner = await client.query(
      `insert into users (company_id, role, name, phone, password_hash)
       values ($1, 'owner', $2, $3, $4)
       returning id, name, phone, role`,
      [company.rows[0].id, input.owner.name, input.owner.phone, passwordHash],
    );
    return {company: company.rows[0], owner: owner.rows[0]};
  });

  res.status(201).json(result);
});

/** GET /admin/companies → every company with member and trip counts */
router.get('/admin/companies', async (_req, res) => {
  const {rows} = await pool.query(
    `select c.id, c.name, c.active, c.created_at,
            (select count(*)::int from users u where u.company_id = c.id) as members,
            (select count(*)::int from trips t where t.company_id = c.id) as trips
       from companies c
      order by c.created_at`,
  );
  res.json(rows);
});

const updateCompanySchema = z
  .object({
    name: z.string().trim().min(1),
    active: z.boolean(),
  })
  .partial();

/** PATCH /admin/companies/:id  {name?, active?} → rename or suspend/restore */
router.patch('/admin/companies/:id', async (req, res) => {
  const id = parse(uuid, req.params.id);
  const input = parse(updateCompanySchema, req.body);
  const {rows} = await pool.query(
    `update companies
        set name = coalesce($2, name),
            active = coalesce($3, active)
      where id = $1
      returning id, name, active, created_at`,
    [id, input.name ?? null, input.active ?? null],
  );
  if (!rows[0]) {
    throw notFound('Company');
  }
  res.json(rows[0]);
});

/* -------------------------------- holidays -------------------------------- */

const holidaysSchema = z.object({
  state: z.string().trim().min(1).default('Kerala'),
  holidays: z
    .array(z.object({date: dateString, name: z.string().trim().min(1)}))
    .min(1),
});

/**
 * PUT /admin/holidays  {state?, holidays: [{date, name}]}
 * Adds the given days, or renames ones that already exist. Use this each year
 * when the government publishes the next list.
 */
router.put('/admin/holidays', async (req, res) => {
  const input = parse(holidaysSchema, req.body);
  await transaction(async client => {
    for (const holiday of input.holidays) {
      await client.query(
        `insert into holidays (state, date, name) values ($1, $2, $3)
         on conflict (state, date) do update set name = excluded.name`,
        [input.state, holiday.date, holiday.name],
      );
    }
  });
  res.json({saved: input.holidays.length});
});

/** DELETE /admin/holidays/:date?state=Kerala → remove a wrongly added day */
router.delete('/admin/holidays/:date', async (req, res) => {
  const date = parse(dateString, req.params.date);
  const state = parse(z.string().trim().min(1).default('Kerala'), req.query.state);
  const result = await pool.query(
    'delete from holidays where state = $1 and date = $2',
    [state, date],
  );
  if (!result.rowCount) {
    throw notFound('Holiday');
  }
  res.status(204).end();
});

export default router;
