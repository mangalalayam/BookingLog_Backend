import {Router} from 'express';
import {z} from 'zod';
import {pool} from '../db.ts';
import {parse} from '../http.ts';

const router = Router();

const querySchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
  state: z.string().trim().min(1).default('Kerala'),
});

/**
 * GET /holidays?year=2026&state=Kerala → [{date, name}] in date order.
 * Public (no login): the list is not private and the app may load it early.
 * An empty list means that year has not been published yet.
 */
router.get('/holidays', async (req, res) => {
  const {year, state} = parse(querySchema, req.query);
  const {rows} = await pool.query(
    `select date, name from holidays
      where state = $1 and date >= make_date($2, 1, 1) and date <= make_date($2, 12, 31)
      order by date`,
    [state, year],
  );
  res.json(rows);
});

export default router;
