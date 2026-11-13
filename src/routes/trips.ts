import {Router} from 'express';
import type pg from 'pg';
import {z} from 'zod';
import {requireRole, requireUser} from '../auth.ts';
import {pool, transaction} from '../db.ts';
import {badRequest, dateString, notFound, parse, uuid} from '../http.ts';

/*
 * Trips are the data that must never be lost or wrong:
 *  - they are never deleted, only cancelled;
 *  - every create / edit / cancel is recorded in trip_history, in the same
 *    transaction as the change itself (a save that changes nothing is not);
 *  - "upcoming" is not stored; the app works it out from the dates.
 *  - "completed" and "payment received" are marked by a person once they
 *    happen (each can be undone), and are recorded in the history too.
 */
const router = Router();
router.use('/trips', requireUser);

/** Database row → the shape the app's `Booking` type uses. */
const toTrip = (row: any) => ({
  id: row.id,
  customerName: row.customer_name,
  phone: row.phone,
  from: row.from_place,
  to: row.destinations,
  drop: row.drop_place ?? '',
  pickupTime: row.pickup_time,
  passengers: row.passengers ?? undefined,
  vehicleNo: row.vehicle_no,
  startDate: row.start_date,
  endDate: row.end_date,
  totalAmount: row.total_amount,
  advance: row.advance,
  advanceMode: row.advance_mode ?? undefined,
  balanceMode: row.balance_mode ?? undefined,
  notes: row.notes,
  cancelled: row.cancelled,
  completed: row.completed_at !== null,
  completedAt: row.completed_at ? new Date(row.completed_at).getTime() : undefined,
  paymentReceived: row.payment_received_at !== null,
  paymentReceivedAt: row.payment_received_at
    ? new Date(row.payment_received_at).getTime()
    : undefined,
  createdAt: new Date(row.created_at).getTime(),
  updatedAt: new Date(row.updated_at).getTime(),
});

const paymentMode = z.enum(['Cash', 'UPI']).nullish();

const tripFields = z.object({
  customerName: z.string().trim().min(1),
  phone: z.string().trim().default(''),
  from: z.string().trim().min(1),
  to: z.array(z.string().trim().min(1)).min(1, 'Add at least one destination'),
  /** Optional final drop place; '' when not mentioned. */
  drop: z.string().trim().default(''),
  pickupTime: z.string().trim().default(''),
  passengers: z.number().int().positive().nullish(),
  vehicleNo: z
    .string()
    .trim()
    .min(1)
    .transform(value => value.toUpperCase()),
  startDate: dateString,
  endDate: dateString,
  totalAmount: z.number().nonnegative().default(0),
  advance: z.number().nonnegative().default(0),
  advanceMode: paymentMode,
  // No balanceMode here: the balance is paid after the trip, so its mode is
  // set only when the payment is marked (POST /trips/:id/payment).
  notes: z.string().default(''),
});

const createSchema = tripFields.extend({
  /** Optional id made up by the phone; makes retries safe (no duplicates). */
  clientId: z.string().trim().min(1).max(100).optional(),
});

// For edits every field is optional and nothing is defaulted.
const updateSchema = z
  .object({
    customerName: z.string().trim().min(1),
    phone: z.string().trim(),
    from: z.string().trim().min(1),
    to: z.array(z.string().trim().min(1)).min(1),
    drop: z.string().trim(),
    pickupTime: z.string().trim(),
    passengers: z.number().int().positive().nullish(),
    vehicleNo: z
      .string()
      .trim()
      .min(1)
      .transform(value => value.toUpperCase()),
    startDate: dateString,
    endDate: dateString,
    totalAmount: z.number().nonnegative(),
    advance: z.number().nonnegative(),
    advanceMode: paymentMode,
    notes: z.string(),
  })
  .partial();

/** Rules that involve two fields at once. */
const checkTrip = (trip: {
  startDate: string;
  endDate: string;
  totalAmount: number;
  advance: number;
}) => {
  if (trip.endDate < trip.startDate) {
    throw badRequest('End date cannot be before the start date');
  }
  if (trip.advance > trip.totalAmount) {
    throw badRequest('Advance cannot be more than the total amount');
  }
};

