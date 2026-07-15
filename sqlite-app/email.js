/* ======================================================================
   Email transport (nodemailer / SMTP). Mirrors the old sendMail Cloud
   Function. If SMTP env vars are not set, emailEnabled() is false and
   send() is a no-op that logs a warning — the app keeps working without email.
   ====================================================================== */
const nodemailer = require("nodemailer");

const {
  SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, SMTP_FROM,
} = process.env;

let transporter = null;
function emailEnabled() {
  return !!(SMTP_HOST && SMTP_USER && SMTP_PASSWORD);
}
function getTransporter() {
  if (!emailEnabled()) return null;
  if (!transporter) {
    const port = parseInt(SMTP_PORT || "465", 10);
    transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port,
      secure: port === 465,            // 465 = implicit SSL; 587 = STARTTLS
      auth: { user: SMTP_USER, pass: SMTP_PASSWORD },
    });
  }
  return transporter;
}

/* Send one email. Returns true on success, false on failure/misconfig. */
async function send(to, toName, subject, message, fromName) {
  if (!to) return false;
  const t = getTransporter();
  if (!t) {
    console.warn("[email] SMTP not configured — skipping email to", to);
    return false;
  }
  const from = SMTP_FROM || SMTP_USER;
  try {
    await t.sendMail({
      from: `"${fromName || "Team Task List"}" <${from}>`,
      to: toName ? `"${toName}" <${to}>` : to,
      subject: String(subject || "").slice(0, 300),
      text: String(message || "").slice(0, 20000),
    });
    return true;
  } catch (e) {
    console.error("[email] send failed for", to, e.message);
    return false;
  }
}

module.exports = { emailEnabled, send };
