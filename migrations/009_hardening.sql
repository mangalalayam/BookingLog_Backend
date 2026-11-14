-- Changing a password adds one to this; a login token made for an older
-- number stops working, so a stolen token dies with the old password.
alter table users add column token_version integer not null default 0;

-- Failed logins and failed admin-key attempts, counted per key (a phone, an
-- IP address, or both) inside a 15-minute window. Kept in the database so the
-- count survives a restart and is shared by every server instance.
create table failed_attempts (
  key    text primary key,
  count  integer not null,
  since  timestamptz not null default now()
);

-- Every change made through /admin (not reads): what, when, from where.
create table admin_log (
  id      bigint generated always as identity primary key,
  at      timestamptz not null default now(),
  method  text not null,
  path    text not null,
  status  integer not null,
  ip      text
);

-- For GET /trips?updatedSince=... (the app fetching only what changed).
create index trips_company_updated_idx on trips (company_id, updated_at);
