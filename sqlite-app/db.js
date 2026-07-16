/* ======================================================================
   SQLite database: schema, connection, and small query helpers.
   Uses better-sqlite3 (synchronous — simple and fast for this scale).
   The DB file lives in ./data/tasks.sqlite (git-ignored).
   ====================================================================== */
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");

// Where the SQLite file lives. Defaults to ./data locally; on a host like Render
// set DATA_DIR to a PERSISTENT DISK mount (e.g. /var/data) so data survives deploys.
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "tasks.sqlite"));
db.pragma("journal_mode = WAL");   // better concurrency for the polling clients
db.pragma("foreign_keys = ON");

/* ---- Schema (created once; IF NOT EXISTS keeps restarts safe) ---- */
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    email         TEXT PRIMARY KEY,          -- lowercase; the identity
    name          TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'member',   -- 'member' | 'manager'
    active        INTEGER NOT NULL DEFAULT 1,       -- 1 = active, 0 = inactive
    password_hash TEXT,                       -- bcrypt hash; null until a password is set
    reset_token   TEXT,                       -- sha256 of the emailed reset token
    reset_expires INTEGER,                    -- ms epoch when the reset token expires
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id                  TEXT PRIMARY KEY,     -- uuid (kept from Firestore on migration)
    owner_email         TEXT NOT NULL,
    owner_name          TEXT,
    topic               TEXT NOT NULL,
    detail              TEXT,
    priority            TEXT,
    frequency           TEXT,
    status              TEXT,
    assigned_date       TEXT,                 -- 'YYYY-MM-DD'
    comp_date           TEXT,
    remarks             TEXT,
    custom              TEXT,                 -- JSON map of custom-column values
    created_at          INTEGER NOT NULL,     -- ms epoch
    delete_requested    INTEGER NOT NULL DEFAULT 0,
    delete_req_by       TEXT,
    delete_req_by_email TEXT,
    notify_pending      INTEGER NOT NULL DEFAULT 0,
    notify_at           INTEGER,
    notify              TEXT                  -- JSON payload for the batched email
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_owner  ON tasks(owner_email);
  CREATE INDEX IF NOT EXISTS idx_tasks_notify ON tasks(notify_pending);

  CREATE TABLE IF NOT EXISTS config (
    name  TEXT PRIMARY KEY,                   -- 'columns' | 'options'
    value TEXT NOT NULL                       -- JSON
  );
`);

/* ---- Row <-> API shape helpers -------------------------------------
   The frontend speaks camelCase (like the old Firestore docs); the table
   is snake_case. These map between the two so the client barely changes. */
function taskToApi(r) {
  if (!r) return null;
  return {
    id: r.id,
    ownerEmail: r.owner_email,
    ownerName: r.owner_name,
    topic: r.topic,
    detail: r.detail || "",
    priority: r.priority || "",
    frequency: r.frequency || "",
    status: r.status || "",
    assignedDate: r.assigned_date || "",
    compDate: r.comp_date || "",
    remarks: r.remarks || "",
    custom: r.custom ? JSON.parse(r.custom) : {},
    createdAt: r.created_at,
    deleteRequested: !!r.delete_requested,
    deleteReqBy: r.delete_req_by || "",
    deleteReqByEmail: r.delete_req_by_email || "",
    notifyPending: !!r.notify_pending,
    notifyAt: r.notify_at || null,
    notify: r.notify ? JSON.parse(r.notify) : null,
  };
}
function userToApi(r) {
  if (!r) return null;
  return {
    email: r.email,
    name: r.name,
    role: r.role || "member",
    active: r.active !== 0,
    hasPassword: !!r.password_hash,
  };
}

/* ---- Prepared statements (created lazily, reused) ---- */
const q = {
  userByEmail: db.prepare("SELECT * FROM users WHERE email = ?"),
  allUsers: db.prepare("SELECT * FROM users ORDER BY name COLLATE NOCASE"),
  insertUser: db.prepare(`INSERT INTO users (email, name, role, active, password_hash, created_at)
                          VALUES (@email, @name, @role, @active, @password_hash, @created_at)`),
  updateUserProfile: db.prepare("UPDATE users SET name=@name, role=@role, active=@active WHERE email=@email"),
  setPassword: db.prepare("UPDATE users SET password_hash=@hash, reset_token=NULL, reset_expires=NULL WHERE email=@email"),
  setReset: db.prepare("UPDATE users SET reset_token=@token, reset_expires=@expires WHERE email=@email"),
  setActive: db.prepare("UPDATE users SET active=@active, name=COALESCE(@name, name) WHERE email=@email"),
  deleteUser: db.prepare("DELETE FROM users WHERE email = ?"),

  taskById: db.prepare("SELECT * FROM tasks WHERE id = ?"),
  allTasks: db.prepare("SELECT * FROM tasks"),
  tasksByOwner: db.prepare("SELECT * FROM tasks WHERE owner_email = ?"),
  pendingNotifyTasks: db.prepare("SELECT * FROM tasks WHERE notify_pending = 1"),
  insertTask: db.prepare(`INSERT INTO tasks
    (id, owner_email, owner_name, topic, detail, priority, frequency, status,
     assigned_date, comp_date, remarks, custom, created_at,
     delete_requested, notify_pending, notify_at, notify)
    VALUES
    (@id, @owner_email, @owner_name, @topic, @detail, @priority, @frequency, @status,
     @assigned_date, @comp_date, @remarks, @custom, @created_at,
     0, @notify_pending, @notify_at, @notify)`),
  updateTask: db.prepare(`UPDATE tasks SET
     owner_email=@owner_email, owner_name=@owner_name, topic=@topic, detail=@detail,
     priority=@priority, frequency=@frequency, status=@status, assigned_date=@assigned_date,
     comp_date=@comp_date, remarks=@remarks, custom=@custom,
     notify_pending=@notify_pending, notify_at=@notify_at, notify=@notify
     WHERE id=@id`),
  deleteTask: db.prepare("DELETE FROM tasks WHERE id = ?"),
  setDeleteReq: db.prepare(`UPDATE tasks SET delete_requested=@req, delete_req_by=@by, delete_req_by_email=@byEmail WHERE id=@id`),
  clearNotify: db.prepare("UPDATE tasks SET notify_pending=0 WHERE id=?"),
  reassignOwner: db.prepare("UPDATE tasks SET owner_email=@to, owner_name=@toName WHERE owner_email=@from"),

  getConfig: db.prepare("SELECT value FROM config WHERE name = ?"),
  setConfig: db.prepare(`INSERT INTO config (name, value) VALUES (@name, @value)
                         ON CONFLICT(name) DO UPDATE SET value=@value`),
};

/* ---- Seed a first manager if the users table is empty (fresh install) ---- */
function seedInitialManager({ email, name, password }) {
  const count = db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
  if (count > 0) return false;
  if (!email || !password) return false;
  q.insertUser.run({
    email: email.toLowerCase(),
    name: name || email,
    role: "manager",
    active: 1,
    password_hash: bcrypt.hashSync(password, 10),
    created_at: Date.now(),
  });
  return true;
}

module.exports = { db, q, taskToApi, userToApi, seedInitialManager };
