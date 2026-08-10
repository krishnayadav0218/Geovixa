const nodemailer = require('nodemailer');

// Email notifications (company welcome email, leave/grievance/salary-slip status updates)
// are entirely OPTIONAL — this whole file is designed to work fine with zero setup. If SMTP_*
// env vars aren't set, every send*Email() call below just logs to the console and returns
// instead of throwing, so nothing else in the app ever breaks because email isn't configured.
//
// To enable real emails, set in .env:
//   SMTP_HOST=smtp.your-provider.com
//   SMTP_PORT=587
//   SMTP_USER=you@yourdomain.com
//   SMTP_PASS=your-smtp-password
//   FROM_EMAIL=noreply@yourdomain.com
//   FROM_NAME=Geovixa
// Works with any standard SMTP provider (Gmail App Passwords, SendGrid, Mailgun, Amazon SES,
// your own mail server, etc.) — nothing here is tied to a specific provider.

let transporter = null;
let configChecked = false;

function isConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function getTransporter() {
  if (!isConfigured()) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  return transporter;
}

// Sends one email. Resolves (never rejects) either way — a failed/unsent email should never
// break the request that triggered it (e.g. approving a leave application shouldn't fail
// just because the notification email bounced).
async function sendMail(to, subject, html) {
  if (!configChecked) {
    configChecked = true;
    if (!isConfigured()) {
      console.log('ℹ️  Email notifications are OFF (SMTP_HOST/SMTP_USER/SMTP_PASS not set in .env) — this is optional, everything else works fine without it.');
    }
  }
  if (!to || !isConfigured()) return { sent: false, reason: !to ? 'no recipient' : 'SMTP not configured' };

  try {
    const fromName = process.env.FROM_NAME || 'Geovixa';
    const fromEmail = process.env.FROM_EMAIL || process.env.SMTP_USER;
    await getTransporter().sendMail({ from: `"${fromName}" <${fromEmail}>`, to, subject, html });
    return { sent: true };
  } catch (err) {
    console.warn(`Email send failed (to ${to}, subject "${subject}"):`, err.message);
    return { sent: false, reason: err.message };
  }
}

function emailWrapper(bodyHtml) {
  return `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#0F1720;">
      <div style="background:#071A2C;padding:20px;border-radius:10px 10px 0 0;">
        <span style="color:#fff;font-size:20px;font-weight:700;">Geovixa</span>
      </div>
      <div style="border:1px solid #E3E8EF;border-top:none;border-radius:0 0 10px 10px;padding:24px;">
        ${bodyHtml}
      </div>
      <p style="color:#94A3B8;font-size:11px;margin-top:16px;">This is an automated message, please do not reply directly to this email.</p>
    </div>
  `;
}

// Sent to a new company's contact email right after the super_admin creates it — gives them
// their Company Code and where to log in. Deliberately does NOT include the Admin password
// (that was already shown once in the portal to whoever created the account, and emailing a
// plaintext password is bad practice) — only the Company Code + username + login pointer.
async function sendCompanyWelcomeEmail({ to, companyName, companyCode, adminUsername, portalUrl }) {
  const html = emailWrapper(`
    <h2 style="margin-top:0;">Welcome to Geovixa, ${escapeHtmlLite(companyName)}!</h2>
    <p>Your company's attendance &amp; workforce portal is ready. Here's what you need to log in:</p>
    <table style="width:100%;border-collapse:collapse;margin:16px 0;">
      <tr><td style="padding:8px 0;color:#64748B;">Company Code</td><td style="padding:8px 0;font-weight:700;">${escapeHtmlLite(companyCode)}</td></tr>
      <tr><td style="padding:8px 0;color:#64748B;">Admin Username</td><td style="padding:8px 0;font-weight:700;">${escapeHtmlLite(adminUsername)}</td></tr>
    </table>
    <p>Your password was set when this account was created — if you don't have it, ask whoever set up your account to reset it for you.</p>
    ${portalUrl ? `<p><a href="${portalUrl}" style="display:inline-block;background:#0B93D6;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:600;">Go to Portal</a></p>` : ''}
  `);
  return sendMail(to, `Welcome to Geovixa — ${companyName}`, html);
}

// Sent to an employee (if they have an email on file) when their Leave / Grievance / Salary
// Slip request is approved or rejected — a lightweight status-update notification.
async function sendRequestStatusEmail({ to, employeeName, requestType, status, extra }) {
  if (!to) return { sent: false, reason: 'no recipient' };
  const statusColor = status === 'approved' ? '#2E7D32' : status === 'rejected' ? '#C62828' : '#0B93D6';
  const html = emailWrapper(`
    <h2 style="margin-top:0;">Hi ${escapeHtmlLite(employeeName)},</h2>
    <p>Your <b>${escapeHtmlLite(requestType)}</b> request has been
      <span style="color:${statusColor};font-weight:700;text-transform:capitalize;">${escapeHtmlLite(status)}</span>.
    </p>
    ${extra ? `<p style="color:#64748B;">${escapeHtmlLite(extra)}</p>` : ''}
    <p>Log in to your Geovixa employee portal for more details.</p>
  `);
  return sendMail(to, `${requestType} ${status} — Geovixa`, html);
}

function escapeHtmlLite(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

module.exports = { sendMail, sendCompanyWelcomeEmail, sendRequestStatusEmail, isConfigured };
