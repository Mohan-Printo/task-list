/* ======================================================================
   Team Task List — browser client for the SQLite/Express backend.
   Talks to the /api/* endpoints with fetch, and polls for near-live updates
   (replacing Firestore's onSnapshot). UI/rendering is unchanged from before.
   ====================================================================== */

/* ---- Defaults (used until/unless a manager overrides them in Settings) ---- */
const OPTIONS = {
  priority:  ["P0", "P1", "P2", "P3", "P4"],
  type:      ["Ad-hoc", "Routine"],
  status:    ["Pending", "Working", "Phase 1 completed", "Completed", "On hold"],
  frequency: ["One-time", "Daily", "Weekly", "Bi-weekly", "Monthly", "Quarterly", "Half-yearly", "As needed"],
};
const MANAGER_STATUS = "Completed - Remove";
const BUILTIN_COLUMNS = [
  { key: "priority",     label: "Priority"  },
  { key: "assignedDate", label: "Assigned"  },
  { key: "topic",        label: "Topic"     },
  { key: "type",         label: "Type"      },
  { key: "detail",       label: "Details"   },
  { key: "frequency",    label: "Frequency" },
  { key: "compDate",     label: "Completed" },
  { key: "status",       label: "Status"    },
  { key: "remarks",      label: "Remarks"   },
  { key: "link",         label: "Link"      },
];
const OPTION_LISTS = [
  ["priority",  "Priority"],
  ["type",      "Type"],
  ["status",    "Status"],
  ["frequency", "Frequency"],
];

const $ = id => document.getElementById(id);
let me = null;                       // current user { email, name, role, active }
let allTasks = [], currentView = "mine";
let usersList = [];                  // directory from /api/users
let columnConfig = null, optionsConfig = null, linksConfig = null;
let editingId = null, editingUserEmail = null, reassignFrom = null, editingLinkIdx = null;
let currentType = "all", searchTerm = "", colFilters = {};   // active view's filters
// My tasks and Team each keep their OWN filters/search/sub-tab, independently.
let filterStore = { mine:{type:"all",search:"",cols:{}}, team:{type:"all",search:"",cols:{}} };
const expandedRows = new Set();
let pollTimer = null, tickCount = 0;

/* ---- Tiny fetch helper. Throws Error(message) on non-2xx. ---- */
async function api(method, url, body){
  const opt = { method, headers: {}, credentials: "same-origin" };
  if(body !== undefined){ opt.headers["Content-Type"] = "application/json"; opt.body = JSON.stringify(body); }
  const r = await fetch(url, opt);
  let data = null;
  try{ data = await r.json(); }catch(_){}
  if(r.status === 401 && me){ handleSignedOut(); throw new Error("Session expired. Please sign in again."); }
  if(!r.ok) throw new Error((data && data.error) || `Request failed (${r.status})`);
  return data || {};
}

/* ---------- Auth ---------- */
$("loginBtn").onclick = async () => {
  const email = $("email").value.trim(), pw = $("password").value;
  $("loginMsg").className = "msg";
  if(!email || !pw){ showLoginMsg("Enter your email and password.", true); return; }
  try{
    const { user } = await api("POST", "/api/login", { email, password: pw });
    me = user;
    await enterApp();
  }catch(e){ showLoginMsg(e.message, true); }
};
$("password").addEventListener("keydown", e => { if(e.key === "Enter") $("loginBtn").click(); });

$("resetBtn").onclick = async () => {
  const email = $("email").value.trim();
  $("loginMsg").className = "msg";
  if(!email){ showLoginMsg("Type your email above first, then click Forgot password.", true); return; }
  try{
    await api("POST", "/api/forgot", { email });
    showLoginMsg("If that email has an account, a reset link has been sent — check inbox and spam.", false);
  }catch(e){ showLoginMsg(e.message, true); }
};

$("logoutBtn").onclick = async () => { try{ await api("POST", "/api/logout"); }catch(_){} handleSignedOut(); };

function handleSignedOut(){
  me = null; allTasks = []; usersList = [];
  if(pollTimer){ clearInterval(pollTimer); pollTimer = null; }
  $("app").classList.add("hidden");
  $("login").classList.remove("hidden");
  $("password").value = "";
}
function showLoginMsg(t, err){ const m = $("loginMsg"); m.textContent = t; m.className = "msg " + (err ? "err" : "ok"); }

/* ---------- Enter app + polling ---------- */
async function enterApp(){
  $("login").classList.add("hidden");
  $("app").classList.remove("hidden");
  $("userName").textContent = me.name;
  $("userRole").textContent = me.role;
  const isManager = me.role === "manager";
  $("tabTeam").classList.toggle("hidden", !isManager);
  $("tabUsers").classList.toggle("hidden", !isManager);
  $("tabSettings").classList.toggle("hidden", !isManager);
  $("addLinkBtn").classList.remove("hidden");   // Links board is open to everyone
  filterStore = { mine:{type:"all",search:"",cols:{}}, team:{type:"all",search:"",cols:{}} };
  loadViewFilters("mine");
  currentView = "mine";
  setActiveTab("mine");
  await Promise.all([loadConfig(), loadUsers()]);
  await loadTasks();
  updateSendBtn();
  startPolling();
}

// Poll tasks every 5s; users/config + pending count every ~20s. Skip when a modal is open.
function startPolling(){
  if(pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    if(!me) return;
    if(document.hidden) return;
    if(anyModalOpen()) return;                     // don't yank data out from under an open form
    tickCount++;
    try{
      if(currentView === "mine" || currentView === "team") await loadTasks();
      if(tickCount % 4 === 0){ await loadUsers(); await loadConfig(); }
      if(me.role === "manager") await refreshPending();
    }catch(_){ /* transient; next tick retries */ }
  }, 5000);
}
function anyModalOpen(){
  return ["modalOverlay","userOverlay","reassignOverlay","colOverlay","linkOverlay"]
    .some(id => !$(id).classList.contains("hidden"));
}