const recordHistory = (
  client: pg.PoolClient,
  row: any,
  action:
    | 'created'
    | 'updated'
    | 'cancelled'
    | 'restored'
    | 'completed'
    | 'reopened'
    | 'payment_received'
    | 'payment_pending',
  userId: string,
) =>
  client.query(
    `insert into trip_history (trip_id, company_id, action, changed_by, snapshot)
     values ($1, $2, $3, $4, $5)`,
    [row.id, row.company_id, action, userId, JSON.stringify(toTrip(row))],
  );

/* ---------------------------------- read ---------------------------------- */

const listSchema = z.object({
  from: dateString.optional(),
  to: dateString.optional(),
});

/**
 * GET /trips → all my company's trips, soonest first.
 * GET /trips?from=2026-11-01&to=2026-11-30 → only trips that touch that range
 * (a trip running 29 Oct – 2 Nov is included).
 */
router.get('/trips', async (req, res) => {
  const {from, to} = parse(listSchema, req.query);
  const {rows} = await pool.query(
    `select * from trips
      where company_id = $1
        and ($2::date is null or end_date >= $2::date)
        and ($3::date is null or start_date <= $3::date)
      order by start_date, created_at`,
    [req.user.companyId, from ?? null, to ?? null],
  );
  res.json(rows.map(toTrip));
});

/** GET /trips/:id */
router.get('/trips/:id', async (req, res) => {
  const id = parse(uuid, req.params.id);
  const {rows} = await pool.query(
    'select * from trips where id = $1 and company_id = $2',
    [id, req.user.companyId],
  );
  if (!rows[0]) {
    throw notFound('Trip');
  }
  res.json(toTrip(rows[0]));
});

/** Trip fields a person can change; compared to say what an edit changed. */
const TRACKED_FIELDS = [
  'customerName',
  'phone',
  'from',
  'to',
  'drop',
  'pickupTime',
  'passengers',
  'vehicleNo',
  'startDate',
  'endDate',
  'totalAmount',
  'advance',
  'advanceMode',
  'balanceMode',
  'notes',
] as const;

/** null, undefined and '' all mean "not set". */
const normalise = (value: unknown) =>
  value === undefined || value === null || value === '' ? null : value;

const sameValue = (a: unknown, b: unknown) =>
  JSON.stringify(normalise(a)) === JSON.stringify(normalise(b));

/** The tracked fields that differ between two trips, with both values. */
const diffTrips = (before: any, after: any) =>
  TRACKED_FIELDS.filter(field => !sameValue(before?.[field], after?.[field])).map(
    field => ({
      field,
      from: normalise(before?.[field]),
      to: normalise(after?.[field]),
    }),
  );

/**
 * GET /trips/:id/history → who changed it, when, and what changed, oldest
 * first. For an edit, `changes` lists each field with its old and new value
 * (worked out from the snapshot before it); other actions have none.
 */
router.get('/trips/:id/history', async (req, res) => {
  const id = parse(uuid, req.params.id);
  const {rows} = await pool.query(
    `select h.action, h.changed_at, h.snapshot,
            u.id as changed_by_id, u.name as changed_by, u.role as changed_by_role
       from trip_history h
       left join users u on u.id = h.changed_by
      where h.trip_id = $1 and h.company_id = $2
      order by h.changed_at, h.id`,
    [id, req.user.companyId],
  );
  res.json(
    rows.map((row, index) => ({
      action: row.action,
      changedAt: new Date(row.changed_at).getTime(),
      changedBy: row.changed_by,
      changedById: row.changed_by_id,
      changedByRole: row.changed_by_role,
      changes:
        row.action === 'updated' && index > 0
          ? diffTrips(rows[index - 1].snapshot, row.snapshot)
          : [],
      trip: row.snapshot,
    })),
  );
});

/* ---------------------------------- write --------------------------------- */

/**
 * POST /trips
 * If `clientId` was already used by this company, the existing trip is
 * returned (200) instead of creating a second one. That makes it safe for the
 * app to retry a save after a network failure.
 */
