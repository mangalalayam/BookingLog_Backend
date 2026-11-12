import pg from 'pg';
import {config} from './config.ts';

/*
 * By default `pg` turns a DATE column into a JS Date at local midnight, which
 * shifts to the previous day once it is serialised as UTC. Keep dates as the
 * plain 'YYYY-MM-DD' text Postgres sends.
 */
pg.types.setTypeParser(pg.types.builtins.DATE, value => value);
// NUMERIC arrives as text; amounts here are small enough for a JS number.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, value => Number(value));

export const pool = new pg.Pool({connectionString: config.databaseUrl});

export type Db = pg.Pool | pg.PoolClient;

/** Run `work` inside one transaction: everything commits, or nothing does. */
export const transaction = async <T>(
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> => {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await work(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
};
