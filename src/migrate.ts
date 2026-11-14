import fs from 'node:fs';
import path from 'node:path';
import {transaction} from './db.ts';

const MIGRATIONS_DIR = path.join(import.meta.dirname, '..', 'migrations');

/**
 * Applies every .sql file in migrations/ that has not run yet, in
 * file-name order. Each file runs in its own transaction, and is recorded in
 * schema_migrations so it never runs twice. Returns the files it applied.
 *
 * Never edit a migration that has already run; add a new numbered file.
 */
export const migrate = async (): Promise<string[]> => {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter(file => file.endsWith('.sql'))
    .sort();

  const applied: string[] = [];
  for (const file of files) {
    const ran = await transaction(async client => {
      // A migration may take longer than a normal request is allowed to.
      await client.query('set local statement_timeout = 0');
      await client.query(
        `create table if not exists schema_migrations (
           name text primary key,
           applied_at timestamptz not null default now()
         )`,
      );
      // One migrator at a time.
      await client.query('lock table schema_migrations in exclusive mode');
      const done = await client.query(
        'select 1 from schema_migrations where name = $1',
        [file],
      );
      if (done.rowCount) {
        return false;
      }
      await client.query(
        fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'),
      );
      await client.query('insert into schema_migrations (name) values ($1)', [
        file,
      ]);
      return true;
    });
    if (ran) {
      applied.push(file);
    }
  }
  return applied;
};
