/* ======================================================================
   One-time migration: copy tasks, users, and config from Firestore into
   the local SQLite database. Safe to re-run (rows are upserted by id/email).

   PREREQUISITES
     1) npm install         (installs firebase-admin from optionalDependencies)
     2) A Firebase service-account key with read access to Firestore. Get it at:
        Firebase Console → Project settings → Service accounts → "Generate new
        private key". Save the file as  sqlite-app/serviceAccount.json  (git-ignored),
        OR set GOOGLE_APPLICATION_CREDENTIALS to its path.
     3) node migrate.js

   NOTE ON PASSWORDS: Firebase Authentication passwords cannot be exported, so
   migrated users start with NO password. Either:
     • set SMTP in .env and have each person use "Forgot password", or
     • set INITIAL_MANAGER_EMAIL + INITIAL_MANAGER_PASSWORD in .env and this
       script gives THAT manager a working password so you can log in and use
       "Reset password" for everyone else.
   ====================================================================== */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const { db } = require("./db");

let admin;
try { admin = require("firebase-admin"); }
catch (e) {
  console.error("firebase-admin is not installed. Run `npm install` first.");
  process.exit(1);
}

/* ---- Init Firebase Admin ---- */
const keyPath = path.join(__dirname, "serviceAccount.json");
try {
  if (fs.existsSync(keyPath)) {
    admin.initializeApp({ credential: admin.credential.cert(require(keyPath)) });
  } else {
    admin.initializeApp();   // uses GOOGLE_APPLICATION_CREDENTIALS
  }
} catch (e) {
  console.error("Could not initialize Firebase Admin. Provide serviceAccount.json or GOOGLE_APPLICATION_CREDENTIALS.\n", e.message);
  process.exit(1);
}
const fs_db = admin.firestore();

/* ---- Timestamp -> ms epoch helper (handles Firestore Timestamp or number) ---- */
function toMs(v) {
  if (!v) return null;
  if (typeof v === "number") return v;
  if (typeof v.toMillis === "function") return v.toMillis();
  if (v.seconds != null) return v.seconds * 1000;
  return null;
}

/* ---- Upsert statements (INSERT OR REPLACE keeps re-runs idempotent) ---- */
const upsertUser = db.prepare(`INSERT INTO users (email, name, role, active, password_hash, created_at)
  VALUES (@email, @name, @role, @active, @password_hash, @created_at)
  ON CONFLICT(email) DO UPDATE SET name=@name, role=@role, active=@active`);
const upsertTask = db.prepare(`INSERT OR REPLACE INTO tasks
  (id, owner_email, owner_name, topic, detail, priority, frequency, status,
   assigned_date, comp_date, remarks, custom, created_at,
   delete_requested, delete_req_by, delete_req_by_email, notify_pending, notify_at, notify)
  VALUES
  (@id, @owner_email, @owner_name, @topic, @detail, @priority, @frequency, @status,
   @assigned_date, @comp_date, @remarks, @custom, @created_at,
   @delete_requested, @delete_req_by, @delete_req_by_email, @notify_pending, @notify_at, @notify)`);
const upsertConfig = db.prepare(`INSERT INTO config (name, value) VALUES (@name, @value)
  ON CONFLICT(name) DO UPDATE SET value=@value`);

async function migrateUsers() {
  const snap = await fs_db.collection("users").get();
  let n = 0;
  snap.forEach(doc => {
    const d = doc.data();
    upsertUser.run({
      email: doc.id.toLowerCase(),
      name: d.name || doc.id,
      role: d.role === "manager" ? "manager" : "member",
      active: d.active === false ? 0 : 1,
      password_hash: null,             // set later (see header note)
      created_at: Date.now(),
    });
    n++;
  });
  console.log(`✓ users: ${n}`);
  return n;
}

async function migrateTasks() {
  const snap = await fs_db.collection("tasks").get();
  let n = 0;
  snap.forEach(doc => {
    const d = doc.data();
    upsertTask.run({
      id: doc.id,
      owner_email: (d.ownerEmail || "").toLowerCase(),
      owner_name: d.ownerName || "",
      topic: d.topic || "",
      detail: d.detail || "",
      priority: d.priority || "",
      frequency: d.frequency || "",
      status: d.status || "Pending",
      assigned_date: d.assignedDate || "",
      comp_date: d.compDate || "",
      remarks: d.remarks || "",
      custom: JSON.stringify(d.custom || {}),
      created_at: toMs(d.createdAt) || Date.now(),
      delete_requested: d.deleteRequested ? 1 : 0,
      delete_req_by: d.deleteReqBy || null,
      delete_req_by_email: d.deleteReqByEmail || null,
      notify_pending: d.notifyPending ? 1 : 0,
      notify_at: toMs(d.notifyAt),
      notify: d.notify ? JSON.stringify(d.notify) : null,
    });
    n++;
  });
  console.log(`✓ tasks: ${n}`);
  return n;
}

async function migrateConfig() {
  for (const name of ["columns", "options"]) {
    const doc = await fs_db.collection("config").doc(name).get();
    if (!doc.exists) continue;
    const data = doc.data();
    // The old columns doc stored { columns: [...] }; options stored the lists directly.
    const value = name === "columns" ? (data.columns || []) : data;
    upsertConfig.run({ name, value: JSON.stringify(value) });
    console.log(`✓ config/${name}`);
  }
}

// Give the initial manager a working password so you can log in right after migrating.
function setInitialManagerPassword() {
  const em = (process.env.INITIAL_MANAGER_EMAIL || "").toLowerCase();
  const pw = process.env.INITIAL_MANAGER_PASSWORD || "";
  if (!em || !pw) return;
  const u = db.prepare("SELECT email FROM users WHERE email=?").get(em);
  if (!u) { console.warn(`! INITIAL_MANAGER_EMAIL ${em} not found among migrated users — skipping password set.`); return; }
  db.prepare("UPDATE users SET password_hash=?, role='manager', active=1 WHERE email=?")
    .run(bcrypt.hashSync(pw, 10), em);
  console.log(`✓ set login password for initial manager ${em}`);
}

(async function run() {
  console.log("Migrating Firestore → SQLite …");
  try {
    await migrateUsers();
    await migrateTasks();
    await migrateConfig();
    setInitialManagerPassword();
    const noPw = db.prepare("SELECT COUNT(*) AS n FROM users WHERE password_hash IS NULL").get().n;
    console.log("\nDone.");
    if (noPw) console.log(`Note: ${noPw} user(s) have no password yet — they use "Forgot password" (needs SMTP) or you use "Reset password" from the Users tab after logging in.`);
    process.exit(0);
  } catch (e) {
    console.error("Migration failed:", e);
    process.exit(1);
  }
})();
