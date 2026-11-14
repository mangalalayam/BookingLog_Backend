-- An owner can delete a team member. The row is kept (trip history still
-- shows who made each change) but marked deleted: it is hidden from the team
-- list and can never log in again.
alter table users add column deleted_at timestamptz;

-- A deleted member's phone number can be used for a new account.
alter table users drop constraint users_phone_key;
create unique index users_phone_key on users (phone) where deleted_at is null;
