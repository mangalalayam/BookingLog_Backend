-- Kerala public holidays 2027, from G.O.(P) No. 22/2026/GAD dated 1 October 2026
-- (Kerala Gazette Extraordinary No. 2800, 18 October 2026).
-- The three Id/Muharram dates are subject to moon sighting; if one moves,
-- fix it with DELETE /admin/holidays/:date and PUT /admin/holidays.
insert into holidays (state, date, name) values
  ('Kerala', '2027-01-02', 'Mannam Jayanthi'),
  ('Kerala', '2027-01-26', 'Republic Day'),
  ('Kerala', '2027-03-06', 'Maha Sivarathri'),
  ('Kerala', '2027-03-10', 'Id-ul-Fitr (Ramzan)'),
  ('Kerala', '2027-03-25', 'Maundy Thursday'),
  ('Kerala', '2027-03-26', 'Good Friday'),
  ('Kerala', '2027-04-14', 'Dr. B. R. Ambedkar Jayanthi'),
  ('Kerala', '2027-04-15', 'Vishu'),
  ('Kerala', '2027-05-01', 'May Day'),
  ('Kerala', '2027-05-17', 'Id-ul-Adha (Bakrid)'),
  ('Kerala', '2027-06-15', 'Muharram'),
  ('Kerala', '2027-08-02', 'Karkadaka Vavu'),
  ('Kerala', '2027-08-24', 'Sreekrishna Jayanthi'),
  ('Kerala', '2027-08-28', 'Ayyankali Jayanthi'),
  ('Kerala', '2027-09-13', 'Third Onam'),
  ('Kerala', '2027-09-14', 'Fourth Onam'),
  ('Kerala', '2027-09-15', 'Sree Narayana Guru Jayanthi'),
  ('Kerala', '2027-09-22', 'Sree Narayana Guru Samadhi Day'),
  ('Kerala', '2027-10-02', 'Gandhi Jayanthi'),
  ('Kerala', '2027-10-28', 'Deepavali'),
  ('Kerala', '2027-12-25', 'Christmas')
on conflict (state, date) do update set name = excluded.name;