router.post('/trips', requireRole('owner', 'staff'), async (req, res) => {
  const input = parse(createSchema, req.body);
  checkTrip(input);

  const {created, row} = await transaction(async client => {
    const inserted = await client.query(
      `insert into trips
         (company_id, client_id, customer_name, phone, from_place, destinations,
          pickup_time, passengers, vehicle_no, start_date, end_date,
          total_amount, advance, advance_mode, notes,
          created_by, updated_by, drop_place)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
               $15, $16, $16, $17)
       on conflict (company_id, client_id) do nothing
       returning *`,
      [
        req.user.companyId,
        input.clientId ?? null,
        input.customerName,
        input.phone,
        input.from,
        input.to,
        input.pickupTime,
        input.passengers ?? null,
        input.vehicleNo,
        input.startDate,
        input.endDate,
        input.totalAmount,
        input.advance,
        input.advanceMode ?? null,
        input.notes,
        req.user.id,
        input.drop,
      ],
    );

    if (inserted.rows[0]) {
      await recordHistory(client, inserted.rows[0], 'created', req.user.id);
      return {created: true, row: inserted.rows[0]};
    }

    // Same clientId sent before: hand back the trip that was saved then.
    const existing = await client.query(
      'select * from trips where company_id = $1 and client_id = $2',
      [req.user.companyId, input.clientId],
    );
    return {created: false, row: existing.rows[0]};
  });

  res.status(created ? 201 : 200).json(toTrip(row));
});

/** PATCH /trips/:id → change only the fields that are sent */
router.patch('/trips/:id', requireRole('owner', 'staff'), async (req, res) => {
  const id = parse(uuid, req.params.id);
  const input = parse(updateSchema, req.body);

  const row = await transaction(async client => {
    // Lock the row so two people editing at once cannot interleave.
    const current = await client.query(
      'select * from trips where id = $1 and company_id = $2 for update',
      [id, req.user.companyId],
    );
    if (!current.rows[0]) {
      throw notFound('Trip');
    }
    const before = toTrip(current.rows[0]);
    const after = {...before, ...input};
    checkTrip(after);

    // Saving without changing anything is not an edit: nothing to log.
    if (diffTrips(before, after).length === 0) {
      return current.rows[0];
    }

    const updated = await client.query(
      `update trips
          set customer_name = $3, phone = $4, from_place = $5, destinations = $6,
              pickup_time = $7, passengers = $8, vehicle_no = $9,
              start_date = $10, end_date = $11, total_amount = $12,
              advance = $13, advance_mode = $14, balance_mode = $15, notes = $16,
              updated_by = $17, updated_at = now(), drop_place = $18
        where id = $1 and company_id = $2
        returning *`,
      [
        id,
        req.user.companyId,
        after.customerName,
        after.phone,
        after.from,
        after.to,
        after.pickupTime,
        after.passengers ?? null,
        after.vehicleNo,
        after.startDate,
        after.endDate,
        after.totalAmount,
        after.advance,
        after.advanceMode ?? null,
        after.balanceMode ?? null,
        after.notes,
        req.user.id,
        after.drop ?? '',
      ],
    );
    await recordHistory(client, updated.rows[0], 'updated', req.user.id);
    return updated.rows[0];
  });

  res.json(toTrip(row));
});

/** POST /trips/:id/cancel → mark as cancelled (it stays in the list) */
router.post(
  '/trips/:id/cancel',
  requireRole('owner', 'staff'),
  async (req, res) => {
    const id = parse(uuid, req.params.id);

    const row = await transaction(async client => {
      const current = await client.query(
        'select * from trips where id = $1 and company_id = $2 for update',
        [id, req.user.companyId],
      );
      if (!current.rows[0]) {
        throw notFound('Trip');
      }
      // Cancelling twice is harmless and is not logged twice.
      if (current.rows[0].cancelled) {
        return current.rows[0];
      }
      if (current.rows[0].completed_at) {
        throw badRequest(
          'This trip is completed. Undo the completion before cancelling it.',
        );
      }
      const updated = await client.query(
        `update trips
            set cancelled = true, updated_by = $3, updated_at = now()
          where id = $1 and company_id = $2
          returning *`,
        [id, req.user.companyId, req.user.id],
      );
      await recordHistory(client, updated.rows[0], 'cancelled', req.user.id);
      return updated.rows[0];
    });

    res.json(toTrip(row));
  },
);

