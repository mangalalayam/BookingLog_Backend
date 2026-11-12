-- A cancelled trip can be restored (cancellation undone); it is logged too.
alter table trip_history drop constraint trip_history_action_check;
alter table trip_history
  add constraint trip_history_action_check
  check (action in (
    'created', 'updated', 'cancelled', 'restored',
    'completed', 'reopened',
    'payment_received', 'payment_pending'
  ));
