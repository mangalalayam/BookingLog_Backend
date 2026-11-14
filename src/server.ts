import {createApp} from './app.ts';
import {config} from './config.ts';
import {pool} from './db.ts';
import {pruneFailures} from './throttle.ts';

const server = createApp().listen(config.port, () => {
  console.log(`BookingLog API listening on http://localhost:${config.port}`);
});

// Clear out failed-attempt counts whose 15 minutes have passed.
const prune = () => pruneFailures().catch(error => console.error(error));
prune();
setInterval(prune, 60 * 60 * 1000).unref();

// Finish in-flight requests, then close database connections.
const shutdown = () => {
  // Do not wait for ever on a request that will not finish.
  setTimeout(() => process.exit(1), 10_000).unref();
  server.close(() => {
    pool.end().finally(() => process.exit(0));
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
