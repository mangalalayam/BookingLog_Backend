import bcrypt from 'bcryptjs';
import {Router} from 'express';
import {z} from 'zod';
import {requireAdmin} from '../auth.ts';
import {pool, transaction} from '../db.ts';
import {badRequest, conflict, dateString, notFound, parse, phone, uuid} from '../http.ts';

/*
 * Provider-only routes (you, the software provider). Every request needs the
 * x-admin-key header. Tour companies never call these.
 */
const router = Router();
router.use('/admin', requireAdmin);

// Keep a record of every change made here (not reads, and never the body,
// which can hold a password): what was called, the result, and from where.
router.use('/admin', (req, res, next) => {
  if (req.method !== 'GET') {
    const path = req.originalUrl.split('?')[0];
    res.on('finish', () => {
      pool
        .query(
          'insert into admin_log (method, path, status, ip) values ($1, $2, $3, $4)',
          [req.method, path, res.statusCode, req.ip ?? null],
        )
        .catch(error => console.error('Could not write admin_log:', error));
    });
  }
  next();
});

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
    const taken = await client.query(
      'select 1 from users where phone = $1 and deleted_at is null',
      [input.owner.phone],
    );
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
            (select count(*)::int from users u
              where u.company_id = c.id and u.deleted_at is null) as members,
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

/* --------------------------------- members -------------------------------- */

const MEMBER_FIELDS = 'id, name, phone, role, active, created_at';
const role = z.enum(['owner', 'staff', 'driver']);

const companyExists = async (id: string) => {
  const found = await pool.query('select 1 from companies where id = $1', [id]);
  if (!found.rowCount) {
    throw notFound('Company');
  }
};

/** GET /admin/companies/:id/members → that company's team */
router.get('/admin/companies/:id/members', async (req, res) => {
  const companyId = parse(uuid, req.params.id);
  await companyExists(companyId);
  const {rows} = await pool.query(
    `select ${MEMBER_FIELDS} from users
      where company_id = $1 and deleted_at is null
      order by created_at`,
    [companyId],
  );
  res.json(rows);
});

const createMemberSchema = z.object({
  name: z.string().trim().min(1),
  phone,
  password: z.string().min(6, 'Password must be at least 6 characters'),
  role: role.default('staff'),
});

/** POST /admin/companies/:id/members  {name, phone, password, role?} */
router.post('/admin/companies/:id/members', async (req, res) => {
  const companyId = parse(uuid, req.params.id);
  const input = parse(createMemberSchema, req.body);
  await companyExists(companyId);

  const taken = await pool.query(
    'select 1 from users where phone = $1 and deleted_at is null',
    [input.phone],
  );
  if (taken.rowCount) {
    throw conflict('That phone number already has an account');
  }

  const {rows} = await pool.query(
    `insert into users (company_id, role, name, phone, password_hash)
     values ($1, $2, $3, $4, $5)
     returning ${MEMBER_FIELDS}`,
    [
      companyId,
      input.role,
      input.name,
      input.phone,
      await bcrypt.hash(input.password, 10),
    ],
  );
  res.status(201).json(rows[0]);
});

const updateMemberSchema = z
  .object({
    name: z.string().trim().min(1),
    role,
    active: z.boolean(),
    password: z.string().min(6, 'Password must be at least 6 characters'),
  })
  .partial();

/** PATCH /admin/companies/:id/members/:memberId  {name?, role?, active?, password?} */
router.patch('/admin/companies/:id/members/:memberId', async (req, res) => {
  const companyId = parse(uuid, req.params.id);
  const memberId = parse(uuid, req.params.memberId);
  const input = parse(updateMemberSchema, req.body);

  const member = await transaction(async client => {
    const {rows} = await client.query(
      `update users
          set name = coalesce($3, name),
              role = coalesce($4, role),
              active = coalesce($5, active),
              password_hash = coalesce($6, password_hash),
              -- A new password logs the member out everywhere.
              token_version = token_version + ($6::text is not null)::int
        where id = $1 and company_id = $2 and deleted_at is null
        returning ${MEMBER_FIELDS}`,
      [
        memberId,
        companyId,
        input.name ?? null,
        input.role ?? null,
        input.active ?? null,
        input.password ? await bcrypt.hash(input.password, 10) : null,
      ],
    );
    if (!rows[0]) {
      throw notFound('Member');
    }
    // Never leave a company without an active owner to run it.
    const owners = await client.query(
      `select count(*)::int as n from users
        where company_id = $1 and role = 'owner' and active`,
      [companyId],
    );
    if (owners.rows[0].n === 0) {
      throw badRequest('A company needs at least one active owner');
    }
    return rows[0];
  });

  res.json(member);
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
