# Auth Development Runbook

This document describes the auth implementation that exists in the repo today and how to run it locally.

## Current v1 scope

- Auth routes live under `src/server/routes/auth.ts`.
- Session and token helpers live in `src/server/auth.ts`.
- Auth persistence and email issuance live in `src/server/services/auth.service.ts`.
- Verification and password reset delivery are handled by `src/server/email.ts`.
- Auth maintenance cleanup runs from `src/server/jobs/auth-cleanup.ts`.

The current implementation is intentionally limited to first-party email/password auth, server-side sessions, email verification, password reset, and basic moderation state.

## What is intentionally deferred

- Provider-specific SDK work is intentionally avoided. Production email delivery should go through a standard SMTP relay.
- Mailtrap is the initial expected provider, but the app stays provider-agnostic because it only depends on SMTP settings.
- Caddy host canonicalization is also deferred. No `docker/Caddyfile` host redirect changes are included here.

## Required local configuration

Local auth only needs the same core database and frontend-origin settings the app already uses:

```dotenv
DATABASE_URL=postgresql://pginbox:pginbox@localhost:5499/pginbox?sslmode=disable
APP_BASE_URL=http://localhost:5173
AUTH_EMAIL_MODE=log
SMTP_HOST=
SMTP_PORT=
SMTP_SECURE=false
SMTP_USER=
SMTP_PASS=
SMTP_FROM_EMAIL=
SMTP_FROM_NAME=
```

Notes:

- `DATABASE_URL` points the API and cleanup task at Postgres.
- `APP_BASE_URL` must match the frontend origin used in development. Mutating auth routes validate `Origin` against this value.
- `AUTH_EMAIL_MODE` controls local verification behavior:
  - `log` logs verification and reset links.
  - `dev-auto-verify` still logs the verification link, but `register` and `resend-verification` also return a dev-only verification URL so the frontend can route through the normal `/verify-email` page and hit the real `/auth/verify-email` endpoint automatically.
- `AUTH_EMAIL_MODE=smtp` enables real email delivery through a standard SMTP relay.
- `APP_BASE_URL` is required when `AUTH_EMAIL_MODE=smtp`, because those email links must point at the real frontend origin.
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, and `SMTP_FROM_EMAIL` are required when `AUTH_EMAIL_MODE=smtp`.
- `SMTP_FROM_NAME` is optional.
- `SMTP_SECURE` defaults to `false`; set it to `true` when your provider expects implicit TLS.
- `APP_BASE_URL` defaults to `http://localhost:5173/` if unset.
- `DATABASE_URL` defaults to `postgresql://pginbox:pginbox@localhost:5499/pginbox` if unset.
- `NODE_ENV=production` only affects whether the session cookie is marked `Secure`.
- No `SMTP_*` variables are required for `log` or `dev-auto-verify`.

`.env.template` includes the minimal local auth configuration.

## Local startup

From the repo root:

1. Start Postgres:

   ```bash
   make up
   ```

2. Apply migrations:

   ```bash
   make migrate
   ```

3. Start the API:

   ```bash
   make api
   ```

4. Start the frontend in a second terminal:

   ```bash
   cd src/frontend
   npm install
   npm run dev
   ```

Local endpoints:

- Frontend: `http://localhost:5173`
- API direct: `http://localhost:3000`
- API via Vite proxy: `http://localhost:5173/api`

The frontend already bootstraps auth state with `GET /api/auth/me` and includes dedicated auth pages. In `AUTH_EMAIL_MODE=dev-auto-verify`, the easiest way to verify the full registration flow is through the browser because the UI automatically continues through the same verification page that real emailed links use.

## Development mail stub

When `AUTH_EMAIL_MODE=log` or `AUTH_EMAIL_MODE=dev-auto-verify`, verification and reset emails are not sent to a real SMTP server. The server logs the generated links instead.

Look for log lines like:

```text
[auth:dev-mail] verification email for user@example.com (2026-03-16T12:00:00.000Z): http://localhost:5173/verify-email?token=...
[auth:dev-mail] password reset email for user@example.com (2026-03-15T13:00:00.000Z): http://localhost:5173/reset-password?token=...
```

Those URLs are still useful for direct API testing. Extract the `token` query param and send it to the API endpoints shown below.

If `AUTH_EMAIL_MODE=dev-auto-verify`, registration and resend flows also include `developmentVerificationUrl` in the JSON response. The frontend uses that URL to navigate through `/verify-email?token=...`, which then calls the normal `POST /auth/verify-email` endpoint and establishes the session cookie.

## SMTP delivery

When `AUTH_EMAIL_MODE=smtp`, auth mail is sent through a standard SMTP relay. The code does not use a provider-specific API, so switching away from Mailtrap later only requires different `SMTP_*` values.

Recommended initial production setup:

