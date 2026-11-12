# BookingLog API

The server for the BookingLog app (the app itself lives in the sibling `BookingLog` folder): Node.js (Express) with PostgreSQL. Each tour
company's team shares the same trips, vehicles and calendar; one company can
never see another's data.

Needs Node.js 22.18 or newer (TypeScript runs directly, no build step) and
PostgreSQL.

## Run it locally

```bash
cd BookingLog-backend
npm install

# 1. Create the database (asks for your postgres password)
createdb -U postgres bookinglog

# 2. Create .env from the example, then set your postgres password and two secrets
cp .env.example .env

# 3. Create the tables and load the 2026 holidays
npm run migrate

# 4. Create your first tour company and its owner login
npm run create-company -- "ABC Travels" "Owner Name" 9876543210 secret123

# 5. Start the server (restarts when you edit a file)
npm run dev
```

Check it: open <http://localhost:4000/health>, which should show `{"ok":true}`.

## Who can do what

| Who | How they sign in | What they can do |
| --- | --- | --- |
| Provider (you) | `x-admin-key` header on `/admin/...` | Create, list, rename, suspend companies; manage any company's staff and drivers; maintain holidays |
| Owner | Phone + password | Everything in their company, including the team |
| Staff | Phone + password | Add, edit, cancel trips; add and edit vehicles |
| Driver | Phone + password | View only |

## Endpoints

Logged-in requests send the token from login in the `Authorization` header.
Errors come back as `{"error": {"code", "message", "details"}}`.

| Method and path | Purpose |
| --- | --- |
| `POST /auth/login` | `{phone, password}` → `{token, user}` |
| `POST /auth/refresh-token` | New token from a still-valid one |
| `GET /profile` | The logged-in user and company |
| `GET /trips` | All trips; `?from=YYYY-MM-DD&to=YYYY-MM-DD` for a date range |
| `GET /trips/:id` | One trip |
| `GET /trips/:id/history` | Who changed it and when |
| `POST /trips` | Create (send a `clientId` to make retries safe) |
| `PATCH /trips/:id` | Change only the fields sent |
| `POST /trips/:id/cancel` | Cancel (trips are never deleted) |
| `GET /vehicles`, `POST /vehicles`, `PATCH /vehicles/:id`, `DELETE /vehicles/:id` | Vehicles |
| `GET /members`, `POST /members`, `PATCH /members/:id` | Team (changes are owner-only) |
| `GET /holidays?year=2026` | Public holidays; no login needed |
| `POST /admin/companies`, `GET /admin/companies`, `PATCH /admin/companies/:id` | Provider: manage companies |
| `GET /admin/companies/:id/members`, `POST /admin/companies/:id/members`, `PATCH /admin/companies/:id/members/:memberId` | Provider: manage a company's team |
| `PUT /admin/holidays`, `DELETE /admin/holidays/:date` | Provider: maintain holidays |

Trips and vehicles use the same field names as the app's `Booking` and
`Vehicle` types.

## Adding next year's holidays

When the government publishes the list, send it once. Days that already exist
are renamed, not duplicated.

```bash
curl -X PUT http://localhost:4000/admin/holidays \
  -H "x-admin-key: YOUR_ADMIN_API_KEY" \
  -H "content-type: application/json" \
  -d '{"holidays":[{"date":"2027-01-26","name":"Republic Day"}]}'
```

## Tests

The tests run against a real database that is wiped on every run, so it must
be a separate one whose name ends in `_test`.

```bash
createdb -U postgres bookinglog_test
TEST_DATABASE_URL=postgres://postgres:PASSWORD@localhost:5432/bookinglog_test npm test
```

In PowerShell, set the variable first:
`$env:TEST_DATABASE_URL = "postgres://..."; npm test`

## Changing the database

Never edit a migration file that has already run. Add a new numbered file in
`migrations/` (for example `003_add_something.sql`) and run `npm run migrate`.