/* ---------- Data loaders ---------- */
async function loadTasks(){
  const view = currentView === "team" ? "team" : "mine";
  const { tasks } = await api("GET", `/api/tasks?view=${view}`);
  allTasks = tasks;
  if(currentView === "mine" || currentView === "team") render();
}
async function loadUsers(){
  const { users } = await api("GET", "/api/users");
  usersList = users;
  if(currentView === "users") renderUsers();
}
async function loadConfig(){
  const [cols, opts, links] = await Promise.all([
    api("GET", "/api/config/columns"),
    api("GET", "/api/config/options"),
    api("GET", "/api/config/links"),
  ]);
  columnConfig = cols.value ? { columns: cols.value } : null;
  optionsConfig = opts.value || null;
  linksConfig = links.value || null;
  if(currentView === "settings") renderSettings();
  if(currentView === "links") renderLinks();
}
async function refreshPending(){
  try{ const { count } = await api("GET", "/api/notifications/pending"); setSendCount(count); }
  catch(_){}
}

/* ---------- Effective config (stored overrides code defaults) ---------- */
function effectiveOptions(){
  const o = optionsConfig || {};
  const pick = k => (Array.isArray(o[k]) && o[k].length) ? o[k] : OPTIONS[k];
  return { priority: pick("priority"), type: pick("type"), status: pick("status"), frequency: pick("frequency") };
}
function currentLists(){
  const o = effectiveOptions();
  return { priority:o.priority.slice(), type:o.type.slice(), status:o.status.slice(), frequency:o.frequency.slice() };
}
function effectiveColumns(){
  const known = new Set(BUILTIN_COLUMNS.map(c => c.key));
  const defLabel = Object.fromEntries(BUILTIN_COLUMNS.map(c => [c.key, c.label]));
  let cols;
  if(columnConfig && Array.isArray(columnConfig.columns) && columnConfig.columns.length){
    cols = columnConfig.columns
      .filter(c => c && c.key && (c.builtin ? known.has(c.key) : true))
      .map(c => ({ ...c, builtin: !!c.builtin, visible: c.visible !== false }));
    const present = new Set(cols.map(c => c.key));
    BUILTIN_COLUMNS.forEach(b => { if(!present.has(b.key)) cols.push({ key:b.key, label:b.label, builtin:true, visible:true }); });
  } else {
    cols = BUILTIN_COLUMNS.map(c => ({ key:c.key, label:c.label, builtin:true, visible:true }));
  }
  cols.forEach(c => { if(c.builtin && !c.label) c.label = defLabel[c.key] || c.key; });
  return cols;
}

/* ---------- Directory helpers ---------- */
function directory(){
  const out = {};
  usersList.forEach(u => { out[u.email.toLowerCase()] = u; });
  return out;
}
function getUser(email){
  return directory()[(email||"").toLowerCase()] || { email:(email||"").toLowerCase(), name: email, role:"member", active:true };
}
function activeUsers(){
  return usersList.filter(u => u.active !== false).sort((a,b) => (a.name||"").localeCompare(b.name||""));
}

/* ---------- Dropdown fill ---------- */
function fillSelect(id, arr, blankLabel){
  const sel = $(id);
  sel.innerHTML = (blankLabel != null ? `<option value="">${blankLabel}</option>` : "")
    + arr.map(o => `<option>${esc(o)}</option>`).join("");
}

/* ---------- Tabs ---------- */
document.querySelectorAll(".tab").forEach(t => t.onclick = async () => {
  const v = t.dataset.view;
  if(v === currentView) return;
  const prev = currentView;
  currentView = v;
  closeFilterPop();
  saveViewFilters(prev);              // remember the view we're leaving
  if(v === "mine" || v === "team") loadViewFilters(v);   // restore this view's own filters
  setActiveTab(v);
  if(v === "users"){ await loadUsers(); renderUsers(); }
  else if(v === "settings"){ await loadConfig(); renderSettings(); }
  else if(v === "links"){ await loadConfig(); renderLinks(); }
  else { await loadTasks(); }
});
function setActiveTab(v){
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.dataset.view === v));
  const isTasks = (v === "mine" || v === "team");
  $("tasksView").classList.toggle("hidden", !isTasks);
  $("usersView").classList.toggle("hidden", v !== "users");
  $("settingsView").classList.toggle("hidden", v !== "settings");
  $("linksView").classList.toggle("hidden", v !== "links");
  $("tabActions").classList.toggle("hidden", !isTasks);   // task action buttons only on task views
}

/* ---------- Per-view filter state (My tasks vs Team are independent) ---------- */
function saveViewFilters(view){
  if(view === "mine" || view === "team")
    filterStore[view] = { type: currentType, search: searchTerm, cols: colFilters };
}
function loadViewFilters(view){
  const s = filterStore[view] || { type:"all", search:"", cols:{} };
  currentType = s.type; searchTerm = s.search; colFilters = s.cols;
  $("searchInput").value = searchTerm;
  syncSubtabs();
}

/* ---------- Sub-tabs (All / Ad-hoc / Routine) + smart search ---------- */
function syncSubtabs(){
  document.querySelectorAll("#subtabs .subtab").forEach(b =>
    b.classList.toggle("active", b.dataset.type === currentType));
}
document.querySelectorAll("#subtabs .subtab").forEach(b => b.onclick = () => {
  currentType = b.dataset.type; syncSubtabs(); closeFilterPop(); render();
});
$("searchInput").addEventListener("input", e => { searchTerm = e.target.value.trim().toLowerCase(); render(); });
$("clearFiltersBtn").onclick = () => {
  colFilters = {}; searchTerm = ""; $("searchInput").value = ""; closeFilterPop(); render();
};

/* ---------- Render tasks ---------- */
/* Full searchable text of a task (for the smart search box). */
function taskSearchText(t){
  const parts = [t.ownerName, t.topic, t.detail, t.remarks, t.type, t.priority, t.status,
    t.frequency, t.assignedDate, t.compDate, t.link && t.link.name, t.link && t.link.url];
  if(t.custom) parts.push(...Object.values(t.custom));
  return parts.filter(Boolean).join("  ").toLowerCase();
}
/* Display text of one column for a task — used by filters, search and export.
   colKey "owner" is the pseudo-column shown first on the Team view. */
function colText(colKey, t){
  if(colKey === "owner") return t.ownerName || "";
  if(colKey === "link")  return (t.link && t.link.name) || "";
  const col = effectiveColumns().find(c => c.key === colKey);
  if(col && !col.builtin) return (t.custom && t.custom[colKey]) || "";
  if(colKey === "status"){
    const removed = t.status === MANAGER_STATUS;
    return (currentView !== "team" && removed) ? "Completed" : (t.status || "Pending");
  }
  return t[colKey] || "";
}

