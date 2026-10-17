# Appeal EyeQ

Matter management for property tax appeal attorneys: properties, annual appeal cycles, filing windows, decisions, savings, fees and invoices. Multi-tenant; each firm's data is isolated by the database itself.

The product spec and build plan live in the Claude Project as `claude/appeal-eyeq-spec.md`.

## Layout

- `server/` Express API (TypeScript). `server/migrate.ts` runs migrations at startup.
- `web/` React + Vite app, built into `dist/web` and served by the API.
- `shared/` Code used by both, including the exact-decimal tax math (`shared/money.ts`).
- `db/migrations/` Numbered SQL migrations. Never edit a shipped one; add a new file.
- `db/seed/sample/` Sample data for the demo firm "Nichols Law". Sample only.
- `tests/` Unit, integration (real Postgres + real server) and end-to-end (Chromium) tests.

## How tenant isolation works

Every request runs in a transaction that sets `app.actor_kind`, `app.user_id` and `app.firm_id`. Row-level security on every firm table only allows rows for `app_current_firm()`, which re-checks the user's own firm (or, for the super admin, an active support grant). Relationships use composite `(firm_id, id)` foreign keys, so a record can never point at another firm's record. See `db/migrations/001_foundation.sql`.

Any future migration that changes firm data must set a `system` context for that firm first, or the audit trigger and row-level security will refuse the change.

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Yes | Postgres connection string (Render: the database's Internal Database URL) |
| `SUPER_ADMIN_EMAIL` | First deploy | Creates the super admin once, if none exists |
| `SUPER_ADMIN_PASSWORD` | First deploy | At least 10 characters. Remove both after the first deploy if you like |
| `SEED_SAMPLE_DATA` | No | `true` loads the Nichols Law sample firm once. Never on an instance with real clients |
| `SAMPLE_USER_PASSWORD` | With seed | Password for the four sample users (at least 10 characters) |
| `NODE_ENV` | Recommended | `production` on Render (secure cookies) |

## Local development

```bash
npm install
cp .env.example .env            # then edit
export $(grep -v '^#' .env | xargs)
npm run build && npm start      # migrations + server on :3000
# or, while editing: npm run dev:server and npm run dev:web (Vite on :5173)
```

## Tests

```bash
# Unit + integration. TEST_DATABASE_URL must point at a throwaway database owned
# by a NON-superuser role (superusers bypass row-level security).
TEST_DATABASE_URL=postgres://appeal:appeal@localhost/appeal_test npm test

# End-to-end in Chromium against the built app (wipes E2E_DATABASE_URL each run).
npm run build
E2E_DATABASE_URL=postgres://appeal:appeal@localhost/appeal_e2e npm run test:e2e
```
