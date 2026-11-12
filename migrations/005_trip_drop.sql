-- Optional drop place: where the customer is finally left, which may differ
-- from the last destination. Empty when not mentioned.
alter table trips add column drop_place text not null default '';