function currentRows(){
  let rows = allTasks.slice();
  // Sub-tab: a task is "Routine" only when the word "routine" appears in its Type.
  // Everything else — "Ad-hoc", blank, "-", or any other value — falls under Ad-hoc.
  if(currentType === "Routine")     rows = rows.filter(r => (r.type||"").toLowerCase().includes("routine"));
  else if(currentType === "Ad-hoc") rows = rows.filter(r => !(r.type||"").toLowerCase().includes("routine"));
  if(searchTerm) rows = rows.filter(r => taskSearchText(r).includes(searchTerm));
  for(const key of Object.keys(colFilters)){
    const allowed = colFilters[key];
    rows = rows.filter(r => allowed.has(colText(key, r)));
  }
  const doneRank = s => (s === MANAGER_STATUS ? 2 : (s === "Completed" ? 1 : 0));
  rows.sort((a,b) => {
    const d = doneRank(a.status) - doneRank(b.status);
    if(d !== 0) return d;
    return (b.createdAt||0) - (a.createdAt||0);
  });
  return rows;
}
function cellValue(col, t){
  if(!col.builtin) return (t.custom && t.custom[col.key]) || "";
  if(col.key === "status"){
    const removed = t.status === MANAGER_STATUS;
    return (currentView !== "team" && removed) ? "Completed" : (t.status || "Pending");
  }
  if(col.key === "link") return (t.link && t.link.name) ? (t.link.name + (t.link.url ? ` (${t.link.url})` : "")) : "";
  return t[col.key] || "";
}
// One header cell with its Google-Sheets-style filter button.
function thCell(colKey, label){
  const active = !!colFilters[colKey];
  return `<th><div class="th-wrap"><span>${esc(label)}</span>`
    + `<button class="col-filter ${active?"active":""}" data-fcol="${esc(colKey)}" title="Filter this column">▾</button></div></th>`;
}
function render(){
  const team = currentView === "team";
  const rows = currentRows();
  const cols = effectiveColumns().filter(c => c.visible);
  const head = [];
  if(team) head.push(thCell("owner", "Owner"));
  cols.forEach(c => head.push(thCell(c.key, c.label)));
  head.push(`<th>Actions</th>`);
  $("taskHead").innerHTML = `<tr>${head.join("")}</tr>`;
  $("taskHead").querySelectorAll("[data-fcol]").forEach(b => b.onclick = ev => {
    ev.stopPropagation(); openFilterPop(b.dataset.fcol, b);
  });

  const hasFilters = Object.keys(colFilters).length > 0 || !!searchTerm;
  $("clearFiltersBtn").classList.toggle("hidden", !hasFilters);

  const isManager = me.role === "manager";
  const body = $("taskBody");
  if(rows.length === 0){
    $("emptyState").innerHTML = hasFilters
      ? "<b>No matching tasks</b>Try clearing the search or filters."
      : "<b>No tasks yet</b>Add your first task with the button above.";
  }
  $("emptyState").classList.toggle("hidden", rows.length !== 0);
  body.innerHTML = rows.map(t => {
    const removed = t.status === MANAGER_STATUS;
    const displayStatus = (!team && removed) ? "Completed" : (t.status || "Pending");
    const classes = [];
    if(team && removed) classes.push("row-removed");
    if(t.deleteRequested) classes.push("row-delpending");
    const rowCls = classes.length ? ` class="${classes.join(" ")}"` : "";
    const open = expandedRows.has(t.id);
    const cells = [];
    if(team) cells.push(`<td>${esc(t.ownerName||"")}</td>`);
    cols.forEach(c => cells.push(renderCell(c, t, open, displayStatus)));
    cells.push(renderActions(t, isManager));
    return `<tr${rowCls}>${cells.join("")}</tr>`;
  }).join("");

  body.querySelectorAll("[data-edit]").forEach(b => b.onclick = () => openModal(b.dataset.edit));
  body.querySelectorAll("[data-del]").forEach(b => b.onclick = () => removeTask(b.dataset.del));
  body.querySelectorAll("[data-approvedel]").forEach(b => b.onclick = () => approveDelete(b.dataset.approvedel));
  body.querySelectorAll("[data-rejectdel]").forEach(b => b.onclick = () => clearDeleteRequest(b.dataset.rejectdel, true));
  body.querySelectorAll("[data-canceldel]").forEach(b => b.onclick = () => clearDeleteRequest(b.dataset.canceldel, false));
  body.querySelectorAll("[data-exp]").forEach(b => b.onclick = () => {
    const id = b.dataset.exp;
    expandedRows.has(id) ? expandedRows.delete(id) : expandedRows.add(id);
    render();
  });
}
function renderCell(col, t, open, displayStatus){
  if(!col.builtin){
    const v = (t.custom && t.custom[col.key]) || "";
    return `<td>${v ? esc(v) : "—"}</td>`;
  }
  switch(col.key){
    case "topic":  return `<td>${esc(t.topic||"")}</td>`;
    case "status": return `<td><span class="status-pill ${statusClass(displayStatus)}">${esc(displayStatus)}</span></td>`;
    case "detail": {
      const detail = t.detail || "";
      const inner = detail
        ? `<div class="cell-text">${esc(detail)}</div>`
          + (detail.length > 90 ? `<button class="expand-toggle" data-exp="${t.id}">${open ? "Show less" : "Show more"}</button>` : "")
        : "—";
      return `<td class="detail ${open?"open":""}">${inner}</td>`;
    }
    case "remarks": {
      const remarks = t.remarks || "";
      return `<td class="remarks ${open?"open":""}">${remarks ? `<div class="cell-text">${esc(remarks)}</div>` : "—"}</td>`;
    }
    case "link": {
      const l = t.link;
      if(l && l.url) return `<td><a class="tasklink" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(l.name || l.url)}</a></td>`;
      if(l && l.name) return `<td>${esc(l.name)}</td>`;
      return `<td>—</td>`;
    }
    default: return `<td>${esc(t[col.key] || "—")}</td>`;
  }
}
function statusClass(s){
  if(s==="Completed") return "s-Completed";
  if(s===MANAGER_STATUS) return "s-Removed";
  if(s==="Working") return "s-Working";
  if(s==="Phase 1 completed") return "s-Phase";
  if(s==="On hold") return "s-Hold";
  return "s-Pending";
}
function renderActions(t, isManager){
  const pending = t.deleteRequested === true;
  const btns = [`<button class="icon-btn" data-edit="${t.id}">Edit</button>`];
  if(pending){
    if(isManager){
      btns.push(`<button class="icon-btn del" data-approvedel="${t.id}">Approve delete</button>`);
      btns.push(`<button class="icon-btn" data-rejectdel="${t.id}">Reject</button>`);
    } else {
      btns.push(`<button class="icon-btn" data-canceldel="${t.id}">Cancel request</button>`);
    }
  } else {
    btns.push(`<button class="icon-btn del" data-del="${t.id}">Delete</button>`);
  }
  const who = (isManager && t.deleteReqBy) ? ` by ${esc(t.deleteReqBy)}` : "";
  const flag = pending ? `<div class="del-pending">⏳ Delete requested${who}</div>` : "";
  return `<td>${flag}<div class="row-actions">${btns.join("")}</div></td>`;
}

