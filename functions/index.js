/**
 * Callable Cloud Function: deleteAuthUser
 * ---------------------------------------
 * Deletes a person's Firebase LOGIN (Auth account) AND their /users directory
 * doc. Client SDKs can only delete their OWN login, so this server-side function
 * is the only way for a manager to remove someone else's login.
 *
 * Security: only a signed-in MANAGER may call it. Manager = role "manager" in
 * /users/{email}, OR one of the seeded manager emails below (keep in sync with
 * the app's TEAM list / Firestore isManager rule).
 *
 * Deploy:  firebase deploy --only functions
 * Then in index.html set:  const AUTH_DELETE_FUNCTION = "deleteAuthUser";
 */
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineString, defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");

admin.initializeApp();

// Seeded managers (lowercase). Anyone with role "manager" in /users also qualifies.
const SEED_MANAGERS = ["hamsa.v@printo.in"];

// ---- SMTP config (set these before deploying — see EMAIL.md) ----
const SMTP_HOST     = defineString("SMTP_HOST");                    // e.g. smtp.gmail.com
const SMTP_PORT     = defineString("SMTP_PORT", { default: "465" });// 465 (SSL) or 587 (STARTTLS)
const SMTP_USER     = defineString("SMTP_USER");                    // full mailbox address
const SMTP_FROM     = defineString("SMTP_FROM", { default: "" });   // optional "From"; defaults to SMTP_USER
const SMTP_PASSWORD = defineSecret("SMTP_PASSWORD");                // app password / SMTP password (secret)

exports.deleteAuthUser = onCall(async (request) => {
  const caller = (request.auth && request.auth.token && request.auth.token.email || "").toLowerCase();
  if (!caller) throw new HttpsError("unauthenticated", "Please sign in.");

  // Verify the caller is a manager.
  let isManager = SEED_MANAGERS.includes(caller);
  if (!isManager) {
    const snap = await admin.firestore().collection("users").doc(caller).get();
    isManager = snap.exists && snap.data().role === "manager";
  }
  if (!isManager) throw new HttpsError("permission-denied", "Managers only.");

  const email = (request.data && request.data.email || "").toLowerCase();
  if (!email) throw new HttpsError("invalid-argument", "An email is required.");
  if (email === caller) throw new HttpsError("failed-precondition", "You cannot delete yourself.");

  // 1) Delete the Auth login (ignore if it doesn't exist).
  try {
    const user = await admin.auth().getUserByEmail(email);
    await admin.auth().deleteUser(user.uid);
  } catch (e) {
    if (e.code !== "auth/user-not-found") {
      throw new HttpsError("internal", "Could not delete login: " + e.message);
    }
  }

  // 2) Delete the directory doc.
  await admin.firestore().collection("users").doc(email).delete();

  return { ok: true, email };
});

/**
 * Callable Cloud Function: sendMail
 * ---------------------------------
 * Sends a task-notification email through YOUR SMTP server (nodemailer).
 * Called by the app's notify() when MAIL_FUNCTION = "sendMail" in index.html.
 *
 * Guards against misuse: caller must be signed in, and the recipient must be a
 * known team member (a /users doc, or a seeded manager) so this can't be used
 * to send mail to arbitrary addresses.
 */
exports.sendMail = onCall({ secrets: [SMTP_PASSWORD] }, async (request) => {
  const caller = (request.auth && request.auth.token && request.auth.token.email || "").toLowerCase();
  if (!caller) throw new HttpsError("unauthenticated", "Please sign in.");

  const to = (request.data && request.data.to || "").toLowerCase();
  const subject = String(request.data && request.data.subject || "").slice(0, 300);
  const message = String(request.data && request.data.message || "").slice(0, 20000);
  const toName = String(request.data && request.data.toName || "");
  const fromName = String(request.data && request.data.fromName || "Team Task List").slice(0, 120);
  if (!to || !to.includes("@")) throw new HttpsError("invalid-argument", "A valid recipient is required.");

  // Only allow sending to known team members (prevents open-relay abuse).
  let allowed = SEED_MANAGERS.includes(to);
  if (!allowed) {
    const snap = await admin.firestore().collection("users").doc(to).get();
    allowed = snap.exists;
  }
  if (!allowed) throw new HttpsError("permission-denied", "Recipient is not a team member.");

  const port = parseInt(SMTP_PORT.value() || "465", 10);
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST.value(),
    port,
    secure: port === 465,                 // 465 = implicit SSL; 587 = STARTTLS
    auth: { user: SMTP_USER.value(), pass: SMTP_PASSWORD.value() },
  });

  const from = SMTP_FROM.value() || SMTP_USER.value();
  try {
    await transporter.sendMail({
      from: `"${fromName}" <${from}>`,
      to: toName ? `"${toName}" <${to}>` : to,
      subject,
      text: message,
    });
  } catch (e) {
    console.error("SMTP send failed:", e);
    throw new HttpsError("internal", "Could not send email: " + e.message);
  }
  return { ok: true };
});
