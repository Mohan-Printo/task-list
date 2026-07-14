# Deleting a user's Firebase LOGIN (optional Cloud Function)

The app can delete a person from the directory on its own. Deleting their actual
**login** (Firebase Authentication account) requires this server-side function,
because browser SDKs can only delete the *currently signed-in* user's own login.

## What it does
`deleteAuthUser` is a Callable Function that — when called by a **manager** —
deletes the target person's Auth login **and** their `/users/{email}` doc.

## One-time setup

1. **Upgrade to the Blaze plan.** Cloud Functions require the pay-as-you-go
   (Blaze) plan. For a small team it is effectively free (generous free tier),
   but a billing card is required.
   Firebase Console → ⚙ → Usage and billing → Modify plan → Blaze.

2. **Install the Firebase CLI** (once, on your machine):
   ```
   npm install -g firebase-tools
   firebase login
   ```

3. **From the project root** (`D:\Task list`), install deps and deploy:
   ```
   cd functions
   npm install
   cd ..
   firebase deploy --only functions --project task-list-commercial
   ```

4. **Turn it on in the app.** In `index.html`, set:
   ```js
   const AUTH_DELETE_FUNCTION = "deleteAuthUser";
   ```
   Now the **Delete** button removes both the login and the directory entry.
   (Leave it `""` to keep directory-only deletion.)

## Notes
- Only managers can call it (role `manager` in `/users`, or a seeded email in
  `SEED_MANAGERS` inside `index.js` — keep that list in sync with your app).
- Region defaults to `us-central1`. If you deploy to another region, set it on
  the client too: `getFunctions(app, "your-region")` in `index.html`.
- Logs: `firebase functions:log` (or the Console → Functions → Logs).
