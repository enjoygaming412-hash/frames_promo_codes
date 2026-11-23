# FRAMES BASEMENT REWARDS

A complete, working daily-reward website for a Minecraft community: one promo code per day,
one claim per Minecraft username every 24 hours, enforced by the backend and a shared SQLite
database, plus a password-protected admin panel.

Everything here runs on free software and free hosting — no paid service or credit card is
required.

---

## What is included

| Area | Details |
| --- | --- |
| Public page (`/`) | Promo code + Minecraft username + confirmation field, **CLAIM REWARD** button, success message, exact cooldown time, live daily reward panel |
| Claim rules | 24h cooldown per username, only the current day's code, per-day maximum claims, duplicate prevention (database unique index), all enforced server-side |
| Timezone | Promo days and cooldown timestamps are computed in **America/Toronto**; the next promo activates automatically at Toronto midnight |
| Admin panel (`/admin`) | Secure login, create/edit/delete promos for any date (past, today, future), rewards, maximum uses, remaining uses, all claims with usernames + Toronto claim times, mark claims delivered, change admin password |
| Database | SQLite file shared by every visitor, written with `synchronous = FULL` so claims survive refreshes, restarts and concurrent requests |

## Run it locally

```bash
npm install
npm start            # http://localhost:3000
```

The first start creates `data/rewards.db`. If `ADMIN_PASSWORD` is not set, a random admin
password is generated once, stored hashed in the database and printed in the startup log.

## Tests

```bash
npm test
```

13 integration tests start a real HTTP server against a temporary database and cover:

* the exact success message after a valid claim
* the 24-hour cooldown and the exact "unavailable until" time
* refreshing/repeating requests cannot bypass the cooldown
* the per-day maximum claim limit
* only the current day's code is accepted (yesterday/tomorrow rejected)
* automatic promo switching at Toronto midnight
* username confirmation and validation errors
* duplicate claims blocked at database level
* admin login (wrong password, protected endpoints, logout)
* admin creating promos, viewing claims, remaining uses and marking delivered
* the admin password never appearing in public assets

## Environment variables

| Name | Required | Purpose |
| --- | --- | --- |
| `PORT` | no (default `3000`) | HTTP port, the server listens on `0.0.0.0` |
| `ADMIN_PASSWORD` | recommended | Admin password checked server-side. Set it in the hosting dashboard so only you know it. |
| `DATA_DIR` | no (default `./data`) | Folder for the SQLite database |
| `DB_PATH` | no | Full path to the database file (overrides `DATA_DIR`) |

`ADMIN_PASSWORD` is only read by the Node server. It is never sent to the browser, and no
password or hash is present in `public/`.

## Admin workflow

1. Open `/admin` and sign in.
2. Create a promo for each upcoming day: date (Toronto), code, reward, maximum claims.
3. Optionally use **Fill next 7 days** to prepare a whole week quickly.
4. Watch the claims table: usernames, Toronto claim times, and **Mark delivered**.
5. Remaining uses per promo are shown in the promo table and in the dashboard summary.

## Publishing with a free public link

The site is deployed with AppJet hosting, which provides a public HTTPS URL on the free plan:

1. Open the deployed URL — the public page is the redemption form.
2. Go to `/admin` and sign in.
3. In **Settings → Environment variables**, add `ADMIN_PASSWORD` with your own password,
   then redeploy. Until you do, the server-generated password printed in the startup log is
   the one that works.

Free-plan note: the free plan does not include a persistent disk, so the SQLite file lives
inside the app container. Claims are shared by all members and survive restarts, but a new
deployment starts from a fresh database file. Keeping claim history across deployments needs
a persistent disk (Starter, $5/month) or an external free Postgres database — neither is
required for the site to work, and no paid service was activated.

## HTTP API

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/public/config` | Today's date, weekday, reward, remaining uses, timezone, success message |
| `GET` | `/api/public/status?username=` | Cooldown state for one username |
| `POST` | `/api/public/claim` | `{ code, username, confirmUsername }` |
| `POST` | `/api/admin/login` | `{ password }` → `HttpOnly`, `SameSite=Strict` session cookie |
| `POST` | `/api/admin/logout` | Ends the session |
| `GET` | `/api/admin/session` | Login state and password mode |
| `GET` | `/api/admin/overview` | Totals, today's promo, upcoming and past promos |
| `GET`/`POST` | `/api/admin/promos` | List (filter `all`/`today`/`upcoming`/`past`) / create |
| `PUT`/`DELETE` | `/api/admin/promos/:id` | Edit or delete (promos with claims cannot be deleted) |
| `GET` | `/api/admin/claims` | Paginated claims, filter `all`/`pending`/`delivered`, search by username |
| `POST` | `/api/admin/claims/:id/delivered` | `{ delivered: true }` |
| `POST` | `/api/admin/password` | Change the database-managed admin password |