function todayISO(){
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}
function esc(s){ return String(s??"").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }

/* ---------- Add / edit task modal ---------- */
$("addBtn").onclick = () => openModal(null);
$("closeModal").onclick = $("cancelBtn").onclick = closeModal;

function openModal(id){
  editingId = id;
  $("modalMsg").textContent = "";
  const t = id ? allTasks.find(x => x.id === id) : {};
  $("modalTitle").textContent = id ? "Edit task" : "Add task";

  const isManager = me.role === "manager";
  $("assignField").classList.toggle("hidden", !isManager);
  if(isManager){
    $("f_assignee").innerHTML = activeUsers().map(u => `<option value="${esc(u.email)}">${esc(u.name)}</option>`).join("");
    $("f_assignee").value = (id && t.ownerEmail) ? t.ownerEmail : me.email;
  }

  const opt = effectiveOptions();
  fillSelect("f_priority", opt.priority, "—");
  fillSelect("f_type",     opt.type,     "—");
  fillSelect("f_freq",     opt.frequency, "—");
  const statusList = isManager ? [...opt.status, MANAGER_STATUS] : opt.status;
  $("f_status").innerHTML = statusList.map(o => `<option>${esc(o)}</option>`).join("");

  $("f_topic").value    = t.topic || "";
  $("f_detail").value   = t.detail || "";
  $("f_type").value     = t.type || "";
  $("f_priority").value = t.priority || "";
  $("f_freq").value     = t.frequency || "";
  let statusVal = t.status || "Pending";
  if(!isManager && statusVal === MANAGER_STATUS) statusVal = "Completed";
  $("f_status").value   = statusVal;
  $("f_assigned").value = t.assignedDate || (id ? "" : todayISO());
  $("f_comp").value     = t.compDate || "";
  $("f_remarks").value  = t.remarks || "";
  $("f_linkname").value = (t.link && t.link.name) || "";
  $("f_linkurl").value  = (t.link && t.link.url)  || "";

  const customCols = effectiveColumns().filter(c => !c.builtin);
  $("customFields").innerHTML = customCols.map(c => {
    const val = (t.custom && t.custom[c.key]) || "";
    let input;
    if(c.type === "date"){
      input = `<input type="date" data-cf="${esc(c.key)}" value="${esc(val)}" />`;
    } else if(c.type === "select"){
      input = `<select data-cf="${esc(c.key)}"><option value="">—</option>`
        + (c.options||[]).map(o => `<option ${o===val?"selected":""}>${esc(o)}</option>`).join("")
        + `</select>`;
    } else {
      input = `<input type="text" data-cf="${esc(c.key)}" value="${esc(val)}" />`;
    }
    return `<div class="field full"><label>${esc(c.label)}</label>${input}</div>`;
  }).join("");

  $("modalOverlay").classList.remove("hidden");
  $("f_topic").focus();
}
function closeModal(){ $("modalOverlay").classList.add("hidden"); editingId = null; }

