/* ======================================================================
   Team Task List — Node + Express + SQLite server.
   Replaces Firebase Auth (local sessions), Firestore (SQLite), and the
   Cloud Functions (email + nightly cron), keeping the same features/behavior.
   ====================================================================== */
require("dotenv").config();
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const cron = require("node-cron");

const { db, q, taskToApi, userToApi, linkToApi, seedInitialManager } = require("./db");
const email = require("./email");
const notify = require("./notify");

// Session store backed by our existing better-sqlite3 connection (a "sessions"
// table is created in the same DB file — no second native driver needed).
const SQLiteStore = require("better-sqlite3-session-store")(session);

const app = express();
const PORT = parseInt(process.env.PORT || "3000", 10);
const APP_URL = (process.env.APP_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const SECURE_COOKIES = String(process.env.SECURE_COOKIES) === "true";

// A manager status that sinks a task to the bottom of Team view and shows as
// plain "Completed" to the member who owns it (kept identical to the old app).
const MANAGER_STATUS = "Completed - Remove";

/* ---- Seed the first manager on a fresh (empty) database ---- */
const seeded = seedInitialManager({
  email: process.env.INITIAL_MANAGER_EMAIL,
  name: process.env.INITIAL_MANAGER_NAME,
  password: process.env.INITIAL_MANAGER_PASSWORD,
});
if (seeded) console.log(`[seed] Created initial manager ${process.env.INITIAL_MANAGER_EMAIL}`);

/* ---- Middleware ---- */
app.use(express.json({ limit: "1mb" }));
if (SECURE_COOKIES) app.set("trust proxy", 1);
app.use(session({
  store: new SQLiteStore({ client: db, expired: { clear: true, intervalMs: 15 * 60 * 1000 } }),
  secret: process.env.SESSION_SECRET || "insecure-dev-secret-change-me",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: SECURE_COOKIES,
    maxAge: 1000 * 60 * 60 * 24 * 14,     // 14 days
  },
}));

/* ---- Auth helpers ---- */
function currentUser(req) {
  const em = req.session && req.session.email;
  if (!em) return null;
  const u = q.userByEmail.get(em.toLowerCase());
  if (!u || u.active === 0) return null;
  return userToApi(u);
}
function requireAuth(req, res, next) {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: "Not signed in." });
  req.user = u;
  next();
}
function requireManager(req, res, next) {
  if (!req.user || req.user.role !== "manager")
    return res.status(403).json({ error: "Managers only." });
  next();
}
const lc = s => (s || "").toString().trim().toLowerCase();
const sha = s => crypto.createHash("sha256").update(s).digest("hex");

/* ====================================================================== */
/*  AUTH ROUTES                                                            */
/* ====================================================================== */
app.post("/api/login", (req, res) => {
  const emailAddr = lc(req.body.email);
  const pw = req.body.password || "";
  const u = q.userByEmail.get(emailAddr);
  if (!u || u.active === 0 || !u.password_hash || !bcrypt.compareSync(pw, u.password_hash))
    return res.status(401).json({ error: "Wrong email or password." });
  req.session.email = emailAddr;
  res.json({ user: userToApi(u) });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/me", (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: "Not signed in." });
  res.json({ user: u });
});

// Forgot password: always respond OK (don't leak which emails exist).
app.post("/api/forgot", async (req, res) => {
  const emailAddr = lc(req.body.email);
  const u = emailAddr && q.userByEmail.get(emailAddr);
  if (u && u.active !== 0) await issueReset(u.email, u.name);
  res.json({ ok: true });
});