/** POST /trips/:id/restore → undo a cancellation */
router.post(
  '/trips/:id/restore',
  requireRole('owner', 'staff'),
  async (req, res) => {
    const id = parse(uuid, req.params.id);

    const row = await transaction(async client => {
      const current = await client.query(
        'select * from trips where id = $1 and company_id = $2 for update',
        [id, req.user.companyId],
      );
      if (!current.rows[0]) {
        throw notFound('Trip');
      }
      // Restoring a trip that isn't cancelled changes nothing.
      if (!current.rows[0].cancelled) {
        return current.rows[0];
      }
      const updated = await client.query(
        `update trips
            set cancelled = false, updated_by = $3, updated_at = now()
          where id = $1 and company_id = $2
          returning *`,
        [id, req.user.companyId, req.user.id],
      );
      await recordHistory(client, updated.rows[0], 'restored', req.user.id);
      return updated.rows[0];
    });

    res.json(toTrip(row));
  },
);

/*
 * Trip dates are Kerala calendar dates, so "has the last day arrived?" is
 * answered in Indian time, whatever timezone the database server runs in.
 */
const TODAY_IN_INDIA = "(now() at time zone 'Asia/Kolkata')::date";

const completeSchema = z.object({
  /** false = undo a completion marked by mistake. */
  completed: z.boolean().default(true),
});

/**
 * POST /trips/:id/complete                    → mark the trip completed
 * POST /trips/:id/complete {completed: false} → undo
 * Only from the trip's last day on, and never for a cancelled trip.
 */
router.post(
  '/trips/:id/complete',
  requireRole('owner', 'staff'),
  async (req, res) => {
    const id = parse(uuid, req.params.id);
    const {completed} = parse(completeSchema, req.body ?? {});

    const row = await transaction(async client => {
      const current = await client.query(
        `select *, end_date <= ${TODAY_IN_INDIA} as last_day_reached
           from trips where id = $1 and company_id = $2 for update`,
        [id, req.user.companyId],
      );
      const trip = current.rows[0];
      if (!trip) {
        throw notFound('Trip');
      }
      // Already in the asked-for state: nothing to change or log.
      if ((trip.completed_at !== null) === completed) {
        return trip;
      }
      if (completed && trip.cancelled) {
        throw badRequest('A cancelled trip cannot be completed');
      }
      if (completed && !trip.last_day_reached) {
        throw badRequest(
          'This trip can be completed from its last day. Change the end date if it finished early.',
        );
      }

      const updated = await client.query(
        `update trips
            set completed_at = ${completed ? 'now()' : 'null'},
                completed_by = ${completed ? '$3::uuid' : 'null'},
                updated_by = $3, updated_at = now()
          where id = $1 and company_id = $2
          returning *`,
        [id, req.user.companyId, req.user.id],
      );
      await recordHistory(
        client,
        updated.rows[0],
        completed ? 'completed' : 'reopened',
        req.user.id,
      );
      return updated.rows[0];
    });

    res.json(toTrip(row));
  },
);

const paymentSchema = z.object({
  /** false = undo a payment marked by mistake. */
  received: z.boolean().default(true),
  /** How the balance was paid; optional. */
  balanceMode: z.enum(['Cash', 'UPI']).optional(),
});

/**
 * POST /trips/:id/payment {balanceMode?}    → balance received
 * POST /trips/:id/payment {received: false} → undo
 */
router.post(
  '/trips/:id/payment',
  requireRole('owner', 'staff'),
  async (req, res) => {
    const id = parse(uuid, req.params.id);
    const {received, balanceMode} = parse(paymentSchema, req.body ?? {});

    const row = await transaction(async client => {
      const current = await client.query(
        'select * from trips where id = $1 and company_id = $2 for update',
        [id, req.user.companyId],
      );
      const trip = current.rows[0];
      if (!trip) {
        throw notFound('Trip');
      }
      const mode = balanceMode ?? trip.balance_mode;
      // Already in the asked-for state: nothing to change or log.
      if (
        (trip.payment_received_at !== null) === received &&
        mode === trip.balance_mode
      ) {
        return trip;
      }
      if (received && trip.cancelled) {
        throw badRequest('A cancelled trip has no payment to receive');
      }
      const updated = await client.query(
        `update trips
            set payment_received_at = ${received ? 'now()' : 'null'},
                payment_received_by = ${received ? '$3::uuid' : 'null'},
                balance_mode = $4,
                updated_by = $3, updated_at = now()
          where id = $1 and company_id = $2
          returning *`,
        [id, req.user.companyId, req.user.id, mode ?? null],
      );
      await recordHistory(
        client,
        updated.rows[0],
        received ? 'payment_received' : 'payment_pending',
        req.user.id,
      );
      return updated.rows[0];
    });

    res.json(toTrip(row));
  },
);

export default router;
