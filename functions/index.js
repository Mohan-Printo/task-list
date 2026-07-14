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
const admin = require("firebase-admin");

admin.initializeApp();

// Seeded managers (lowercase). Anyone with role "manager" in /users also qualifies.
const SEED_MANAGERS = ["hamsa.v@printo.in"];

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
