/*
 * End-to-end tests against a real PostgreSQL database.
 *
 *   createdb -U postgres bookinglog_test
 *   TEST_DATABASE_URL=postgres://postgres:PASSWORD@localhost:5432/bookinglog_test npm test
 *
 * The test database is WIPED on every run, so its name must end in "_test".
 */
import assert from 'node:assert/strict';
import type {Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {after, before, test} from 'node:test';

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  throw new Error('Set TEST_DATABASE_URL to run the tests (see top of file).');
}
if (!new URL(url).pathname.endsWith('_test')) {
  throw new Error('Refusing to run: the test database name must end in "_test".');
}
process.env.DATABASE_URL = url;
process.env.JWT_SECRET = 'test-secret';
process.env.ADMIN_API_KEY = 'test-admin-key';

// Imported after the environment is set, because config reads it on load.
const {pool} = await import('../src/db.ts');
const {migrate} = await import('../src/migrate.ts');
const {createApp} = await import('../src/app.ts');

let server: Server;
let base: string;

const call = async (
  method: string,
  path: string,
  options: {token?: string; admin?: boolean; body?: unknown} = {},
) => {
  const headers: Record<string, string> = {'content-type': 'application/json'};
  if (options.token) {
    headers.authorization = options.token;
  }
  if (options.admin) {
    headers['x-admin-key'] = 'test-admin-key';
  }
  const res = await fetch(base + path, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await res.text();
  return {status: res.status, body: text ? JSON.parse(text) : undefined};
};

const login = async (phone: string, password: string) => {
  const res = await call('POST', '/auth/login', {body: {phone, password}});
  assert.equal(res.status, 200);
  return res.body.token as string;
};

const trip = (overrides: object = {}) => ({
  customerName: 'Anil Kumar',
  phone: '9876543210',
  from: 'Kochi',
  to: ['Munnar', 'Thekkady'],
  pickupTime: '06:00 AM',
  passengers: 12,
  vehicleNo: 'kl-05-ab-1234',
  startDate: '2026-11-17',
  endDate: '2026-11-19',
  totalAmount: 25000,
  advance: 5000,
  advanceMode: 'UPI',
  notes: '',
  ...overrides,
});

// Shared across tests (they run in order).
let abcOwner: string;
let xyzOwner: string;
let abcStaff: string;
let abcDriver: string;
let abcCompanyId: string;
let tripId: string;

before(async () => {
  await pool.query('drop schema public cascade; create schema public;');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  await pool.end();
});

test('migrations are safe to run twice', async () => {
  assert.deepEqual(await migrate(), []);
});

test('admin routes need the admin key', async () => {
  const res = await call('GET', '/admin/companies');
  assert.equal(res.status, 401);
});

test('provider creates two companies with owners', async () => {
  const abc = await call('POST', '/admin/companies', {
    admin: true,
    body: {
      name: 'ABC Travels',
      owner: {name: 'Asha', phone: '+91 98470 00001', password: 'secret1'},
    },
  });
  assert.equal(abc.status, 201);
  assert.equal(abc.body.owner.phone, '9847000001');
  abcCompanyId = abc.body.company.id;

  const xyz = await call('POST', '/admin/companies', {
    admin: true,
    body: {
      name: 'XYZ Tours',
      owner: {name: 'Babu', phone: '9847000002', password: 'secret2'},
    },
  });
  assert.equal(xyz.status, 201);

  // Same phone cannot be used again.
  const dup = await call('POST', '/admin/companies', {
    admin: true,
    body: {
      name: 'Copy',
      owner: {name: 'X', phone: '9847000001', password: 'secret3'},
    },
  });
  assert.equal(dup.status, 409);
});

test('login works, wrong password does not', async () => {
  abcOwner = await login('9847000001', 'secret1');
  xyzOwner = await login('9847000002', 'secret2');

  const bad = await call('POST', '/auth/login', {
    body: {phone: '9847000001', password: 'nope'},
  });
  assert.equal(bad.status, 401);

  const profile = await call('GET', '/profile', {token: abcOwner});
  assert.equal(profile.body.company.name, 'ABC Travels');
  assert.equal(profile.body.role, 'owner');

  // "Bearer " prefix is accepted too.
  const bearer = await call('GET', '/profile', {token: `Bearer ${abcOwner}`});
  assert.equal(bearer.status, 200);

  const none = await call('GET', '/trips');
  assert.equal(none.status, 401);

  const refreshed = await call('POST', '/auth/refresh-token', {token: abcOwner});
  assert.equal(refreshed.status, 200);
  assert.ok(refreshed.body.token);
});

test('owner adds team members; staff cannot', async () => {
  const staff = await call('POST', '/members', {
    token: abcOwner,
    body: {name: 'Sibi', phone: '9847000003', password: 'secret3'},
  });
  assert.equal(staff.status, 201);
  assert.equal(staff.body.role, 'staff');

  const driver = await call('POST', '/members', {
    token: abcOwner,
    body: {name: 'Dev', phone: '9847000004', password: 'secret4', role: 'driver'},
  });
  assert.equal(driver.status, 201);

  abcStaff = await login('9847000003', 'secret3');
  abcDriver = await login('9847000004', 'secret4');

  const denied = await call('POST', '/members', {
    token: abcStaff,
    body: {name: 'Eve', phone: '9847000005', password: 'secret5'},
  });
  assert.equal(denied.status, 403);

  const list = await call('GET', '/members', {token: abcStaff});
  assert.equal(list.body.length, 3);
  assert.ok(!('password_hash' in list.body[0]));

  // The owner cannot demote themselves.
  const self = list.body.find((m: any) => m.role === 'owner');
  const demote = await call('PATCH', `/members/${self.id}`, {
    token: abcOwner,
    body: {role: 'staff'},
  });
  assert.equal(demote.status, 400);
});

test('vehicles: add, duplicate rejected, edit', async () => {
  const added = await call('POST', '/vehicles', {
    token: abcStaff,
    body: {vehicleNo: 'kl-05-ab-1234', name: 'Traveller', type: 'Tempo Traveller', seats: 17},
  });
  assert.equal(added.status, 201);
  assert.equal(added.body.vehicleNo, 'KL-05-AB-1234');
  assert.equal(typeof added.body.createdAt, 'number');

  const dup = await call('POST', '/vehicles', {
    token: abcStaff,
    body: {vehicleNo: 'KL-05-AB-1234', type: 'Bus', seats: 40},
  });
  assert.equal(dup.status, 409);

  const edited = await call('PATCH', `/vehicles/${added.body.id}`, {
    token: abcStaff,
    body: {seats: 20},
  });
  assert.equal(edited.body.seats, 20);
  assert.equal(edited.body.name, 'Traveller');

  // The other company may use the same number plate.
  const other = await call('POST', '/vehicles', {
    token: xyzOwner,
    body: {vehicleNo: 'KL-05-AB-1234', type: 'Bus', seats: 40},
  });
  assert.equal(other.status, 201);
});

test('trip is created and dates come back exactly as sent', async () => {
  const res = await call('POST', '/trips', {token: abcStaff, body: trip()});
  assert.equal(res.status, 201);
  tripId = res.body.id;

  assert.equal(res.body.startDate, '2026-11-17');
  assert.equal(res.body.endDate, '2026-11-19');
  assert.equal(res.body.vehicleNo, 'KL-05-AB-1234');
  assert.deepEqual(res.body.to, ['Munnar', 'Thekkady']);
  assert.equal(res.body.totalAmount, 25000);
  assert.equal(res.body.advance, 5000);
  assert.equal(res.body.advanceMode, 'UPI');
  assert.equal(res.body.cancelled, false);

  const fetched = await call('GET', `/trips/${tripId}`, {token: abcOwner});
  assert.equal(fetched.body.startDate, '2026-11-17');
});

test('bad trips are rejected', async () => {
  const cases: [object, string][] = [
    [{endDate: '2026-11-16'}, 'end before start'],
    [{startDate: '2026-02-30', endDate: '2026-03-01'}, 'date that does not exist'],
    [{startDate: '17-11-2026'}, 'wrong date format'],
    [{advance: 30000}, 'advance above total'],
    [{passengers: 0}, 'no passengers'],
    [{to: []}, 'no destination'],
    [{customerName: '   '}, 'blank customer'],
    [{advanceMode: 'Card'}, 'unknown payment mode'],
    [{totalAmount: -1}, 'negative amount'],
  ];
  for (const [overrides, label] of cases) {
    const res = await call('POST', '/trips', {token: abcStaff, body: trip(overrides)});
    assert.equal(res.status, 400, label);
  }
  const list = await call('GET', '/trips', {token: abcStaff});
  assert.equal(list.body.length, 1, 'nothing invalid was saved');
});

test('retrying a save with the same clientId does not duplicate', async () => {
  const body = trip({clientId: 'phone-abc-1', customerName: 'Retry Test', startDate: '2026-12-24', endDate: '2026-12-26'});
  const first = await call('POST', '/trips', {token: abcStaff, body});
  const second = await call('POST', '/trips', {token: abcStaff, body});
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(second.body.id, first.body.id);

  // Sent at the same moment (double tap / parallel retry).
  const parallel = trip({clientId: 'phone-abc-2', customerName: 'Parallel', startDate: '2027-01-02', endDate: '2027-01-02'});
  const results = await Promise.all(
    [1, 2, 3, 4].map(() => call('POST', '/trips', {token: abcStaff, body: parallel})),
  );
  assert.equal(new Set(results.map(r => r.body.id)).size, 1);

  const list = await call('GET', '/trips', {token: abcStaff});
  assert.equal(list.body.length, 3);
});

test('date range filter includes trips that overlap the range', async () => {
  const nov = await call('GET', '/trips?from=2026-11-19&to=2026-11-30', {token: abcStaff});
  assert.deepEqual(nov.body.map((t: any) => t.id), [tripId]);

  const before = await call('GET', '/trips?from=2026-11-01&to=2026-11-16', {token: abcStaff});
  assert.equal(before.body.length, 0);

  const bad = await call('GET', '/trips?from=nonsense', {token: abcStaff});
  assert.equal(bad.status, 400);
});

test('editing changes only the fields sent and re-checks the rules', async () => {
  const edited = await call('PATCH', `/trips/${tripId}`, {
    token: abcOwner,
    body: {endDate: '2026-11-20', advance: 8000},
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.endDate, '2026-11-20');
  assert.equal(edited.body.startDate, '2026-11-17');
  assert.equal(edited.body.advance, 8000);
  assert.equal(edited.body.customerName, 'Anil Kumar');

  // Only the start moves, past the existing end date.
  const bad = await call('PATCH', `/trips/${tripId}`, {
    token: abcOwner,
    body: {startDate: '2026-11-25'},
  });
  assert.equal(bad.status, 400);

  const still = await call('GET', `/trips/${tripId}`, {token: abcOwner});
  assert.equal(still.body.startDate, '2026-11-17');
});

test('one company cannot see or touch another company’s trips', async () => {
  const list = await call('GET', '/trips', {token: xyzOwner});
  assert.equal(list.body.length, 0);

  assert.equal((await call('GET', `/trips/${tripId}`, {token: xyzOwner})).status, 404);
  assert.equal(
    (await call('PATCH', `/trips/${tripId}`, {token: xyzOwner, body: {notes: 'hacked'}})).status,
    404,
  );
  assert.equal((await call('POST', `/trips/${tripId}/cancel`, {token: xyzOwner})).status, 404);
  assert.equal((await call('GET', `/trips/${tripId}/history`, {token: xyzOwner})).body.length, 0);

  const members = await call('GET', '/members', {token: xyzOwner});
  assert.equal(members.body.length, 1);
});

test('drivers can view but not change', async () => {
  assert.equal((await call('GET', '/trips', {token: abcDriver})).status, 200);
  assert.equal((await call('POST', '/trips', {token: abcDriver, body: trip()})).status, 403);
  assert.equal(
    (await call('PATCH', `/trips/${tripId}`, {token: abcDriver, body: {notes: 'x'}})).status,
    403,
  );
  assert.equal((await call('POST', `/trips/${tripId}/cancel`, {token: abcDriver})).status, 403);
});

test('cancel keeps the trip, and history records every change', async () => {
  const cancelled = await call('POST', `/trips/${tripId}/cancel`, {token: abcStaff});
  assert.equal(cancelled.body.cancelled, true);
  // Cancelling again changes nothing.
  await call('POST', `/trips/${tripId}/cancel`, {token: abcStaff});

  const list = await call('GET', '/trips', {token: abcStaff});
  assert.ok(list.body.some((t: any) => t.id === tripId && t.cancelled));

  const history = await call('GET', `/trips/${tripId}/history`, {token: abcOwner});
  assert.deepEqual(
    history.body.map((h: any) => [h.action, h.changedBy]),
    [
      ['created', 'Sibi'],
      ['updated', 'Asha'],
      ['cancelled', 'Sibi'],
    ],
  );
  assert.equal(history.body[0].trip.endDate, '2026-11-19');
  assert.equal(history.body[1].trip.endDate, '2026-11-20');

  // Each entry says the editor's role, and an edit lists what it changed.
  assert.deepEqual(
    history.body.map((h: any) => h.changedByRole),
    ['staff', 'owner', 'staff'],
  );
  assert.deepEqual(history.body[1].changes, [
    {field: 'endDate', from: '2026-11-19', to: '2026-11-20'},
    {field: 'advance', from: 5000, to: 8000},
  ]);
  assert.deepEqual(history.body[0].changes, []);
  assert.deepEqual(history.body[2].changes, []);
});

test('saving a trip without changing anything is not logged as an edit', async () => {
  const created = await call('POST', '/trips', {token: abcStaff, body: trip()});
  const id = created.body.id;
  const same = await call('PATCH', `/trips/${id}`, {
    token: abcStaff,
    // Everything as saved (vehicle in lower case, empty drop) = no change.
    body: {...trip(), drop: ''},
  });
  assert.equal(same.status, 200);
  assert.equal(same.body.updatedAt, created.body.updatedAt);

  await call('PATCH', `/trips/${id}`, {
    token: abcOwner,
    body: {to: ['Munnar'], passengers: null},
  });
  const history = await call('GET', `/trips/${id}/history`, {token: abcStaff});
  assert.deepEqual(
    history.body.map((h: any) => h.action),
    ['created', 'updated'],
  );
  assert.deepEqual(history.body[1].changes, [
    {field: 'to', from: ['Munnar', 'Thekkady'], to: ['Munnar']},
    {field: 'passengers', from: 12, to: null},
  ]);
});

test('there is no way to delete a trip', async () => {
  const res = await call('DELETE', `/trips/${tripId}`, {token: abcOwner});
  assert.equal(res.status, 404);
  assert.equal((await call('GET', `/trips/${tripId}`, {token: abcOwner})).status, 200);
});

test('a trip is completed from its last day, and can be undone', async () => {
  const past = await call('POST', '/trips', {
    token: abcStaff,
    body: trip({customerName: 'Past Trip', startDate: '2026-01-05', endDate: '2026-01-06'}),
  });
  const future = await call('POST', '/trips', {
    token: abcStaff,
    body: trip({customerName: 'Future Trip', startDate: '2099-01-05', endDate: '2099-01-06'}),
  });
  assert.equal(past.body.completed, false);

  // Not before the last day.
  const early = await call('POST', `/trips/${future.body.id}/complete`, {token: abcStaff});
  assert.equal(early.status, 400);

  // Not for a cancelled trip, and drivers cannot.
  assert.equal((await call('POST', `/trips/${tripId}/complete`, {token: abcStaff})).status, 400);
  assert.equal(
    (await call('POST', `/trips/${past.body.id}/complete`, {token: abcDriver})).status,
    403,
  );

  const done = await call('POST', `/trips/${past.body.id}/complete`, {token: abcStaff});
  assert.equal(done.status, 200);
  assert.equal(done.body.completed, true);
  assert.equal(typeof done.body.completedAt, 'number');
  // Marking again changes nothing and is not logged twice.
  await call('POST', `/trips/${past.body.id}/complete`, {token: abcStaff});

  // A completed trip cannot be cancelled until the completion is undone.
  assert.equal((await call('POST', `/trips/${past.body.id}/cancel`, {token: abcOwner})).status, 400);

  const undone = await call('POST', `/trips/${past.body.id}/complete`, {
    token: abcOwner,
    body: {completed: false},
  });
  assert.equal(undone.body.completed, false);

  const history = await call('GET', `/trips/${past.body.id}/history`, {token: abcOwner});
  assert.deepEqual(
    history.body.map((h: any) => h.action),
    ['created', 'completed', 'reopened'],
  );
});

test('balance payment is marked separately; payment mode is optional', async () => {
  const created = await call('POST', '/trips', {
    token: abcStaff,
    // A balance mode sent at booking is ignored; it is set only on payment.
    body: trip({
      customerName: 'Pay Later',
      startDate: '2026-02-01',
      endDate: '2026-02-01',
      balanceMode: 'UPI',
    }),
  });
  const id = created.body.id;
  assert.equal(created.body.paymentReceived, false);
  assert.equal(created.body.balanceMode, undefined);

  // No payment mode is needed to mark the payment received.
  const noMode = await call('POST', `/trips/${id}/payment`, {token: abcStaff});
  assert.equal(noMode.status, 200);
  assert.equal(noMode.body.paymentReceived, true);
  assert.equal(noMode.body.balanceMode, undefined);
  await call('POST', `/trips/${id}/payment`, {token: abcStaff, body: {received: false}});
  assert.equal(
    (await call('POST', `/trips/${id}/payment`, {token: abcDriver, body: {balanceMode: 'Cash'}})).status,
    403,
  );

  const paid = await call('POST', `/trips/${id}/payment`, {
    token: abcStaff,
    body: {balanceMode: 'Cash'},
  });
  assert.equal(paid.status, 200);
  assert.equal(paid.body.paymentReceived, true);
  assert.equal(paid.body.balanceMode, 'Cash');
  // Payment does not complete the trip; the two are separate.
  assert.equal(paid.body.completed, false);

  const undone = await call('POST', `/trips/${id}/payment`, {
    token: abcOwner,
    body: {received: false},
  });
  assert.equal(undone.body.paymentReceived, false);
  // The chosen mode is kept for next time.
  assert.equal(undone.body.balanceMode, 'Cash');

  const history = await call('GET', `/trips/${id}/history`, {token: abcOwner});
  assert.deepEqual(
    history.body.map((h: any) => h.action),
    ['created', 'payment_received', 'payment_pending', 'payment_received', 'payment_pending'],
  );
});

test('a cancelled trip can be restored, and it is logged', async () => {
  // tripId was cancelled by an earlier test.
  assert.equal(
    (await call('POST', `/trips/${tripId}/restore`, {token: abcDriver})).status,
    403,
  );
  assert.equal(
    (await call('POST', `/trips/${tripId}/restore`, {token: xyzOwner})).status,
    404,
  );

  const restored = await call('POST', `/trips/${tripId}/restore`, {token: abcOwner});
  assert.equal(restored.status, 200);
  assert.equal(restored.body.cancelled, false);
  // Restoring again changes nothing and is not logged twice.
  await call('POST', `/trips/${tripId}/restore`, {token: abcOwner});

  const history = await call('GET', `/trips/${tripId}/history`, {token: abcOwner});
  assert.deepEqual(
    history.body.slice(-2).map((h: any) => h.action),
    ['cancelled', 'restored'],
  );
});

test('holidays: 2026 is seeded, next year can be added later', async () => {
  const y2026 = await call('GET', '/holidays?year=2026');
  assert.equal(y2026.status, 200);
  assert.equal(y2026.body.length, 22);
  assert.deepEqual(y2026.body[0], {date: '2026-01-02', name: 'Mannam Jayanthi'});

  assert.deepEqual((await call('GET', '/holidays?year=2027')).body, []);

  const denied = await call('PUT', '/admin/holidays', {
    token: abcOwner,
    body: {holidays: [{date: '2027-01-26', name: 'Republic Day'}]},
  });
  assert.equal(denied.status, 401);

  const saved = await call('PUT', '/admin/holidays', {
    admin: true,
    body: {
      holidays: [
        {date: '2027-01-26', name: 'Republic Day'},
        {date: '2027-08-15', name: 'Independence Day'},
      ],
    },
  });
  assert.equal(saved.body.saved, 2);

  // Sending the same list again renames instead of duplicating.
  await call('PUT', '/admin/holidays', {
    admin: true,
    body: {holidays: [{date: '2027-01-26', name: 'Republic Day (renamed)'}]},
  });
  const y2027 = await call('GET', '/holidays?year=2027');
  assert.deepEqual(y2027.body, [
    {date: '2027-01-26', name: 'Republic Day (renamed)'},
    {date: '2027-08-15', name: 'Independence Day'},
  ]);

  assert.equal((await call('DELETE', '/admin/holidays/2027-08-15', {admin: true})).status, 204);
  assert.equal((await call('GET', '/holidays?year=2027')).body.length, 1);
});

test('deactivated member and suspended company lose access at once', async () => {
  const members = await call('GET', '/members', {token: abcOwner});
  const driver = members.body.find((m: any) => m.role === 'driver');
  await call('PATCH', `/members/${driver.id}`, {token: abcOwner, body: {active: false}});
  assert.equal((await call('GET', '/trips', {token: abcDriver})).status, 401);

  const suspended = await call('PATCH', `/admin/companies/${abcCompanyId}`, {
    admin: true,
    body: {active: false},
  });
  assert.equal(suspended.body.active, false);
  assert.equal((await call('GET', '/trips', {token: abcOwner})).status, 403);
  const relogin = await call('POST', '/auth/login', {
    body: {phone: '9847000001', password: 'secret1'},
  });
  assert.equal(relogin.status, 403);

  // Restoring brings everything back; no data was lost.
  await call('PATCH', `/admin/companies/${abcCompanyId}`, {admin: true, body: {active: true}});
  // 4 from the earlier trip tests + 3 from the completion/payment tests.
  const list = await call('GET', '/trips', {token: abcOwner});
  assert.equal(list.body.length, 7);

  const companies = await call('GET', '/admin/companies', {admin: true});
  const abc = companies.body.find((c: any) => c.id === abcCompanyId);
  assert.equal(abc.members, 3);
  assert.equal(abc.trips, 7);
});

test('provider manages a company team from the admin panel', async () => {
  const path = `/admin/companies/${abcCompanyId}/members`;
  assert.equal((await call('GET', path)).status, 401);

  const added = await call('POST', path, {
    admin: true,
    body: {name: 'Manu', phone: '9847000099', password: 'driver9', role: 'driver'},
  });
  assert.equal(added.status, 201);
  assert.equal(added.body.role, 'driver');
  await login('9847000099', 'driver9');

  const dup = await call('POST', path, {
    admin: true,
    body: {name: 'Copy', phone: '9847000099', password: 'driver9'},
  });
  assert.equal(dup.status, 409);

  const list = await call('GET', path, {admin: true});
  assert.ok(list.body.some((m: any) => m.id === added.body.id));

  // Reset password and promote to staff.
  const updated = await call('PATCH', `${path}/${added.body.id}`, {
    admin: true,
    body: {role: 'staff', password: 'newpass1'},
  });
  assert.equal(updated.body.role, 'staff');
  await login('9847000099', 'newpass1');

  // The last active owner cannot be disabled or demoted.
  const owner = list.body.find((m: any) => m.role === 'owner');
  const lockout = await call('PATCH', `${path}/${owner.id}`, {
    admin: true,
    body: {active: false},
  });
  assert.equal(lockout.status, 400);

  // A member id from another company is not found here.
  const other = await call('GET', '/members', {token: xyzOwner});
  const foreign = await call('PATCH', `${path}/${other.body[0].id}`, {
    admin: true,
    body: {name: 'Hijack'},
  });
  assert.equal(foreign.status, 404);

  const missing = await call('GET', '/admin/companies/00000000-0000-0000-0000-000000000000/members', {admin: true});
  assert.equal(missing.status, 404);
});
