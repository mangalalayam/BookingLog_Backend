import {fileURLToPath} from 'node:url';
import express from 'express';
import type {NextFunction, Request, Response} from 'express';
import {config} from './config.ts';
import {pool} from './db.ts';
import {ApiError, errorHandler} from './http.ts';
import adminRoutes from './routes/admin.ts';
import authRoutes from './routes/auth.ts';
import holidayRoutes from './routes/holidays.ts';
import memberRoutes from './routes/members.ts';
import tripRoutes from './routes/trips.ts';
import vehicleRoutes from './routes/vehicles.ts';

const adminPanelPath = fileURLToPath(
  new URL('./admin/panel.html', import.meta.url),
);

/**
 * Stops one IP address flooding the server. Counted in memory, per server
 * instance, in one-minute blocks; password guessing has its own stricter,
 * database-backed limit (see throttle.ts).
 */
const rateLimit = (perMinute: number) => {
  const hits = new Map<string, number>();
  setInterval(() => hits.clear(), 60_000).unref();

  return (req: Request, _res: Response, next: NextFunction) => {
    const key = req.ip ?? 'unknown';
    const count = (hits.get(key) ?? 0) + 1;
    hits.set(key, count);
    if (count > perMinute) {
      throw new ApiError(
        429,
        'TOO_MANY_REQUESTS',
        'Too many requests. Please wait a minute and try again.',
      );
    }
    next();
  };
};

/** One JSON line per finished request: what, who, the result, how long. */
const logRequests = (req: Request, res: Response, next: NextFunction) => {
  const started = Date.now();
  const path = req.path;
  res.on('finish', () => {
    console.log(
      JSON.stringify({
        time: new Date().toISOString(),
        method: req.method,
        path,
        status: res.statusCode,
        ms: Date.now() - started,
        ip: req.ip,
        user: req.user?.id,
      }),
    );
  });
  next();
};

export const createApp = (
  options: {rateLimitPerMinute?: number; logRequests?: boolean} = {},
) => {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  /** GET /health → is the server up and can it reach the database? */
  app.get('/health', async (_req, res) => {
    await pool.query('select 1');
    res.json({ok: true});
  });

  if (options.logRequests ?? config.logRequests) {
    app.use(logRequests);
  }
  app.use(rateLimit(options.rateLimitPerMinute ?? config.rateLimitPerMinute));
  app.use((_req, res, next) => {
    res.set('x-content-type-options', 'nosniff');
    next();
  });
  app.use(express.json({limit: '200kb'}));

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
