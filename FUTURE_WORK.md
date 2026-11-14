# Future work

Things the backend still needs that could not be done in code alone. Each
needs a decision, an account on another service, or a change in the app.
Most urgent first. Delete an item when it is done.

## 1. Check after the next deploy

- **Run `npm run migrate` on the live database before (or with) the deploy.**
  Migration `009_hardening.sql` adds a column that login now reads; without
  it nobody can log in.
- **Check the server sees real IP addresses.** Rate limits are per IP address.
  On Railway the server trusts one proxy (`TRUST_PROXY`, default 1 there). Open
  the app once, then look at the Railway logs: the `ip` in the request lines
  must be your own public address, not the same internal address for
  everyone. If it is the same for everyone, 40 wrong passwords from all users
  together would lock every login for 15 minutes; fix `TRUST_PROXY` first.

## 2. Backups (do this now; nothing in the code covers it)

Trips must never be lost, but the only copy is the live database.

- Turn on scheduled backups for the Railway PostgreSQL service.
- Once, restore a backup into a spare database and open it, to prove it works.
- Decide how much loss is acceptable (a day? an hour?) and set the schedule
  to match.

## 3. The app should stop loading every trip

`GET /trips` with no parameters still returns every trip a company has ever
had, because the current app depends on that. Trips are never deleted, so
this gets slower every month.

The server already supports the fix:

- `GET /trips?updatedSince=<newest updatedAt held>` returns only trips
  created or changed since then.
- `GET /trips?from=...&to=...` returns one date range.
- `GET /trips?limit=100&offset=0` returns one page.

To do in the app (`BookingLog/src/config/api/services/tripsService.ts`): keep
the trips already loaded, and ask only for what changed. When every installed
app version does this, make the server refuse a `GET /trips` that has no
`limit`, range or `updatedSince`.

## 4. Logins

- **Sessions never end.** A token lasts 30 days and can be swapped for a new
  one for ever. A stolen token can now be killed by changing that member's
  password, but there is no time limit. Decide on one (for example: log in
  again every 90 days) and add a `POST /auth/logout`.
- **Changing your own password logs you out too.** Fine today, because the
  app has no change-password screen. When one is added, return a fresh token
  from that request.
- **Passwords need only 6 characters.** Raising the minimum affects how
  owners set staff passwords, so it is a product decision.
- **A member can still be locked out by someone else:** 30 wrong passwords
  for one phone number, from several IP addresses, blocks that number for 15
  minutes. Login by OTP to the phone would remove the problem.

## 5. Provider (admin) access

- Everything under `/admin` is protected by one shared key. Give each person
  who needs it their own login, with a second factor.
- Until then: keep `ADMIN_API_KEY` long and random (48 bytes, see
  `.env.example`) and change it whenever someone who knew it leaves.
- The `admin_log` table records every admin change but nothing reads it yet.
  Add a view of it to the admin panel.

## 6. Knowing when something breaks

- The server prints one line per request and every error to the Railway logs,
  but nobody is told. Add an error-reporting service (Sentry or similar) and
  an uptime check on `/health` that alerts you.
- Run the tests automatically on every push (GitHub Actions with a
  PostgreSQL service), so a broken change cannot be deployed unnoticed.

## 7. When one server is no longer enough

- The general rate limit (300 requests a minute per IP address) is counted in
  memory, per server. With two servers each allows 300. Move it to the
  database or Redis when a second instance is added. The password-guessing
  limits are already in the database and need no change.
- Each server opens up to 10 database connections (`DB_POOL_MAX`). Check the
  database's connection limit before adding servers; add a connection pooler
  (PgBouncer) if it gets close.
- `trip_history` and `admin_log` grow for ever. That is fine for years at the
  current size; revisit if the database gets large.
