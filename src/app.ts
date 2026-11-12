import {fileURLToPath} from 'node:url';
import express from 'express';
import {pool} from './db.ts';
import {errorHandler} from './http.ts';
import adminRoutes from './routes/admin.ts';
import authRoutes from './routes/auth.ts';
import holidayRoutes from './routes/holidays.ts';
import memberRoutes from './routes/members.ts';
import tripRoutes from './routes/trips.ts';
import vehicleRoutes from './routes/vehicles.ts';

const adminPanelPath = fileURLToPath(
  new URL('./admin/panel.html', import.meta.url),
);

export const createApp = () => {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({limit: '200kb'}));

  /** GET /health → is the server up and can it reach the database? */
  app.get('/health', async (_req, res) => {
    await pool.query('select 1');
    res.json({ok: true});
  });

  /**
   * GET /admin-panel → a small web page for the provider. The page itself is
   * public; every action it takes calls /admin routes with the admin key.
   */
  app.get('/admin-panel', (_req, res) => {
    res.set({
      'cache-control': 'no-store',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
    });
    res.sendFile(adminPanelPath);
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
