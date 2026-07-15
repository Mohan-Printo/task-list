# Email notifications via your own SMTP

By default the app sends notifications through **EmailJS**. To use **your own SMTP**
instead (no monthly cap, your own "From" address), deploy the `sendMail` Cloud
Function and point the app at it.

## What triggers an email (already built in the app)
- A **member** adds a task  → all **managers** (Hamsa) get "Task created by …".
- A **member** edits a task (e.g. **status aaa → xyz**) → managers get "Task updated by …" with the exact changes.
- A **manager** assigns/updates a task → the **assignee** gets notified.
Switching to SMTP does not change *who* gets emailed or *what* it says — only how it's delivered.

## One-time setup

1. **Blaze plan** required (Cloud Functions). See `DEPLOY.md`.

2. **Set the SMTP values.** Create `functions/.env` (it is git-ignored):
   ```
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=465
   SMTP_USER=notifications@printo.in
   SMTP_FROM=notifications@printo.in
   ```
   Then store the password as a **secret** (not in .env):
   ```
   firebase functions:secrets:set SMTP_PASSWORD
   ```
   (It prompts for the value and hides it.)

3. **Deploy:**
   ```
   cd functions && npm install && cd ..
   firebase deploy --only functions --project task-list-commercial
   ```

4. **Turn it on in the app.** In `index.html`:
   ```js
   const MAIL_FUNCTION = "sendMail";
   ```
   (Leave `""` to keep using EmailJS.)

## SMTP settings by provider

| Provider | Host | Port | User / Password |
|---|---|---|---|
| Google Workspace / Gmail | `smtp.gmail.com` | 465 | your address / **App Password** (needs 2-Step Verification on the account) |
| Microsoft 365 / Outlook | `smtp.office365.com` | 587 | your address / mailbox password |
| Zoho Mail | `smtp.zoho.in` (or `.com`) | 465 | your address / app-specific password |
| Other host | ask your mail provider | 465 or 587 | mailbox login |

> **Gmail note:** you cannot use your normal password — create an **App Password**
> at myaccount.google.com → Security → App passwords, and use that as `SMTP_PASSWORD`.
> Daily send limits apply (~2,000/day on Workspace, ~500/day on free Gmail).

## Nightly auto-send (forgotten updates)

The scheduled function **`sendQueuedNotifications`** runs every night at **00:00 India
time** and emails any batched updates the manager did not send with the "Send updates"
button. It runs on Google's servers, so it works even when no one is logged in (the old
browser-tab midnight timer only fired if a manager left the tab open).

- It uses the **same SMTP settings above** — set `SMTP_HOST/PORT/USER/FROM` + the
  `SMTP_PASSWORD` secret, then `firebase deploy --only functions`. No `index.html`
  change is needed for the nightly send (it does not depend on `MAIL_FUNCTION`).
- It groups by recipient the same way the button does: **one email per person**, so 10
  tasks assigned to one person become a single "Task updates (10)" email.
- A task's `notifyPending` flag is cleared only once its email is delivered; anything
  that fails stays queued and retries the next night.
- Change the time by editing the `schedule` / `timeZone` in `sendQueuedNotifications`.
- Scheduled functions require the **Blaze plan** (same as above).

## Notes
- The function only lets you email **known team members** (someone with a `/users`
  entry, or a seeded manager) — it can't be abused to send to random addresses.
- Change the "From" name/address with `SMTP_FROM`.
- Logs: `firebase functions:log`.
