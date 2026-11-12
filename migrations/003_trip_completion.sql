-- Trips are now marked completed by a person, and the balance is marked
-- received separately. Both store who did it and when; null = not yet.
alter table trips
  add column completed_at        timestamptz,
  add column completed_by        uuid references users(id),
  add column payment_received_at timestamptz,
  add column payment_received_by uuid references users(id);

-- A trip is either cancelled or completed, never both.
alter table trips
  add constraint trips_cancelled_or_completed
  check (not (cancelled and completed_at is not null));

alter table trip_history drop constraint trip_history_action_check;
alter table trip_history
  add constraint trip_history_action_check
  check (action in (
    'created', 'updated', 'cancelled',
    'completed', 'reopened',
    'payment_received', 'payment_pending'
  ));

-- Until now the app showed every finished trip as "Completed" by its dates.
-- Keep showing those trips that way rather than asking for each one again.
update trips
   set completed_at = updated_at
 where not cancelled
   and end_date < (now() at time zone 'Asia/Kolkata')::date;
