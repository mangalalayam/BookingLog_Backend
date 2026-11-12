import {createApp} from './app.ts';
import {config} from './config.ts';
import {pool} from './db.ts';

const server = createApp().listen(config.port, () => {
  console.log(`BookingLog API listening on http://localhost:${config.port}`);
});

// Finish in-flight requests, then close database connections.
const shutdown = () => {
  server.close(() => {
    pool.end().finally(() => process.exit(0));
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
