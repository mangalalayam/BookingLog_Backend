import {pool} from './db.ts';

/*
 * Counts failed attempts (wrong password, wrong admin key) per key inside a
 * 15-minute window. Stored in the database, so the count survives a restart
 * and is shared when more than one server instance is running.
 */
const IN_WINDOW = "since > now() - interval '15 minutes'";

/** True when any key has reached its limit. `limits` maps key → max failures. */
export const isThrottled = async (limits: Record<string, number>) => {
  const {rows} = await pool.query(
    `select key, count from failed_attempts where key = any($1) and ${IN_WINDOW}`,
    [Object.keys(limits)],
  );
  return rows.some(row => row.count >= limits[row.key]);
};

/** Add one failure to each key (starting a new window if the old one ended). */
export const recordFailure = async (keys: string[]) => {
  await pool.query(
    `insert into failed_attempts as f (key, count, since)
     select k, 1, now() from unnest($1::text[]) as k
     on conflict (key) do update
        set count = case when f.${IN_WINDOW} then f.count + 1 else 1 end,
            since = case when f.${IN_WINDOW} then f.since else now() end`,
    [keys],
  );
};

export const clearFailures = async (keys: string[]) => {
  await pool.query('delete from failed_attempts where key = any($1)', [keys]);
};

/** Remove counts whose window has ended (run now and then by the server). */
export const pruneFailures = async () => {
  await pool.query(`delete from failed_attempts where not (${IN_WINDOW})`);
};

export const TOO_MANY_ATTEMPTS = 'Too many failed attempts. Try again in 15 minutes.';
