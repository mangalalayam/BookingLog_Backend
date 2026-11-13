-- Passengers is optional in the app; a trip saved without it stores null.
alter table trips alter column passengers drop not null;
