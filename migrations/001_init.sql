-- BookingLog schema.
-- Every business row carries company_id, and every query filters on it,
-- so one tour company can never see another's data.

create table companies (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(trim(name)) > 0),
  -- Switched off by the provider (e.g. non-payment). Data is kept.
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create table users (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references companies(id),
  role           text not null check (role in ('owner', 'staff', 'driver')),
  name           text not null check (length(trim(name)) > 0),
  -- Bare 10-digit Indian mobile number; the login id.
  phone          text not null unique check (phone ~ '^[6-9][0-9]{9}$'),
  password_hash  text not null,
  active         boolean not null default true,
  created_at     timestamptz not null default now()
);
create index users_company_idx on users (company_id);

create table vehicles (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references companies(id),
  -- Stored upper-case, e.g. KL-05-AB-1234
  vehicle_no    text not null check (vehicle_no = upper(vehicle_no) and length(trim(vehicle_no)) > 0),
  name          text not null default '',
  type          text not null check (type in ('Car', 'SUV', 'Tempo Traveller', 'Mini Bus', 'Bus')),
  seats         integer not null check (seats > 0),
  driver_name   text not null default '',
  driver_phone  text not null default '',
  created_at    timestamptz not null default now(),
  unique (company_id, vehicle_no)
);

create table trips (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references companies(id),
  -- Id made up by the phone. Sending the same one twice (a retry on a bad
  -- network) returns the first trip instead of creating a duplicate.
  client_id      text,
  customer_name  text not null check (length(trim(customer_name)) > 0),
  phone          text not null default '',
  from_place     text not null check (length(trim(from_place)) > 0),
  -- Destinations in visiting order; at least one.
  destinations   text[] not null check (cardinality(destinations) >= 1),
  pickup_time    text not null default '',
  passengers     integer not null check (passengers > 0),
  vehicle_no     text not null check (vehicle_no = upper(vehicle_no)),
  -- Plain calendar dates: no time, no timezone, so a trip can never
  -- slide to the neighbouring day.
  start_date     date not null,
  end_date       date not null,
  total_amount   numeric(12, 2) not null default 0 check (total_amount >= 0),
  advance        numeric(12, 2) not null default 0 check (advance >= 0),
  advance_mode   text check (advance_mode in ('Cash', 'UPI')),
  balance_mode   text check (balance_mode in ('Cash', 'UPI')),
  notes          text not null default '',
  -- Trips are never deleted, only cancelled.
  cancelled      boolean not null default false,
  created_by     uuid references users(id),
  updated_by     uuid references users(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  check (end_date >= start_date),
  check (advance <= total_amount),
  unique (company_id, client_id)
);
create index trips_company_dates_idx on trips (company_id, start_date, end_date);

-- Who changed which trip, when, and what it looked like afterwards.
create table trip_history (
  id          bigint generated always as identity primary key,
  trip_id     uuid not null references trips(id),
  company_id  uuid not null references companies(id),
  action      text not null check (action in ('created', 'updated', 'cancelled')),
  changed_by  uuid references users(id),
  changed_at  timestamptz not null default now(),
  snapshot    jsonb not null
);
create index trip_history_trip_idx on trip_history (trip_id, changed_at);

-- Public holidays, maintained by the provider. Next year's rows are added
-- when the government publishes its list; no app release needed.
create table holidays (
  state  text not null default 'Kerala',
  date   date not null,
  name   text not null check (length(trim(name)) > 0),
  primary key (state, date)
);