$("saveBtn").onclick = async () => {
  const topic = $("f_topic").value.trim();
  if(!topic){ $("modalMsg").textContent = "Task topic is required."; return; }
  const custom = {};
  document.querySelectorAll("#customFields [data-cf]").forEach(el => {
    const v = (el.value || "").trim();
    if(v) custom[el.dataset.cf] = v;
  });
  let linkUrl    = $("f_linkurl").value.trim();
  const linkName = $("f_linkname").value.trim();
  if(linkUrl && !/^https?:\/\//i.test(linkUrl)) linkUrl = "https://" + linkUrl;  // tolerate a bare domain
  const data = {
    topic,
    type:         $("f_type").value,
    detail:       $("f_detail").value.trim(),
    priority:     $("f_priority").value,
    frequency:    $("f_freq").value.trim(),
    status:       $("f_status").value,
    assignedDate: $("f_assigned").value,
    compDate:     $("f_comp").value,
    remarks:      $("f_remarks").value.trim(),
    link:         linkUrl ? { url: linkUrl, name: linkName || linkUrl } : null,
    custom,
  };
  if(me.role === "manager") data.ownerEmail = $("f_assignee").value.toLowerCase();

  $("saveBtn").disabled = true;
  try{
    if(editingId) await api("PUT", `/api/tasks/${editingId}`, data);
    else          await api("POST", "/api/tasks", data);
    closeModal();
    await loadTasks();
    if(me.role === "manager") refreshPending();
  }catch(e){ $("modalMsg").textContent = e.message; }
  finally{ $("saveBtn").disabled = false; }
};

/* ---------- Delete flows ---------- */
async function removeTask(id){
  const t = allTasks.find(x => x.id === id);
  const isManager = me.role === "manager";
  if(isManager){
    if(!confirm(`Delete "${t?.topic||"this task"}"? This cannot be undone.`)) return;
    try{ await api("DELETE", `/api/tasks/${id}`); await loadTasks(); }
    catch(e){ alert(e.message); }
    return;
  }
  if(!confirm(`Request deletion of "${t?.topic||"this task"}"?\nA manager must approve before it is removed.`)) return;
  try{ await api("POST", `/api/tasks/${id}/request-delete`); await loadTasks(); alert("Deletion request sent. A manager will review it."); }
  catch(e){ alert(e.message); }
}
async function approveDelete(id){
  const t = allTasks.find(x => x.id === id);
  if(!confirm(`Approve deletion of "${t?.topic||"this task"}"? This permanently removes it.`)) return;
  try{ await api("POST", `/api/tasks/${id}/approve-delete`); await loadTasks(); }
  catch(e){ alert(e.message); }
}
async function clearDeleteRequest(id, notifyRequester){
  const t = allTasks.find(x => x.id === id);
  if(notifyRequester && !confirm(`Reject the deletion request for "${t?.topic||"this task"}"?`)) return;
  try{ await api("POST", `/api/tasks/${id}/clear-delete`, { notify: notifyRequester }); await loadTasks(); }
  catch(e){ alert(e.message); }
}

/* ---------- Send updates (manager digest) ---------- */
function setSendCount(n){
  const btn = $("sendMailBtn");
  const isManager = me && me.role === "manager";
  btn.classList.toggle("hidden", !isManager);
  btn.disabled = !n;
  btn.textContent = n ? `✉ Send updates (${n})` : "✉ No updates to send";
}
function updateSendBtn(){ if(me && me.role === "manager") refreshPending(); else setSendCount(0); }
$("sendMailBtn").onclick = async () => {
  const btn = $("sendMailBtn");
  btn.disabled = true; const prev = btn.textContent; btn.textContent = "Sending…";
  try{
    const r = await api("POST", "/api/notifications/flush");
    if(!r.ok && r.cleared < r.recipients) alert("Some emails could not be sent (check the server log / SMTP). They stay queued and will retry.");
  }catch(e){ alert(e.message); }
  finally{ btn.textContent = prev; refreshPending(); }
};

/* ---------- Excel export (client-side, unchanged) ---------- */
$("exportBtn").onclick = async () => {
  const btn = $("exportBtn");
  btn.disabled = true; const prev = btn.textContent; btn.textContent = "Preparing…";
  try{
    const XLSX = await import("https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs");
    const team = currentView === "team";
    const rows = currentRows();
    const cols = effectiveColumns().filter(c => c.visible);
    const header = [];
    if(team) header.push("Owner");
    cols.forEach(c => header.push(c.label));
    const aoa = [header];
    rows.forEach(t => {
      const r = [];
      if(team) r.push(t.ownerName || "");
      cols.forEach(c => r.push(cellValue(c, t)));
      aoa.push(r);
    });
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!cols"] = header.map(h => ({ wch: Math.min(Math.max(h.length + 2, 12), 40) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Tasks");
    XLSX.writeFile(wb, `tasks-${team ? "team" : "mine"}-${todayISO()}.xlsx`);
  }catch(e){
    console.error(e);
    alert("Could not export to Excel. Check your internet connection (the Excel library loads from a CDN).");
  }finally{ btn.disabled = false; btn.textContent = prev; }
};

/* ====================================================================== */
/*  SETTINGS: columns + dropdown values (manager only)                     */
/* ====================================================================== */
function renderSettings(){ renderColumns(); renderOptions(); }

function renderColumns(){
  const cols = effectiveColumns();
  $("colBody").innerHTML = cols.map((c, i) => {
    const typeLabel = c.builtin ? "—"
      : (c.type === "date" ? "Date" : c.type === "select" ? `Dropdown (${(c.options||[]).length})` : "Text");
    return `<tr>
      <td><div class="row-actions">
        <button class="icon-btn" data-cup="${i}" ${i===0?"disabled":""} title="Move up">↑</button>
        <button class="icon-btn" data-cdown="${i}" ${i===cols.length-1?"disabled":""} title="Move down">↓</button>
      </div></td>
      <td>${esc(c.label)}${c.builtin?` <span class="tag-builtin">built-in</span>`:""}</td>
      <td>${typeLabel}</td>
      <td style="text-align:center"><input type="checkbox" data-cvis="${i}" ${c.visible?"checked":""} style="width:auto" /></td>
      <td><div class="row-actions">
        <button class="icon-btn" data-cren="${i}">Rename</button>
        ${c.builtin?"":`<button class="icon-btn del" data-cdel="${i}">Delete</button>`}
      </div></td>
    </tr>`;
  }).join("");
  const body = $("colBody");
  body.querySelectorAll("[data-cup]").forEach(b => b.onclick = () => moveColumn(+b.dataset.cup, -1));
  body.querySelectorAll("[data-cdown]").forEach(b => b.onclick = () => moveColumn(+b.dataset.cdown, +1));
  body.querySelectorAll("[data-cvis]").forEach(b => b.onchange = () => toggleColumn(+b.dataset.cvis, b.checked));
  body.querySelectorAll("[data-cren]").forEach(b => b.onclick = () => renameColumn(+b.dataset.cren));
  body.querySelectorAll("[data-cdel]").forEach(b => b.onclick = () => deleteColumn(+b.dataset.cdel));
}
function moveColumn(i, dir){
  const cols = effectiveColumns(); const j = i + dir;
  if(j < 0 || j >= cols.length) return;
  [cols[i], cols[j]] = [cols[j], cols[i]];
  saveColumns(cols);
}
function toggleColumn(i, visible){ const cols = effectiveColumns(); if(!cols[i]) return; cols[i].visible = visible; saveColumns(cols); }
function renameColumn(i){
  const cols = effectiveColumns(); if(!cols[i]) return;
  const name = prompt("Column name:", cols[i].label);
  if(name == null) return;
  const trimmed = name.trim(); if(!trimmed) return;
  cols[i].label = trimmed; saveColumns(cols);
}
function deleteColumn(i){
  const cols = effectiveColumns();
  if(!cols[i] || cols[i].builtin) return;
  if(!confirm(`Delete the "${cols[i].label}" column? Existing task values for it stay in the database but stop showing.`)) return;
  cols.splice(i, 1); saveColumns(cols);
}
async function saveColumns(cols){
  columnConfig = { columns: cols };
  renderSettings(); render();
  try{ await api("PUT", "/api/config/columns", { value: cols }); }
  catch(e){ alert("Could not save column settings: " + e.message); }
}