- `AUTH_EMAIL_MODE=smtp`
- `APP_BASE_URL=https://pginbox.dev` (or your real frontend origin)
- Mailtrap SMTP credentials in `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`
- a verified sender in `SMTP_FROM_EMAIL`
- optional display name in `SMTP_FROM_NAME`

The app sends multipart text+HTML verification and password-reset emails with the existing frontend URLs, so there is no provider-side template requirement.

## Verifying auth locally

All mutating auth routes require a same-origin `Origin` header. If you use `curl` directly against `http://localhost:3000`, include:

```bash
-H 'Origin: http://localhost:5173'
```

### Register

```bash
curl -i http://localhost:3000/auth/register \
  -X POST \
  -H 'Origin: http://localhost:5173' \
  -H 'Content-Type: application/json' \
  --data '{"email":"dev-auth@example.com","password":"correct horse battery staple","displayName":"Dev Auth"}'
```

Expected result:

- HTTP `202`
- response body: `{"message":"If that email can be used, a verification email has been sent."}`
- API log line with `[auth:dev-mail] verification email ...`
- if `AUTH_EMAIL_MODE=dev-auto-verify`, the response body also includes `developmentVerificationUrl`

### Verify email

After copying the token from the verification log line:

```bash
curl -i http://localhost:3000/auth/verify-email \
  -X POST \
  -H 'Origin: http://localhost:5173' \
  -H 'Content-Type: application/json' \
  -c /tmp/pginbox-auth.cookie \
  --data '{"token":"REPLACE_WITH_VERIFICATION_TOKEN"}'
```

Expected result:

- HTTP `200`
- response body contains `user`
- response sets the `pginbox_session` cookie into `/tmp/pginbox-auth.cookie`

### Check current session

```bash
curl -i http://localhost:3000/auth/me \
  -b /tmp/pginbox-auth.cookie
```

Expected result:

- HTTP `200`
- response body contains the authenticated `user`

### Login

```bash
curl -i http://localhost:3000/auth/login \
  -X POST \
  -H 'Origin: http://localhost:5173' \
  -H 'Content-Type: application/json' \
  -c /tmp/pginbox-auth.cookie \
  --data '{"email":"dev-auth@example.com","password":"correct horse battery staple"}'
```

### Forgot password

```bash
curl -i http://localhost:3000/auth/forgot-password \
  -X POST \
  -H 'Origin: http://localhost:5173' \
  -H 'Content-Type: application/json' \
  --data '{"email":"dev-auth@example.com"}'
```

Expected result:

- HTTP `202`
- response body: `{"message":"If the account exists, password reset instructions have been sent."}`
- API log line with `[auth:dev-mail] password reset email ...`

### Reset password

After copying the token from the password reset log line:

```bash
curl -i http://localhost:3000/auth/reset-password \
  -X POST \
  -H 'Origin: http://localhost:5173' \
  -H 'Content-Type: application/json' \
  -c /tmp/pginbox-auth.cookie \
  --data '{"token":"REPLACE_WITH_RESET_TOKEN","newPassword":"another long password value"}'
```

Expected result:

- HTTP `200`
- response body contains `user`
- any older sessions for that user are revoked

### Logout

```bash
curl -i http://localhost:3000/auth/logout \
  -X POST \
  -H 'Origin: http://localhost:5173' \
  -b /tmp/pginbox-auth.cookie
```

Expected result:

- HTTP `204`
- the session cookie is cleared

## Cleanup task

Expired auth rows are cleaned up by a standalone one-shot task:

```bash
make auth-cleanup
```

Equivalent:

```bash
bun run auth:cleanup
```

What it removes:

- expired rows from `auth_sessions`
- consumed rows from `email_verification_tokens`
- expired rows from `email_verification_tokens`
- consumed rows from `password_reset_tokens`
- expired rows from `password_reset_tokens`

The task logs a single summary line like:

```text
[auth:cleanup] completed_at=2026-03-15T12:00:00.000Z expired_sessions_deleted=1 verification_tokens_deleted=2 password_reset_tokens_deleted=2
```

Schedule it once per day from cron or the platform scheduler. Example cron entry:

```cron
0 3 * * * cd /Users/jackbonatakis/repos/pginbox && /opt/homebrew/bin/bun run auth:cleanup >> /var/log/pginbox-auth-cleanup.log 2>&1
```

This cleanup path is standalone on purpose: it does not change normal API startup behavior, and public non-auth routes behave the same when auth is unused.

## Route summary

Current auth endpoints:

- `GET /auth/me`
- `POST /auth/register`
- `POST /auth/resend-verification`
- `POST /auth/verify-email`
- `POST /auth/login`
- `POST /auth/logout`
- `POST /auth/forgot-password`
- `POST /auth/reset-password`

Behavior notes:

- Sessions are cookie-based and stored server-side.
- Verification tokens expire after 24 hours.
- Password reset tokens expire after 1 hour.
- Session lifetime is 30 days.
- All state-changing auth routes reject unexpected origins.
- Public non-auth routes remain accessible without authentication.
