import {pool} from '../src/db.ts';
import {migrate} from '../src/migrate.ts';

// npm run migrate
try {
  const applied = await migrate();
  console.log(
    applied.length
      ? `Applied: ${applied.join(', ')}`
      : 'Database is already up to date.',
  );
} finally {
  await pool.end();
}