$("addColBtn").onclick = () => {
  $("c_label").value = ""; $("c_type").value = "text"; $("c_options").value = "";
  $("c_optionsField").classList.add("hidden"); $("colModalMsg").textContent = "";
  $("colOverlay").classList.remove("hidden"); $("c_label").focus();
};
$("closeColModal").onclick = $("cancelColBtn").onclick = () => $("colOverlay").classList.add("hidden");
$("c_type").onchange = () => $("c_optionsField").classList.toggle("hidden", $("c_type").value !== "select");
$("saveColBtn").onclick = async () => {
  const label = $("c_label").value.trim();
  if(!label){ $("colModalMsg").textContent = "Column name is required."; return; }
  const type = $("c_type").value;
  const col = { key: "c_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), label, builtin:false, type, visible:true };
  if(type === "select"){
    col.options = $("c_options").value.split("\n").map(s => s.trim()).filter(Boolean);
    if(!col.options.length){ $("colModalMsg").textContent = "Add at least one dropdown option."; return; }
  }
  const cols = effectiveColumns(); cols.push(col);
  $("saveColBtn").disabled = true;
  try{ await saveColumns(cols); $("colOverlay").classList.add("hidden"); }
  finally{ $("saveColBtn").disabled = false; }
};

function renderOptions(){
  const opt = effectiveOptions();
  $("optsBody").innerHTML = OPTION_LISTS.map(([key, label]) => {
    const chips = opt[key].map((v, i) => `
      <span class="chip">
        <span class="chip-label" data-orren="${key}:${i}" title="Click to rename">${esc(v)}</span>
        <button class="chip-x" data-ordel="${key}:${i}" title="Remove">✕</button>
      </span>`).join("");
    return `<div class="opt-group">
      <div class="opt-head">${esc(label)}</div>
      <div class="chips">${chips || '<span style="color:var(--muted);font-size:13px">No values yet</span>'}</div>
      <div class="opt-add">
        <input type="text" data-orinput="${key}" placeholder="Add a ${esc(label.toLowerCase())} value…" />
        <button class="btn-secondary" data-oradd="${key}">Add</button>
      </div>
    </div>`;
  }).join("");
  const body = $("optsBody");
  body.querySelectorAll("[data-oradd]").forEach(b => b.onclick = () => addOption(b.dataset.oradd));
  body.querySelectorAll("[data-orinput]").forEach(inp => inp.onkeydown = e => { if(e.key === "Enter"){ e.preventDefault(); addOption(inp.dataset.orinput); } });
  body.querySelectorAll("[data-ordel]").forEach(b => b.onclick = () => { const [k,i] = b.dataset.ordel.split(":"); removeOption(k, +i); });
  body.querySelectorAll("[data-orren]").forEach(el => el.onclick = () => { const [k,i] = el.dataset.orren.split(":"); renameOption(k, +i); });
}
function isReserved(key, v){ return key === "status" && v === MANAGER_STATUS; }
function addOption(key){
  const inp = $("optsBody").querySelector(`[data-orinput="${key}"]`);
  const v = (inp?.value || "").trim();
  if(!v) return;
  const lists = currentLists();
  if(lists[key].some(x => x.toLowerCase() === v.toLowerCase()) || isReserved(key, v)){ if(inp) inp.value = ""; return; }
  lists[key].push(v); saveOptions(lists);
}
function renameOption(key, i){
  const lists = currentLists(); const cur = lists[key][i];
  if(cur == null) return;
  const nv = prompt(`Rename "${cur}" to:`, cur);
  if(nv == null) return;
  const t = nv.trim();
  if(!t || isReserved(key, t)) return;
  if(lists[key].some((x, j) => j !== i && x.toLowerCase() === t.toLowerCase())) return;
  lists[key][i] = t; saveOptions(lists);
}
function removeOption(key, i){
  const lists = currentLists();
  if(lists[key][i] == null) return;
  if(!confirm(`Remove "${lists[key][i]}" from ${key}?`)) return;
  lists[key].splice(i, 1); saveOptions(lists);
}
async function saveOptions(lists){
  optionsConfig = lists; renderOptions();
  try{ await api("PUT", "/api/config/options", { value: lists }); }
  catch(e){ alert("Could not save dropdown values: " + e.message); }
}

/* ====================================================================== */
/*  USER MANAGEMENT (manager only)                                         */
/* ====================================================================== */
function renderUsers(){
  const list = usersList.slice().sort((a,b) => (a.name||"").localeCompare(b.name||""));
  const meEmail = (me?.email || "").toLowerCase();
  $("userBody").innerHTML = list.map(u => {
    const inactive = u.active === false;
    const isMe = u.email === meEmail;
    return `<tr style="${inactive ? "opacity:.55" : ""}">
      <td>${esc(u.name||"")}</td>
      <td>${esc(u.email)}</td>
      <td>${esc(u.role||"member")}</td>
      <td><span class="status-pill ${inactive ? "s-Hold" : "s-Completed"}">${inactive ? "Inactive" : "Active"}</span></td>
      <td><div class="row-actions">
        <button class="icon-btn" data-uedit="${esc(u.email)}">Edit</button>
        <button class="icon-btn" data-ureset="${esc(u.email)}">Reset password</button>
        ${inactive
          ? `<button class="icon-btn" data-ureactivate="${esc(u.email)}">Reactivate</button>`
          : `<button class="icon-btn" data-ureassign="${esc(u.email)}" ${isMe ? "disabled title='You cannot remove yourself'" : ""}>Reassign &amp; remove</button>`}
        <button class="icon-btn del" data-udelete="${esc(u.email)}" ${isMe ? "disabled title='You cannot delete yourself'" : ""}>Delete</button>
      </div></td>
    </tr>`;
  }).join("");
  $("userBody").querySelectorAll("[data-uedit]").forEach(b => b.onclick = () => openUserModal(b.dataset.uedit));
  $("userBody").querySelectorAll("[data-ureset]").forEach(b => b.onclick = () => resetUserPassword(b.dataset.ureset));
  $("userBody").querySelectorAll("[data-ureassign]").forEach(b => b.onclick = () => { if(!b.disabled) openReassign(b.dataset.ureassign); });
  $("userBody").querySelectorAll("[data-ureactivate]").forEach(b => b.onclick = () => reactivateUser(b.dataset.ureactivate));
  $("userBody").querySelectorAll("[data-udelete]").forEach(b => b.onclick = () => { if(!b.disabled) deleteUser(b.dataset.udelete); });
}

$("addUserBtn").onclick = () => openUserModal(null);
$("closeUserModal").onclick = $("cancelUserBtn").onclick = () => $("userOverlay").classList.add("hidden");
function openUserModal(email){
  editingUserEmail = email;
  $("userModalMsg").textContent = ""; $("userModalMsg").className = "msg err";
  const u = email ? getUser(email) : { name:"", role:"member", active:true };
  $("userModalTitle").textContent = email ? "Edit user" : "Add user";
  $("u_name").value  = u.name || "";
  $("u_email").value = email || "";
  $("u_email").disabled = !!email;
  $("u_emailHint").style.display = email ? "none" : "block";
  $("u_password").value = "";
  $("u_passwordField").style.display = email ? "none" : "block";
  $("u_role").value   = u.role || "member";
  $("u_active").value = String(u.active !== false);
  $("userOverlay").classList.remove("hidden");
  $(email ? "u_name" : "u_email").focus();
}
$("saveUserBtn").onclick = async () => {
  const name  = $("u_name").value.trim();
  const email = (editingUserEmail || $("u_email").value.trim()).toLowerCase();
  if(!name){ $("userModalMsg").textContent = "Name is required."; return; }
  if(!email || !email.includes("@")){ $("userModalMsg").textContent = "A valid email is required."; return; }
  const isNew = !editingUserEmail;
  const pw = isNew ? $("u_password").value.trim() : "";
  if(pw && pw.length < 6){ $("userModalMsg").textContent = "Password must be at least 6 characters (or leave it blank)."; return; }
  const body = { email, name, role: $("u_role").value, active: $("u_active").value === "true" };
  if(pw) body.password = pw;
  $("saveUserBtn").disabled = true;
  try{
    const r = await api("POST", "/api/users", body);
    await loadUsers();
    if(isNew){
      $("userModalMsg").className = "msg ok";
      $("userModalMsg").textContent = r.note || "Login created.";
      setTimeout(() => $("userOverlay").classList.add("hidden"), 1800);
    } else {
      $("userOverlay").classList.add("hidden");
    }
  }catch(e){ $("userModalMsg").className = "msg err"; $("userModalMsg").textContent = e.message; }
  finally{ $("saveUserBtn").disabled = false; }
};

async function resetUserPassword(email){
  if(!confirm(`Send a password-reset email to ${email}?`)) return;
  try{
    const r = await api("POST", `/api/users/${encodeURIComponent(email)}/reset-password`);
    alert(r.sent ? `Reset link sent to ${email}. They should check inbox and spam.`
                 : `Could not email a link (SMTP not configured). Set a password via Edit → save with a password instead.`);
  }catch(e){ alert(e.message); }
}
async function reactivateUser(email){
  const u = getUser(email);
  const name = prompt(`Reactivate ${email}.\nConfirm or update the person's name:`, u.name || "");
  if(name == null) return;
  const trimmed = name.trim();
  if(!trimmed){ alert("A name is required to reactivate."); return; }
  try{ await api("POST", `/api/users/${encodeURIComponent(email)}/reactivate`, { name: trimmed }); await loadUsers(); }
  catch(e){ alert(e.message); }
}
async function deleteUser(email){
  const u = getUser(email);
  const mine = allTasks.filter(t => (t.ownerEmail||"").toLowerCase() === email.toLowerCase()).length;
  const warn = `Delete ${u.name} (${email})?\n\n`
    + (mine ? `⚠ They still own ${mine} task(s) in your current view — consider "Reassign & remove" first.\n\n` : "")
    + `This removes their directory entry AND their login. This cannot be undone.`;
  if(!confirm(warn)) return;
  try{ await api("DELETE", `/api/users/${encodeURIComponent(email)}`); await loadUsers(); }
  catch(e){ alert(e.message); }
}

$("closeReassignModal").onclick = $("cancelReassignBtn").onclick = () => $("reassignOverlay").classList.add("hidden");
function openReassign(email){
  reassignFrom = email.toLowerCase();
  const from = getUser(reassignFrom);
  $("reassignMsg").textContent = "";
  $("reassignIntro").innerHTML =
    `All tasks owned by <b>${esc(from.name)}</b> will be moved to the person you pick, then `
    + `<b>${esc(from.name)}</b> will be marked <b>Inactive</b>.`;
  const targets = activeUsers().filter(u => u.email !== reassignFrom);
  $("r_target").innerHTML = targets.map(u => `<option value="${esc(u.email)}">${esc(u.name)}</option>`).join("");
  if(!targets.length) $("reassignMsg").textContent = "No other active user to receive the tasks. Add one first.";
  $("reassignOverlay").classList.remove("hidden");
}
$("confirmReassignBtn").onclick = async () => {
  const target = $("r_target").value.toLowerCase();
  if(!target){ $("reassignMsg").textContent = "Pick someone to receive the tasks."; return; }
  $("confirmReassignBtn").disabled = true;
  try{
    const r = await api("POST", `/api/users/${encodeURIComponent(reassignFrom)}/reassign`, { target });
    $("reassignOverlay").classList.add("hidden");
    await loadUsers(); await loadTasks();
    alert(`Moved ${r.moved} task(s) to ${r.targetName} and deactivated ${getUser(reassignFrom).name}.`);
  }catch(e){ $("reassignMsg").textContent = e.message; }
  finally{ $("confirmReassignBtn").disabled = false; }
};

/* ====================================================================== */
/* ---------- COLUMN FILTERS (Google-Sheets-style value pickers) ---------- */
/* ====================================================================== */
let filterPopEl = null;
function closeFilterPop(){
  if(filterPopEl){
    filterPopEl.remove(); filterPopEl = null;
    document.removeEventListener("mousedown", onFilterOutside, true);
  }
}
function onFilterOutside(e){
  if(filterPopEl && !filterPopEl.contains(e.target) &&
     !(e.target.closest && e.target.closest(".col-filter"))) closeFilterPop();
}
function openFilterPop(colKey, anchorEl){
  if(filterPopEl && filterPopEl.dataset.col === colKey){ closeFilterPop(); return; }
  closeFilterPop();

  let base = allTasks.slice();
  if(currentType !== "all") base = base.filter(r => (r.type||"") === currentType);
  const values = [...new Set(base.map(t => colText(colKey, t)))]
    .sort((a,b) => String(a).localeCompare(String(b)));

  const sel = colFilters[colKey];              // Set, or undefined = all selected
  const isChecked = v => !sel || sel.has(v);

  const pop = document.createElement("div");
  pop.className = "filter-pop";
  pop.dataset.col = colKey;
  pop.innerHTML =
      `<div class="fp-search"><input type="text" placeholder="Search values…" /></div>`
    + `<div class="fp-actions"><button data-all>Select all</button><button data-none>Clear</button></div>`
    + `<div class="fp-list">` + values.map((v,i) =>
        `<label><input type="checkbox" data-i="${i}" ${isChecked(v)?"checked":""}/> <span>${v===""?"(Blank)":esc(v)}</span></label>`
      ).join("") + `</div>`;
  document.body.appendChild(pop);
  filterPopEl = pop;

  const r = anchorEl.getBoundingClientRect(), w = 240;
  pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + "px";
  pop.style.top  = (r.bottom + 4) + "px";

  const apply = () => {
    const boxes = [...pop.querySelectorAll(".fp-list input[type=checkbox]")];
    const checkedVals = boxes.filter(b => b.checked).map(b => values[+b.dataset.i]);
    if(checkedVals.length === values.length) delete colFilters[colKey];
    else colFilters[colKey] = new Set(checkedVals);
    render();                                   // pop stays (it lives on <body>)
  };
  pop.querySelectorAll(".fp-list input[type=checkbox]").forEach(b => b.onchange = apply);
  pop.querySelector("[data-all]").onclick  = () => { pop.querySelectorAll(".fp-list input").forEach(b => b.checked = true);  apply(); };
  pop.querySelector("[data-none]").onclick = () => { pop.querySelectorAll(".fp-list input").forEach(b => b.checked = false); apply(); };
  const search = pop.querySelector(".fp-search input");
  search.oninput = () => {
    const q = search.value.trim().toLowerCase();
    pop.querySelectorAll(".fp-list label").forEach(l =>
      l.style.display = l.textContent.toLowerCase().includes(q) ? "flex" : "none");
  };
  setTimeout(() => document.addEventListener("mousedown", onFilterOutside, true), 0);
  search.focus();
}
window.addEventListener("keydown", e => { if(e.key === "Escape") closeFilterPop(); });
window.addEventListener("resize", closeFilterPop);

/* ====================================================================== */
/* ---------- LINKS TAB (shared links board at config/links) ---------- */
/* ====================================================================== */
function linksArray(){ return (linksConfig && Array.isArray(linksConfig.links)) ? linksConfig.links : []; }
function renderLinks(){
  const links = linksArray();
  // Shared board: everyone signed in can add / edit / delete links.
  $("addLinkBtn").classList.remove("hidden");
  $("linksEmpty").classList.toggle("hidden", links.length !== 0);
  $("linkList").innerHTML = links.map((l, i) => `
    <div class="link-row">
      <div class="lr-main">
        <a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(l.name || l.url)}</a>
        <span class="lr-url">${esc(l.url)}</span>
      </div>
      <div class="row-actions">
        <button class="icon-btn" data-ledit="${i}">Edit</button>
        <button class="icon-btn del" data-ldel="${i}">Delete</button>
      </div>
    </div>`).join("");
  $("linkList").querySelectorAll("[data-ledit]").forEach(b => b.onclick = () => openLinkModal(+b.dataset.ledit));
  $("linkList").querySelectorAll("[data-ldel]").forEach(b => b.onclick = () => deleteLink(+b.dataset.ldel));
}
$("addLinkBtn").onclick = () => openLinkModal(null);
$("closeLinkModal").onclick = $("cancelLinkBtn").onclick = () => $("linkOverlay").classList.add("hidden");
function openLinkModal(idx){
  editingLinkIdx = idx;
  const l = (idx != null) ? (linksArray()[idx] || {name:"",url:""}) : { name:"", url:"" };
  $("linkModalTitle").textContent = idx != null ? "Edit link" : "Add link";
  $("l_name").value = l.name || "";
  $("l_url").value  = l.url || "";
  $("linkModalMsg").textContent = "";
  $("linkOverlay").classList.remove("hidden");
  $("l_name").focus();
}
async function saveLinksBoard(links){ await api("PUT", "/api/config/links", { value: { links } }); linksConfig = { links }; }
$("saveLinkBtn").onclick = async () => {
  const name = $("l_name").value.trim();
  let url = $("l_url").value.trim();
  if(!name){ $("linkModalMsg").textContent = "Name is required."; return; }
  if(!url){ $("linkModalMsg").textContent = "URL is required."; return; }
  if(!/^https?:\/\//i.test(url)) url = "https://" + url;   // tolerate a pasted bare domain
  const links = linksArray().slice();
  if(editingLinkIdx != null) links[editingLinkIdx] = { name, url };
  else links.push({ name, url });
  $("saveLinkBtn").disabled = true;
  try{ await saveLinksBoard(links); $("linkOverlay").classList.add("hidden"); renderLinks(); }
  catch(e){ $("linkModalMsg").textContent = e.message; }
  finally{ $("saveLinkBtn").disabled = false; }
};
$("l_url").addEventListener("keydown", e => { if(e.key === "Enter") $("saveLinkBtn").click(); });
async function deleteLink(idx){
  const links = linksArray().slice();
  const l = links[idx]; if(!l) return;
  if(!confirm(`Remove the link "${l.name || l.url}"?`)) return;
  links.splice(idx, 1);
  try{ await saveLinksBoard(links); renderLinks(); }
  catch(e){ alert(e.message); }
}

/* ---------- Boot: resume an existing session if there is one ---------- */
(async function boot(){
  try{
    const { user } = await api("GET", "/api/me");
    me = user;
    await enterApp();
  }catch(_){
    $("login").classList.remove("hidden");
  }
})();
