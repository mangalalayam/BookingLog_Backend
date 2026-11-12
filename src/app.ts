import express from 'express';
import {pool} from './db.ts';
import {errorHandler} from './http.ts';
import adminRoutes from './routes/admin.ts';
import authRoutes from './routes/auth.ts';
import holidayRoutes from './routes/holidays.ts';
import memberRoutes from './routes/members.ts';
import tripRoutes from './routes/trips.ts';
import vehicleRoutes from './routes/vehicles.ts';

export const createApp = () => {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({limit: '200kb'}));

  /** GET /health → is the server up and can it reach the database? */
  app.get('/health', async (_req, res) => {
    await pool.query('select 1');
    res.json({ok: true});
  });

  app.use(authRoutes);
  app.use(holidayRoutes);
  app.use(adminRoutes);
  app.use(memberRoutes);
  app.use(vehicleRoutes);
  app.use(tripRoutes);

  app.use((_req, res) => {
    res
      .status(404)
      .json({error: {code: 'NOT_FOUND', message: 'No such endpoint'}});
  });
  app.use(errorHandler);

  return app;
};
