import {Router} from 'express';
import {z} from 'zod';
import {requireRole, requireUser} from '../auth.ts';
import {pool} from '../db.ts';
import {conflict, notFound, parse, uuid} from '../http.ts';

const router = Router();
router.use('/vehicles', requireUser);

/** Database row → the shape the app's `Vehicle` type uses. */
const toVehicle = (row: any) => ({
  id: row.id,
  vehicleNo: row.vehicle_no,
  name: row.name,
  type: row.type,
  seats: row.seats,
  driverName: row.driver_name,
  driverPhone: row.driver_phone,
  createdAt: new Date(row.created_at).getTime(),
});

const vehicleSchema = z.object({
  vehicleNo: z
    .string()
    .trim()
    .min(1)
    .transform(value => value.toUpperCase()),
  name: z.string().trim().default(''),
  type: z.enum(['Car', 'SUV', 'Tempo Traveller', 'Mini Bus', 'Bus']),
  seats: z.number().int().positive(),
  driverName: z.string().trim().default(''),
  driverPhone: z.string().trim().default(''),
});

// For edits every field is optional and nothing is defaulted: a field that
// is not sent must keep its current value, not be reset to ''.
const vehicleUpdateSchema = z
  .object({
    vehicleNo: z
      .string()
      .trim()
      .min(1)
      .transform(value => value.toUpperCase()),
    name: z.string().trim(),
    type: z.enum(['Car', 'SUV', 'Tempo Traveller', 'Mini Bus', 'Bus']),
    seats: z.number().int().positive(),
    driverName: z.string().trim(),
    driverPhone: z.string().trim(),
  })
  .partial();

/** GET /vehicles → my company's vehicles */
router.get('/vehicles', async (req, res) => {
  const {rows} = await pool.query(
    'select * from vehicles where company_id = $1 order by created_at',
    [req.user.companyId],
  );
  res.json(rows.map(toVehicle));
});

/** POST /vehicles */
router.post('/vehicles', requireRole('owner', 'staff'), async (req, res) => {
  const input = parse(vehicleSchema, req.body);

  const taken = await pool.query(
    'select 1 from vehicles where company_id = $1 and vehicle_no = $2',
    [req.user.companyId, input.vehicleNo],
  );
  if (taken.rowCount) {
    throw conflict(`Vehicle ${input.vehicleNo} is already added`);
  }

  const {rows} = await pool.query(
    `insert into vehicles
       (company_id, vehicle_no, name, type, seats, driver_name, driver_phone)
     values ($1, $2, $3, $4, $5, $6, $7)
     returning *`,
    [
      req.user.companyId,
      input.vehicleNo,
      input.name,
      input.type,
      input.seats,
      input.driverName,
      input.driverPhone,
    ],
  );
  res.status(201).json(toVehicle(rows[0]));
});

/** PATCH /vehicles/:id → change any of the fields */
router.patch(
  '/vehicles/:id',
  requireRole('owner', 'staff'),
  async (req, res) => {
    const id = parse(uuid, req.params.id);
    const input = parse(vehicleUpdateSchema, req.body);

    if (input.vehicleNo) {
      const taken = await pool.query(
        'select 1 from vehicles where company_id = $1 and vehicle_no = $2 and id <> $3',
        [req.user.companyId, input.vehicleNo, id],
      );
      if (taken.rowCount) {
        throw conflict(`Vehicle ${input.vehicleNo} is already added`);
      }
    }

    const {rows} = await pool.query(
      `update vehicles
          set vehicle_no = coalesce($3, vehicle_no),
              name = coalesce($4, name),
              type = coalesce($5, type),
              seats = coalesce($6, seats),
              driver_name = coalesce($7, driver_name),
              driver_phone = coalesce($8, driver_phone)
        where id = $1 and company_id = $2
        returning *`,
      [
        id,
        req.user.companyId,
        input.vehicleNo ?? null,
        input.name ?? null,
        input.type ?? null,
        input.seats ?? null,
        input.driverName ?? null,
        input.driverPhone ?? null,
      ],
    );
    if (!rows[0]) {
      throw notFound('Vehicle');
    }
    res.json(toVehicle(rows[0]));
  },
);

/**
 * DELETE /vehicles/:id
 * Trips keep their own copy of the vehicle number, so removing a vehicle
 * never changes or loses past trips.
 */
router.delete('/vehicles/:id', requireRole('owner'), async (req, res) => {
  const id = parse(uuid, req.params.id);
  const result = await pool.query(
    'delete from vehicles where id = $1 and company_id = $2',
    [id, req.user.companyId],
  );
  if (!result.rowCount) {
    throw notFound('Vehicle');
  }
  res.status(204).end();
});

export default router;
