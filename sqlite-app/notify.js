/* ======================================================================
   Notification logic — ported from the old in-browser code, now server-side.
   Builds the "pending" payload stored on a task, and flushes queued payloads
   as ONE digest email per recipient (so 10 tasks for one person = one email).
   ====================================================================== */
const { db, q, taskToApi } = require("./db");
const email = require("./email");

/* Every active manager's email (used when a member's change should tell managers). */
function managerEmails() {
  return db.prepare("SELECT email FROM users WHERE role='manager' AND active=1")
    .all().map(r => r.email.toLowerCase());
}
function userName(emailAddr) {
  const u = q.userByEmail.get((emailAddr || "").toLowerCase());
  return (u && u.name) || emailAddr;
}

function taskSummaryText(d) {
  const link = d.link && d.link.url ? `${d.link.name || d.link.url} — ${d.link.url}` : "—";
  return [
    `Topic: ${d.topic || "—"}`,
    `Type: ${d.type || "—"}`,
    `Priority: ${d.priority || "—"}`,
    `Status: ${d.status || "Pending"}`,
    `Assigned date: ${d.assignedDate || "—"}`,
    `Details: ${d.detail || "—"}`,
    `Remarks: ${d.remarks || "—"}`,
    `Link: ${link}`,
  ].join("\n");
}

/* Human-readable list of what changed between the old and new task. */
function diffSummary(oldT, data) {
  const fields = [
    ["topic", "Topic"], ["type", "Type"], ["detail", "Details"], ["priority", "Priority"],
    ["frequency", "Frequency"], ["status", "Status"], ["assignedDate", "Assigned date"],
    ["compDate", "Completion date"], ["remarks", "Remarks"],
  ];
  const lines = [];
  fields.forEach(([k, label]) => {
    const a = oldT?.[k] || "", b = data[k] || "";
    if (a !== b) lines.push(`• ${label}: "${a || "—"}" → "${b || "—"}"`);
  });
  const linkStr = l => (l && l.url) ? `${l.name || l.url} (${l.url})` : "";
  if (linkStr(oldT?.link) !== linkStr(data.link))
    lines.push(`• Link: "${linkStr(oldT?.link) || "—"}" → "${linkStr(data.link) || "—"}"`);
  if (oldT && data.ownerEmail && (oldT.ownerEmail || "") !== data.ownerEmail)
    lines.push(`• Reassigned to: ${data.ownerName || data.ownerEmail}`);
  return lines;
}

/* Build the pending-notification payload for a saved task (or null if no one to tell).
   actor = the signed-in user making the change: { email, name, role }. */
function buildNotify(isCreate, data, changes, actor) {
  if (!isCreate && (!changes || !changes.length)) return null;   // edit that changed nothing
  const me = (actor.email || "").toLowerCase();
  const isManager = actor.role === "manager";
  const topic = data.topic || "task";
  if (isManager) {
    const to = (data.ownerEmail || "").toLowerCase();
    if (!to || to === me) return null;               // manager owns it -> nobody to email
    const toName = data.ownerName || userName(to) || to;
    if (isCreate) {
      return { audience: to, toName, subject: `New task assigned: ${topic}`,
        message: `${actor.name} assigned you a new task.\n\n${taskSummaryText(data)}` };
    }
    return { audience: to, toName, subject: `Task updated: ${topic}`,
      message: `${actor.name} updated your task "${topic}".\n\n`
        + (changes.length ? `Changes:\n${changes.join("\n")}\n\n` : "") + taskSummaryText(data) };
  }
  // Member changed a task -> tell the manager(s).
  const verb = isCreate ? "created" : "updated";
  return { audience: "managers", toName: "", subject: `Task ${verb} by ${actor.name}: ${topic}`,
    message: `${actor.name} ${verb} a task.\n\n`
      + (!isCreate && changes.length ? `Changes:\n${changes.join("\n")}\n\n` : "") + taskSummaryText(data) };
}

/* Send the pending notifications on the given API-shaped tasks, ONE digest per
   recipient. Clears notify_pending only on tasks whose every recipient succeeded.
   Returns { recipients, cleared, ok }. */
async function flushItems(items, fromName) {
  if (!items || !items.length) return { recipients: 0, cleared: 0, ok: true };
  const managers = managerEmails();
  const byTo = {};                 // email -> [{ subject, message, toName }]
  const taskRecipients = {};       // id -> Set(email)
  for (const t of items) {
    const n = t.notify;
    const set = new Set();
    taskRecipients[t.id] = set;
    if (!n) continue;              // nothing to send -> safe to clear
    const recips = n.audience === "managers" ? managers : [n.audience];
    for (const r of recips) {
      const to = (r || "").toLowerCase();
      if (!to) continue;
      set.add(to);
      const toName = n.audience === "managers" ? (userName(to) || to) : (n.toName || to);
      (byTo[to] = byTo[to] || []).push({ subject: n.subject, message: n.message, toName });
    }
  }

  const okRecipients = new Set();
  for (const to of Object.keys(byTo)) {
    const list = byTo[to];
    const toName = list[0].toName || to;
    const subject = list.length === 1 ? list[0].subject : `Task updates (${list.length})`;
    const body = list.length === 1 ? list[0].message
      : `You have ${list.length} task updates:\n\n` + list.map((m, i) => `${i + 1}. ${m.message}`).join("\n\n———\n\n");
    const ok = await email.send(to, toName, subject, body, fromName);
    if (ok) okRecipients.add(to);
  }

  // Clear only tasks whose every recipient was delivered (no-recipient tasks clear too).
  const toClear = items.filter(t => [...taskRecipients[t.id]].every(r => okRecipients.has(r)));
  const clearTx = db.transaction((rows) => { rows.forEach(t => q.clearNotify.run(t.id)); });
  clearTx(toClear);
  return { recipients: Object.keys(byTo).length, cleared: toClear.length, ok: toClear.length === items.length };
}

/* Flush everything currently queued (used by the "Send updates" button + nightly cron). */
async function flushAllPending(fromName) {
  const items = q.pendingNotifyTasks.all().map(taskToApi);
  return flushItems(items, fromName);
}

module.exports = { buildNotify, diffSummary, taskSummaryText, managerEmails, flushItems, flushAllPending };