// Reset password using an emailed token.
app.post("/api/reset", (req, res) => {
  const emailAddr = lc(req.body.email);
  const token = (req.body.token || "").trim();
  const pw = req.body.password || "";
  if (pw.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters." });
  const u = q.userByEmail.get(emailAddr);
  if (!u || !u.reset_token || !u.reset_expires || u.reset_expires < Date.now() || sha(token) !== u.reset_token)
    return res.status(400).json({ error: "This reset link is invalid or has expired." });
  q.setPassword.run({ email: emailAddr, hash: bcrypt.hashSync(pw, 10) });
  res.json({ ok: true });
});

// Create a reset token and email a set-password link. Returns whether mail was sent.
async function issueReset(emailAddr, name) {
  const token = crypto.randomBytes(24).toString("hex");
  q.setReset.run({ email: lc(emailAddr), token: sha(token), expires: Date.now() + 1000 * 60 * 60 });  // 1h
  const link = `${APP_URL}/reset.html?email=${encodeURIComponent(emailAddr)}&token=${token}`;
  return email.send(emailAddr, name, "Set your Team Task List password",
    `Hi ${name || ""},\n\nUse the link below to set your password (valid for 1 hour):\n\n${link}\n\n`
    + `If you didn't request this, you can ignore this email.`);
}

/* ====================================================================== */
/*  USERS (directory + logins)                                             */
/* ====================================================================== */
app.get("/api/users", requireAuth, (req, res) => {
  res.json({ users: q.allUsers.all().map(userToApi) });
});

// Create OR update a user. New users get a login (password or emailed link).
app.post("/api/users", requireAuth, requireManager, async (req, res) => {
  const emailAddr = lc(req.body.email);
  const name = (req.body.name || "").trim();
  const role = req.body.role === "manager" ? "manager" : "member";
  const active = req.body.active === false ? 0 : 1;
  const pw = (req.body.password || "").trim();
  if (!name) return res.status(400).json({ error: "Name is required." });
  if (!emailAddr || !emailAddr.includes("@")) return res.status(400).json({ error: "A valid email is required." });
  if (pw && pw.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters." });

  const existing = q.userByEmail.get(emailAddr);
  if (existing) {
    q.updateUserProfile.run({ email: emailAddr, name, role, active });
    return res.json({ ok: true, note: "User updated." });
  }
  // New user + login.
  q.insertUser.run({
    email: emailAddr, name, role, active,
    password_hash: pw ? bcrypt.hashSync(pw, 10) : null,
    created_at: Date.now(),
  });
  if (pw) return res.json({ ok: true, note: `Login created. ${name} can sign in now with the password you set.` });
  const sent = await issueReset(emailAddr, name);
  res.json({ ok: true, note: sent
    ? `Login created. A "set your password" email was sent to ${emailAddr}.`
    : `Login created, but email isn't configured — set a password for them via "Reset password" or SMTP.` });
});

app.post("/api/users/:email/reset-password", requireAuth, requireManager, async (req, res) => {
  const emailAddr = lc(req.params.email);
  const u = q.userByEmail.get(emailAddr);
  if (!u) return res.status(404).json({ error: "No such user." });
  const sent = await issueReset(emailAddr, u.name);
  res.json({ ok: true, sent });
});

app.post("/api/users/:email/reactivate", requireAuth, requireManager, (req, res) => {
  const emailAddr = lc(req.params.email);
  const name = (req.body.name || "").trim();
  if (!name) return res.status(400).json({ error: "A name is required to reactivate." });
  q.setActive.run({ email: emailAddr, active: 1, name });
  res.json({ ok: true });
});

app.delete("/api/users/:email", requireAuth, requireManager, (req, res) => {
  const emailAddr = lc(req.params.email);
  if (emailAddr === req.user.email) return res.status(400).json({ error: "You cannot delete yourself." });
  q.deleteUser.run(emailAddr);
  res.json({ ok: true });
});

// Reassign all of a user's tasks to someone else, then deactivate them.
app.post("/api/users/:email/reassign", requireAuth, requireManager, (req, res) => {
  const from = lc(req.params.email);
  const to = lc(req.body.target);
  if (!to) return res.status(400).json({ error: "Pick someone to receive the tasks." });
  if (to === from) return res.status(400).json({ error: "Choose a different person." });
  const target = q.userByEmail.get(to);
  if (!target) return res.status(404).json({ error: "Target user not found." });
  const moved = q.tasksByOwner.all(from).length;
  const tx = db.transaction(() => {
    q.reassignOwner.run({ from, to, toName: target.name });
    q.setActive.run({ email: from, active: 0, name: null });
  });
  tx();
  res.json({ ok: true, moved, targetName: target.name });
});

/* ====================================================================== */
/*  TASKS                                                                  */
/* ====================================================================== */
app.get("/api/tasks", requireAuth, (req, res) => {
  const me = req.user.email;
  const team = req.query.view === "team" && req.user.role === "manager";
  const rows = team ? q.allTasks.all() : q.tasksByOwner.all(me);
  res.json({ tasks: rows.map(taskToApi) });
});

// Shared: assemble the writable fields from the request body for a given actor.
function readTaskBody(body) {
  const url = body.link && body.link.url ? String(body.link.url).trim() : "";
  const linkName = body.link && body.link.name ? String(body.link.name).trim() : "";
  return {
    topic: (body.topic || "").trim(),
    type: body.type || "",
    detail: (body.detail || "").trim(),
    priority: body.priority || "",
    frequency: (body.frequency || "").trim(),
    status: body.status || "Pending",
    assignedDate: body.assignedDate || "",
    compDate: body.compDate || "",
    remarks: (body.remarks || "").trim(),
    link: url ? { url, name: linkName || url } : null,
    custom: body.custom && typeof body.custom === "object" ? body.custom : {},
  };
}

app.post("/api/tasks", requireAuth, async (req, res) => {
  const actor = req.user;
  const data = readTaskBody(req.body);
  if (!data.topic) return res.status(400).json({ error: "Task topic is required." });

  // Owner: managers may assign to anyone; members always own their own.
  if (actor.role === "manager") {
    const owner = lc(req.body.ownerEmail) || actor.email;
    const ou = q.userByEmail.get(owner);
    data.ownerEmail = owner;
    data.ownerName = (ou && ou.name) || owner;
  } else {
    data.ownerEmail = actor.email;
    data.ownerName = actor.name;
    if (data.status === MANAGER_STATUS) data.status = "Completed";   // members can't set the manager status
  }

  const n = notify.buildNotify(true, data, [], actor);
  const id = crypto.randomUUID();
  q.insertTask.run({
    id, owner_email: data.ownerEmail, owner_name: data.ownerName, topic: data.topic,
    type: data.type, detail: data.detail, priority: data.priority, frequency: data.frequency, status: data.status,
    assigned_date: data.assignedDate, comp_date: data.compDate, remarks: data.remarks,
    link_name: data.link ? data.link.name : null, link_url: data.link ? data.link.url : null,
    custom: JSON.stringify(data.custom), created_at: Date.now(),
    notify_pending: n ? 1 : 0, notify_at: n ? Date.now() : null, notify: n ? JSON.stringify(n) : null,
  });
  res.json({ ok: true, id });
});

app.put("/api/tasks/:id", requireAuth, async (req, res) => {
  const actor = req.user;
  const row = q.taskById.get(req.params.id);
  if (!row) return res.status(404).json({ error: "Task not found." });
  const oldApi = taskToApi(row);
  const isOwner = oldApi.ownerEmail === actor.email;
  if (actor.role !== "manager" && !isOwner) return res.status(403).json({ error: "You can only edit your own tasks." });

  const data = readTaskBody(req.body);
  if (!data.topic) return res.status(400).json({ error: "Task topic is required." });

  // Owner: managers may reassign; members keep the existing owner.
  if (actor.role === "manager") {
    const owner = lc(req.body.ownerEmail) || oldApi.ownerEmail;
    const ou = q.userByEmail.get(owner);
    data.ownerEmail = owner;
    data.ownerName = (ou && ou.name) || owner;
  } else {
    data.ownerEmail = oldApi.ownerEmail;
    data.ownerName = oldApi.ownerName;
    if (data.status === MANAGER_STATUS) data.status = "Completed";
  }

  const changes = notify.diffSummary(oldApi, data);
  const n = notify.buildNotify(false, data, changes, actor);
  // If nothing new to notify, keep any already-queued notification untouched.
  const nf = n
    ? { notify_pending: 1, notify_at: Date.now(), notify: JSON.stringify(n) }
    : { notify_pending: row.notify_pending, notify_at: row.notify_at, notify: row.notify };

  q.updateTask.run({
    id: row.id, owner_email: data.ownerEmail, owner_name: data.ownerName, topic: data.topic,
    type: data.type, detail: data.detail, priority: data.priority, frequency: data.frequency, status: data.status,
    assigned_date: data.assignedDate, comp_date: data.compDate, remarks: data.remarks,
    link_name: data.link ? data.link.name : null, link_url: data.link ? data.link.url : null,
    custom: JSON.stringify(data.custom), ...nf,
  });
  res.json({ ok: true });
});

// Manager deletes directly.
app.delete("/api/tasks/:id", requireAuth, requireManager, (req, res) => {
  const row = q.taskById.get(req.params.id);
  if (!row) return res.status(404).json({ error: "Task not found." });
  q.deleteTask.run(row.id);
  res.json({ ok: true });
});

// Member asks a manager to approve deletion -> notify managers immediately.
app.post("/api/tasks/:id/request-delete", requireAuth, async (req, res) => {
  const row = q.taskById.get(req.params.id);
  if (!row) return res.status(404).json({ error: "Task not found." });
  if (row.owner_email !== req.user.email) return res.status(403).json({ error: "Not your task." });
  q.setDeleteReq.run({ id: row.id, req: 1, by: req.user.name, byEmail: req.user.email });
  const t = taskToApi(row);
  notify.managerEmails().filter(e => e !== req.user.email).forEach(to =>
    email.send(to, null, `Deletion requested: ${t.topic || "task"}`,
      `${req.user.name} requested to delete the task "${t.topic || "task"}".\n\n`
      + `Open the Team view to Approve or Reject it.\n\n${notify.taskSummaryText(t)}`, req.user.name));
  res.json({ ok: true });
});

// Manager approves -> delete + notify the requester.
app.post("/api/tasks/:id/approve-delete", requireAuth, requireManager, (req, res) => {
  const row = q.taskById.get(req.params.id);
  if (!row) return res.status(404).json({ error: "Task not found." });
  const t = taskToApi(row);
  q.deleteTask.run(row.id);
  if (t.deleteReqByEmail && t.deleteReqByEmail !== req.user.email)
    email.send(t.deleteReqByEmail, t.deleteReqBy, `Task deleted: ${t.topic || "task"}`,
      `${req.user.name} approved your request and deleted the task "${t.topic || "task"}".`, req.user.name);
  res.json({ ok: true });
});

// Manager rejects (notify=true) or member cancels their own request (notify=false).
app.post("/api/tasks/:id/clear-delete", requireAuth, (req, res) => {
  const row = q.taskById.get(req.params.id);
  if (!row) return res.status(404).json({ error: "Task not found." });
  const notifyRequester = req.body.notify === true && req.user.role === "manager";
  // A member may only clear their own request.
  if (req.user.role !== "manager" && row.owner_email !== req.user.email)
    return res.status(403).json({ error: "Not your task." });
  const t = taskToApi(row);
  q.setDeleteReq.run({ id: row.id, req: 0, by: row.delete_req_by, byEmail: row.delete_req_by_email });
  if (notifyRequester && t.deleteReqByEmail && t.deleteReqByEmail !== req.user.email)
    email.send(t.deleteReqByEmail, t.deleteReqBy, `Deletion rejected: ${t.topic || "task"}`,
      `${req.user.name} rejected the request to delete "${t.topic || "task"}". It stays in your list.`, req.user.name);
  res.json({ ok: true });
});

/* ====================================================================== */
/*  NOTIFICATIONS (manager digest queue)                                   */
/* ====================================================================== */
app.get("/api/notifications/pending", requireAuth, requireManager, (req, res) => {
  res.json({ count: q.pendingNotifyTasks.all().length });
});

app.post("/api/notifications/flush", requireAuth, requireManager, async (req, res) => {
  const result = await notify.flushAllPending(req.user.name);
  res.json(result);
});

/* ====================================================================== */
/*  CONFIG (shared columns + dropdown values)                              */
/* ====================================================================== */
const CONFIG_NAMES = new Set(["columns", "options"]);
app.get("/api/config/:name", requireAuth, (req, res) => {
  const name = req.params.name;
  if (!CONFIG_NAMES.has(name)) return res.status(404).json({ error: "Unknown config." });
  const row = q.getConfig.get(name);
  res.json({ value: row ? JSON.parse(row.value) : null });
});

app.put("/api/config/:name", requireAuth, requireManager, (req, res) => {
  const name = req.params.name;
  if (!CONFIG_NAMES.has(name)) return res.status(404).json({ error: "Unknown config." });
  q.setConfig.run({ name, value: JSON.stringify(req.body.value ?? null) });
  res.json({ ok: true });
});

/* ====================================================================== */
/*  LINKS (per-user, with access control)                                  */
/* ====================================================================== */
function canSeeLink(row, me) {
  if (row.owner_email === me) return true;
  if (row.access === "all") return true;
  if (row.access === "users") {
    const list = row.shared_with ? JSON.parse(row.shared_with) : [];
    return list.map(x => String(x).toLowerCase()).includes(me);
  }
  return false;   // 'me' = private to its owner
}
function readLinkBody(body) {
  const name = (body.name || "").trim();
  let url = (body.url || "").trim();
  if (url && !/^https?:\/\//i.test(url)) url = "https://" + url;
  const access = ["me", "all", "users"].includes(body.access) ? body.access : "me";
  const users = access === "users" && Array.isArray(body.users)
    ? [...new Set(body.users.map(u => String(u).toLowerCase()).filter(Boolean))] : [];
  return { name, url, access, users };
}

app.get("/api/links", requireAuth, (req, res) => {
  const me = req.user.email;
  const rows = q.allLinks.all().filter(r => canSeeLink(r, me));
  res.json({ links: rows.map(r => ({
    ...linkToApi(r),
    canManage: r.owner_email === me || req.user.role === "manager",
  })) });
});

app.post("/api/links", requireAuth, (req, res) => {
  const { name, url, access, users } = readLinkBody(req.body);
  if (!name || !url) return res.status(400).json({ error: "Name and URL are required." });
  q.insertLink.run({
    id: crypto.randomUUID(), owner_email: req.user.email, owner_name: req.user.name,
    name, url, access, shared_with: JSON.stringify(users), created_at: Date.now(),
  });
  res.json({ ok: true });
});

app.put("/api/links/:id", requireAuth, (req, res) => {
  const row = q.linkById.get(req.params.id);
  if (!row) return res.status(404).json({ error: "Link not found." });
  if (row.owner_email !== req.user.email && req.user.role !== "manager")
    return res.status(403).json({ error: "You can only edit your own links." });
  const { name, url, access, users } = readLinkBody(req.body);
  if (!name || !url) return res.status(400).json({ error: "Name and URL are required." });
  q.updateLink.run({ id: row.id, name, url, access, shared_with: JSON.stringify(users) });
  res.json({ ok: true });
});

app.delete("/api/links/:id", requireAuth, (req, res) => {
  const row = q.linkById.get(req.params.id);
  if (!row) return res.status(404).json({ error: "Link not found." });
  if (row.owner_email !== req.user.email && req.user.role !== "manager")
    return res.status(403).json({ error: "You can only delete your own links." });
  q.deleteLink.run(row.id);
  res.json({ ok: true });
});

/* ---- Static frontend (served last so /api routes win) ---- */
app.use(express.static(path.join(__dirname, "public")));

/* ---- Nightly "send forgotten updates" job (replaces the Cloud Function) ---- */
const cronExpr = process.env.NIGHTLY_CRON || "0 0 * * *";
const cronTz = process.env.TZ || "Asia/Kolkata";
if (cron.validate(cronExpr)) {
  cron.schedule(cronExpr, async () => {
    try {
      const r = await notify.flushAllPending("Team Task List");
      console.log(`[cron] nightly flush: ${r.recipients} recipient(s), cleared ${r.cleared} task(s).`);
    } catch (e) { console.error("[cron] nightly flush failed", e); }
  }, { timezone: cronTz });
  console.log(`[cron] nightly notification flush scheduled "${cronExpr}" (${cronTz})`);
} else {
  console.warn(`[cron] invalid NIGHTLY_CRON "${cronExpr}" — nightly auto-send disabled`);
}

app.listen(PORT, () => {
  console.log(`Team Task List (SQLite) running on ${APP_URL}`);
  if (!email.emailEnabled()) console.warn("[email] SMTP not configured — notifications & password emails are disabled.");
});
