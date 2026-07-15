# Team Task List — Node + SQLite (self-hosted)

This is the **migrated** version of the Team Task List. It replaces Firebase with:

| Old (Firebase) | New (this app) |
|---|---|
| Firestore | **SQLite** file (`data/tasks.sqlite`) |
| Firebase Auth | **Local email + password** login (hashed, session cookie) |
| Cloud Functions (email + nightly cron) | **Node** SMTP + a built-in nightly cron |
| Static hosting (GitHub Pages) | A **Node server** you run on your VPS / office machine |

All the features carry over: My tasks / Team views, roles (manager/member), the
delete-approval workflow, user management, custom columns + dropdown values,
batched "Send updates" emails, and the nightly auto-send of forgotten updates.
Live updates are done by the page **polling every few seconds**.

---

## 1. Install (one time)

You need **Node.js 18+** on the machine. Then:

```bash
cd sqlite-app
npm install
cp .env.example .env      # Windows: copy .env.example .env
```

Open `.env` and set at least:

- `SESSION_SECRET` — a long random string (the file shows a command to generate one).
- `APP_URL` — how people reach the app, e.g. `http://192.168.1.50:3000` or `https://tasks.printo.in`.
- `INITIAL_MANAGER_*` — the first manager login (used only if the database is empty).
- `SMTP_*` — your mail server, if you want notification + password emails (optional).

## 2. Bring your existing data over (migration)

1. In the Firebase Console → **Project settings → Service accounts → Generate new
   private key**. Save the downloaded file as `sqlite-app/serviceAccount.json`.
2. Run:
   ```bash
   npm run migrate
   ```
   This copies all users, tasks, and settings into `data/tasks.sqlite`.

**Passwords:** Firebase never lets you export passwords, so migrated users start
without one. Because `.env` has `INITIAL_MANAGER_EMAIL` + `INITIAL_MANAGER_PASSWORD`,
the migration gives *that* manager a working password. Log in as them, then use
**Users → Reset password** for everyone else (needs SMTP), or set passwords by
editing a user and typing one.

*(Starting fresh instead? Skip this step — the first manager from `.env` is created
automatically the first time you start the server on an empty database.)*

## 3. Run

```bash
npm start
```

Visit `APP_URL`. That's it.

### Keep it running on a VPS

Use a process manager so it restarts on crash/reboot. With **pm2**:

```bash
npm install -g pm2
pm2 start server.js --name task-list
pm2 save && pm2 startup      # follow the printed instruction to enable on boot
```

Put it behind **nginx/Caddy** for a domain + HTTPS, and set `SECURE_COOKIES=true`
in `.env` once you're on HTTPS.

---

## Backups

Everything lives in the `data/` folder. To back up, stop the server (or use SQLite's
online backup) and copy `data/tasks.sqlite`. A simple nightly copy of that one file
is a complete backup of all tasks and users.

## Notes / differences from the Firebase version

- **Nightly auto-send now actually runs unattended** — it's a server cron
  (`NIGHTLY_CRON`, default 00:00 India time), not a browser timer. SMTP must be set.
- **One email per person** for batched updates is preserved (10 tasks for one person
  → a single "Task updates (10)" email).
- Email is optional: without SMTP the app works fully, it just can't send mail
  (managers set passwords manually and skip the digest emails).
- The `Type` column was removed earlier and is not part of this version.
